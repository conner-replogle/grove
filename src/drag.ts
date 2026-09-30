// Drag and drop in the sidebar. A press on a tab, an Essential or a folder
// header becomes a drag once the pointer moves a few pixels; the drop asks
// the host to move the entry (or the whole folder), and every window on the
// workspace redraws from the host's model.
//
// Rows carry what the drop needs to know:
//   data-kind   'essential' | 'tab' | 'folder' | 'top' (above the tab list)
//   data-entry  the entry id (tabs and Essentials)
//   data-group  the folder id (folder headers, and tabs inside a folder)
import type { EntryView, HostCommand, WindowState } from '../shared/protocol.ts'
import { send } from './host-client'

type Source = { entryId: string } | { groupId: string }
type Where = 'before' | 'after' | 'into'

interface Target {
  command: HostCommand
  node: HTMLElement
  where: Where
}

const THRESHOLD = 4
const EDGE = 28

interface DragHost extends HTMLElement {
  dragEnded(): void
}

export class Dragger {
  private readonly host: DragHost
  private readonly root: ShadowRoot
  private readonly state: () => WindowState | undefined
  private press_?: { source: Source; x: number; y: number; pointerId: number }
  private ghost?: HTMLElement
  private grab = { x: 0, y: 0 }
  private indicator?: HTMLElement
  private target?: Target
  private dragged?: HTMLElement
  private scrollSpeed = 0
  private zone?: HTMLElement
  active = false

