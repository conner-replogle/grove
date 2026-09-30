// Drag and drop in the sidebar. A press on a tab, an Essential, a folder
// header or a workspace icon becomes a drag once the pointer moves a few
// pixels; the drop asks the host to move it, and every window redraws from
// the host's model.
//
// Rows carry what the drop needs to know:
//   data-kind     'essential' | 'tab' | 'folder' | 'workspace'
//                 | 'pins-start' (the workspace name: the top of its pins)
//                 | 'tabs-start' (the separator and New Tab: the top of its tabs)
//   data-entry    the entry id (tabs and Essentials)
//   data-section  'pinned' | 'tabs' (tabs, folders and folder headers)
//   data-group    the folder id (folder headers, and tabs inside a folder)
//   data-workspace  the workspace id (workspace icons)
import type { EntryView, HostCommand, WindowState } from '../shared/protocol.ts'
import { send } from './host-client'

type Source = { entryId: string } | { groupId: string } | { workspaceId: string }
type MoveEntry = Extract<HostCommand, { type: 'moveEntry' }>
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
      try {
        this.host.setPointerCapture(e.pointerId)
      } catch {
        // A pointer the browser doesn't track (synthetic events): no capture.
      }
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
      zone.textContent = 'Add to Essentials'
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
    if ('entryId' in source) return this.root.querySelector(`[data-entry="${CSS.escape(source.entryId)}"]`)
    if ('groupId' in source) return this.root.querySelector(`[data-kind="folder"][data-group="${CSS.escape(source.groupId)}"]`)
    return this.root.querySelector(`[data-kind="workspace"][data-workspace="${CSS.escape(source.workspaceId)}"]`)
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
    if ('workspaceId' in source) return this.workspaceTarget(source.workspaceId, node, x, s)
    if ('groupId' in source) return this.folderTarget(source.groupId, node, y, s, hit)
    return this.entryTarget(source.entryId, node, x, y, s, hit)
  }

  private entryTarget(
    entryId: string,
    node: HTMLElement | null,
    x: number,
    y: number,
    s: WindowState,
    hit: Element | null
  ): Target | undefined {
    const entries = s.workspace.entries
    const pinned = entries.filter((e) => e.pinned)
    const tabs = entries.filter((e) => !e.pinned)
    const move = (where: Where, n: HTMLElement, drop: Omit<MoveEntry, 'type' | 'entryId'>): Target => ({
      node: n,
      where,
      command: { type: 'moveEntry', entryId, ...drop }
    })
    const firstOther = (list: EntryView[]): string | undefined => list.find((e) => e.id !== entryId)?.id

    if (!node) {
      // Empty space: the Essentials grid's gaps, or below the list.
      const grid = hit?.closest<HTMLElement>('.essentials')
      if (grid) return move('into', grid, { section: 'essentials' })
      if (hit === this.root.querySelector('.scroll') || hit === this.host) {
        const last = this.lastListItem()
        return last ? move('after', last, { section: 'tabs' }) : undefined
      }
      return undefined
    }
    const r = node.getBoundingClientRect()
    switch (node.dataset.kind) {
      case 'essential': {
        const id = node.dataset.entry!
        if (id === entryId) return undefined
        const before = x < r.left + r.width / 2
        const beforeId = before ? id : next(s.essentials, id, entryId)
        return move(before ? 'before' : 'after', node, { section: 'essentials', beforeId })
      }
      case 'tab': {
        const id = node.dataset.entry!
        if (id === entryId) return undefined
        const section = node.dataset.section === 'pinned' ? 'pinned' : 'tabs'
        const list = section === 'pinned' ? pinned : tabs
        const groupId = node.dataset.group
        const before = y < r.top + r.height / 2
        let beforeId: string | undefined = id
        if (!before) {
          if (groupId) beforeId = next(list.filter((e) => e.groupId === groupId), id, entryId)
          else beforeId = nextTopLevel(list, id, entryId)
        }
        return move(before ? 'before' : 'after', node, { section, groupId, beforeId })
      }
      case 'folder': {
        const groupId = node.dataset.group!
        const section = node.dataset.section === 'pinned' ? 'pinned' : 'tabs'
        const list = section === 'pinned' ? pinned : tabs
        const members = list.filter((e) => e.groupId === groupId)
        if (y < r.top + r.height * 0.3) {
          const beforeId = firstOther(members) ?? nextTopLevel(list, members[0]?.id, entryId)
          return move('before', node.parentElement!, { section, beforeId })
        }
        return move('into', node, { section, groupId })
      }
      case 'pins-start':
        return move('after', node, { section: 'pinned', beforeId: firstOther(pinned) })
      case 'tabs-start':
        return move('after', node, { section: 'tabs', beforeId: firstOther(tabs) })
      case 'workspace': {
        const workspaceId = node.dataset.workspace!
        if (workspaceId === s.workspace.id) return undefined
        return { node, where: 'into', command: { type: 'moveToWorkspace', entryId, workspaceId } }
      }
    }
    return undefined
  }

  private workspaceTarget(workspaceId: string, node: HTMLElement | null, x: number, s: WindowState): Target | undefined {
    if (node?.dataset.kind !== 'workspace') return undefined
    const id = node.dataset.workspace!
    if (id === workspaceId) return undefined
    const r = node.getBoundingClientRect()
    const before = x < r.left + r.width / 2
    const ids = s.workspaces.map((w) => w.id)
    const beforeId = before ? id : ids.slice(ids.indexOf(id) + 1).find((w) => w !== workspaceId)
    return { node, where: before ? 'before' : 'after', command: { type: 'moveWorkspace', workspaceId, beforeId } }
  }

  private folderTarget(
    groupId: string,
    node: HTMLElement | null,
    y: number,
    s: WindowState,
    hit: Element | null
  ): Target | undefined {
    const section = (pinned: boolean): EntryView[] =>
      s.workspace.entries.filter((e) => e.pinned === pinned && e.groupId !== groupId)
    const move = (where: Where, n: HTMLElement, pinned: boolean, beforeId?: string): Target => ({
      node: n,
      where,
      command: { type: 'moveFolder', groupId, beforeId, pinned }
    })
    if (!node) {
      if (hit !== this.root.querySelector('.scroll') && hit !== this.host) return undefined
      const last = this.lastListItem()
      return last ? move('after', last, false) : undefined
    }
    if (node.dataset.kind === 'pins-start') return move('after', node, true, section(true)[0]?.id)
    if (node.dataset.kind === 'tabs-start') return move('after', node, false, section(false)[0]?.id)
    if (node.dataset.kind !== 'tab' && node.dataset.kind !== 'folder') return undefined
    const pinned = node.dataset.section === 'pinned'
    const list = section(pinned)
    // Inside a folder, the anchor is the folder as a whole.
    const anchorGroup = node.dataset.group
    const anchor = anchorGroup ? (node.closest<HTMLElement>('.folder') ?? node) : node
    if (anchorGroup === groupId) return undefined
    const r = anchor.getBoundingClientRect()
    const before = y < r.top + r.height / 2
    const firstId = anchorGroup ? list.find((e) => e.groupId === anchorGroup)?.id : node.dataset.entry
    if (before) return move('before', anchor, pinned, firstId)
    const lastId = anchorGroup ? list.findLast((e) => e.groupId === anchorGroup)?.id : node.dataset.entry
    return move('after', anchor, pinned, lastId && nextTopLevel(list, lastId, undefined, groupId))
  }

  // The Essentials zone is open while the pointer is above the middle of
  // the workspace name (which the open zone pushes down, so it stays open
  // until the pointer moves onto the list).
  private toggleZone(y: number): void {
    const name = this.zone && this.root.querySelector('.workspace-indicator')
    if (!name) return
    const r = name.getBoundingClientRect()
    this.zone!.classList.toggle('open', y < r.top + r.height / 2)
  }

  private lastListItem(): HTMLElement | undefined {
    const items = this.root.querySelectorAll<HTMLElement>('.scroll > [data-section="tabs"], .scroll > .new-tab')
    return [...items].at(-1)
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
    const vertical = t.node.dataset.kind === 'essential' || t.node.dataset.kind === 'workspace'
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
// folder's first tab) in one section, skipping the dragged entry or folder.
function nextTopLevel(
  list: EntryView[],
  id: string,
  skip: string | undefined,
  skipGroup?: string
): string | undefined {
  const i = list.findIndex((e) => e.id === id)
  const own = list[i]?.groupId
  return list
    .slice(i + 1)
    .find((e) => e.id !== skip && (!own || e.groupId !== own) && (!skipGroup || e.groupId !== skipGroup))?.id
}