  constructor(host: DragHost, root: ShadowRoot, state: () => WindowState | undefined) {
    this.host = host
    this.root = root
    this.state = state
    host.addEventListener('pointermove', (e) => this.move(e))
    host.addEventListener('pointerup', (e) => this.end(e, true))
    host.addEventListener('pointercancel', (e) => this.end(e, false))
    host.addEventListener('lostpointercapture', (e) => this.end(e, false))
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.active) this.finish(false)
    })
    // Favicons are <img>s, which the browser would drag natively (and
    // cancel this drag).
    root.addEventListener('dragstart', (e) => e.preventDefault())
    // The click that ends a drag isn't a click on the folder under it.
    root.addEventListener(
      'click',
      (e) => {
        if (this.swallowClick) {
          this.swallowClick = false
          e.stopPropagation()
          e.preventDefault()
        }
      },
      true
    )
  }

  private swallowClick = false

  press(e: PointerEvent, source: Source): void {
    if (e.button !== 0 || this.active) return
    this.press_ = { source, x: e.clientX, y: e.clientY, pointerId: e.pointerId }
    this.swallowClick = false
  }

  private move(e: PointerEvent): void {
    const p = this.press_
    if (!p || e.pointerId !== p.pointerId) return
    if (!this.active) {
      if ((e.buttons & 1) === 0) {
        this.press_ = undefined
        return
      }
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < THRESHOLD) return
      if (!this.begin(p.source, p.x, p.y)) {
        this.press_ = undefined
        return
      }
      this.host.setPointerCapture(e.pointerId)
    }
    this.ghost!.style.translate = `${e.clientX - this.grab.x}px ${e.clientY - this.grab.y}px`
    this.toggleZone(e.clientY)
    this.target = this.targetAt(e.clientX, e.clientY)
    this.showIndicator()
    this.autoScroll(e.clientY)
  }

  private begin(source: Source, x: number, y: number): boolean {
    const node = this.sourceNode(source)
    if (!node) return false
    this.active = true
    this.dragged = node
    const box = node.getBoundingClientRect()
    this.grab = { x: x - box.left, y: y - box.top }
    const ghost = node.cloneNode(true) as HTMLElement
    ghost.classList.add('drag-ghost')
    ghost.style.width = `${box.width}px`
    ghost.style.height = `${box.height}px`
    ghost.style.translate = `${box.left}px ${box.top}px`
    this.ghost = ghost
    this.indicator = document.createElement('div')
    this.indicator.className = 'drop-indicator'
    this.root.append(ghost, this.indicator)
    node.classList.add('dragging')
    this.host.classList.add('drag-active')
    // With nothing pinned yet there's no Essentials grid to drop on: add an
    // empty one at the top, which opens when the pointer heads up there.
    const scroll = this.root.querySelector('.scroll')
    if ('entryId' in source && scroll && !this.root.querySelector('.essentials')) {
      const zone = document.createElement('div')
      zone.className = 'essentials empty-zone'
      zone.textContent = 'Drop to pin'
      scroll.prepend(zone)
      this.zone = zone
    }
    return true
  }

  private end(e: PointerEvent, drop: boolean): void {
    if (this.press_ && e.pointerId !== this.press_.pointerId) return
    if (!this.active) {
      this.press_ = undefined
      return
    }
    if (drop && this.target) this.target = this.targetAt(e.clientX, e.clientY)
    this.finish(drop)
  }

  private finish(drop: boolean): void {
    const target = this.target
    const pointerId = this.press_?.pointerId
    this.press_ = undefined
    this.active = false
    this.target = undefined
    this.scrollSpeed = 0
    this.ghost?.remove()
    this.zone?.remove()
    this.zone = undefined
    this.indicator?.remove()
    this.dragged?.classList.remove('dragging')
    this.root.querySelectorAll('.drop-into').forEach((n) => n.classList.remove('drop-into'))
    this.host.classList.remove('drag-active')
    this.ghost = this.indicator = this.dragged = undefined
    this.swallowClick = true
    setTimeout(() => (this.swallowClick = false), 0)
    if (pointerId !== undefined && this.host.hasPointerCapture(pointerId)) this.host.releasePointerCapture(pointerId)
    if (drop && target) send(target.command)
    this.host.dragEnded()
  }

  private sourceNode(source: Source): HTMLElement | null {
    return 'entryId' in source
      ? this.root.querySelector(`[data-entry="${CSS.escape(source.entryId)}"]`)
      : this.root.querySelector(`[data-kind="folder"][data-group="${CSS.escape(source.groupId)}"]`)
  }

  // ---- Where a drop at (x, y) lands ----

  private targetAt(x: number, y: number): Target | undefined {
    const s = this.state()
    const source = this.press_?.source
    if (!s || !source) return undefined
    const box = this.host.getBoundingClientRect()
    if (x < box.left || x > box.right || y < box.top || y > box.bottom) return undefined
    const hit = this.root.elementFromPoint(x, y)
    const node = hit?.closest<HTMLElement>('[data-kind]') ?? null
    const scroll = this.root.querySelector<HTMLElement>('.scroll')
    const entries = s.workspace.entries
    const unpinned = entries.filter((e) => !e.pinned)

    if ('groupId' in source) return this.folderTarget(source.groupId, node, y, unpinned, scroll, hit)

    const entryId = source.entryId
    const move = (where: Where, n: HTMLElement, rest: Omit<Extract<HostCommand, { type: 'moveEntry' }>, 'type' | 'entryId'>): Target => ({
      node: n,
      where,
      command: { type: 'moveEntry', entryId, ...rest }
    })

    if (!node) {
      // Empty space: below the list, or the Essentials grid's gaps.
      const grid = hit?.closest<HTMLElement>('.essentials')
      if (grid) return move('into', grid, { pinned: true })
      if (hit === scroll || hit === this.host) {
        const last = [...this.root.querySelectorAll<HTMLElement>('.scroll > [data-kind="tab"], .scroll > .folder')].at(-1)
        return last ? move('after', last, { pinned: false }) : undefined
      }
      return undefined
    }
    const r = node.getBoundingClientRect()
    switch (node.dataset.kind) {
      case 'essential': {
        const id = node.dataset.entry!
        if (id === entryId) return undefined
        const pinned = entries.filter((e) => e.pinned)
        const before = x < r.left + r.width / 2
        const beforeId = before ? id : next(pinned, id, entryId)
        return move(before ? 'before' : 'after', node, { pinned: true, beforeId })
      }
      case 'tab': {
        const id = node.dataset.entry!
        if (id === entryId) return undefined
        const groupId = node.dataset.group
        const before = y < r.top + r.height / 2
        const section = groupId ? unpinned.filter((e) => e.groupId === groupId) : unpinned
        const beforeId = before ? id : groupId ? next(section, id, entryId) : nextTopLevel(unpinned, id, entryId)
        return move(before ? 'before' : 'after', node, { pinned: false, groupId, beforeId })
      }
      case 'folder': {
        const groupId = node.dataset.group!
        const members = unpinned.filter((e) => e.groupId === groupId)
        if (y < r.top + r.height * 0.3) {
          const beforeId = members.find((m) => m.id !== entryId)?.id ?? nextTopLevel(unpinned, members[0]?.id, entryId)
          return move('before', node.parentElement!, { pinned: false, beforeId })
        }
        return move('into', node, { pinned: false, groupId })
      }
      case 'top':
        return move('before', this.firstListItem() ?? node, {
          pinned: false,
          beforeId: unpinned.find((e) => e.id !== entryId)?.id
        })
    }
    return undefined
  }

  private folderTarget(
    groupId: string,
    node: HTMLElement | null,
    y: number,
    unpinned: EntryView[],
    scroll: HTMLElement | null,
    hit: Element | null
  ): Target | undefined {
    const move = (where: Where, n: HTMLElement, beforeId?: string): Target => ({
      node: n,
      where,
      command: { type: 'moveFolder', groupId, beforeId }
    })
    if (!node) {
      if (hit !== scroll && hit !== this.host) return undefined
      const last = [...this.root.querySelectorAll<HTMLElement>('.scroll > [data-kind="tab"], .scroll > .folder')].at(-1)
      return last ? move('after', last) : undefined
    }
    if (node.dataset.kind === 'top') {
      return move('before', this.firstListItem() ?? node, unpinned[0]?.id)
    }
    if (node.dataset.kind !== 'tab' && node.dataset.kind !== 'folder') return undefined
    // Inside a folder, the anchor is the folder as a whole.
    const anchorGroup = node.dataset.group
    const anchor = anchorGroup ? (node.closest<HTMLElement>('.folder') ?? node) : node
    if (anchorGroup === groupId) return undefined
    const r = anchor.getBoundingClientRect()
    const before = y < r.top + r.height / 2
    const firstId = anchorGroup ? unpinned.find((e) => e.groupId === anchorGroup)?.id : node.dataset.entry
    if (before) return move('before', anchor, firstId)
    const lastId = anchorGroup ? unpinned.findLast((e) => e.groupId === anchorGroup)?.id : node.dataset.entry
    return move('after', anchor, lastId && nextTopLevel(unpinned, lastId, undefined, groupId))
  }

  // The pin zone is open while the pointer is above the middle of the
  // workspace name (which the open zone pushes down, so it stays open
  // until the pointer moves onto the list).
  private toggleZone(y: number): void {
    const name = this.zone && this.root.querySelector('.workspace-indicator')
    if (!name) return
    const r = name.getBoundingClientRect()
    this.zone!.classList.toggle('open', y < r.top + r.height / 2)
  }

  private firstListItem(): HTMLElement | null {
    return this.root.querySelector<HTMLElement>('.scroll > [data-kind="tab"], .scroll > .folder')
  }

  // ---- Feedback ----

  private showIndicator(): void {
    const ind = this.indicator!
    this.root.querySelectorAll('.drop-into').forEach((n) => n.classList.remove('drop-into'))
    const t = this.target
    if (!t) {
      ind.hidden = true
      return
    }
    if (t.where === 'into') {
      ind.hidden = true
      t.node.classList.add('drop-into')
      return
    }
    ind.hidden = false
    const host = this.host.getBoundingClientRect()
    const r = t.node.getBoundingClientRect()
    const vertical = t.node.dataset.kind === 'essential'
    ind.classList.toggle('vertical', vertical)
    if (vertical) {
      const x = t.where === 'before' ? r.left - 2 : r.right + 2
      ind.style.cssText = `left:${x - host.left - 1}px;top:${r.top - host.top}px;height:${r.height}px;width:2px`
    } else {
      const y = t.where === 'before' ? r.top - 1 : r.bottom + 1
      ind.style.cssText = `left:${r.left - host.left + 4}px;top:${y - host.top - 1}px;width:${r.width - 8}px;height:2px`
    }
  }

  private autoScroll(y: number): void {
    const scroll = this.root.querySelector<HTMLElement>('.scroll')
    if (!scroll) return
    const r = scroll.getBoundingClientRect()
    const speed = y < r.top + EDGE ? -1 : y > r.bottom - EDGE ? 1 : 0
    const was = this.scrollSpeed
    this.scrollSpeed = speed
    if (speed && !was) {
      const step = (): void => {
        if (!this.active || !this.scrollSpeed) return
        scroll.scrollTop += this.scrollSpeed * 6
        requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    }
  }
}

// The entry after `id` in `list`, skipping the dragged one.
function next(list: EntryView[], id: string, skip: string | undefined): string | undefined {
  const i = list.findIndex((e) => e.id === id)
  return list.slice(i + 1).find((e) => e.id !== skip)?.id
}

// The first entry of the top-level item after `id` (a loose tab, or a
// folder's first tab), skipping the dragged entry or folder.
function nextTopLevel(
  unpinned: EntryView[],
  id: string,
  skip: string | undefined,
  skipGroup?: string
): string | undefined {
  const i = unpinned.findIndex((e) => e.id === id)
  const own = unpinned[i]?.groupId
  return unpinned
    .slice(i + 1)
    .find((e) => e.id !== skip && (!own || e.groupId !== own) && (!skipGroup || e.groupId !== skipGroup))?.id
}
