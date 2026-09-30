// <grove-sidebar>: the window's workspace, drawn from the Grove host's
// shared model. Every window on a workspace shows the same entries; a click
// asks the host to show that entry here, which moves its page over if it is
// open in another window. Pinned entries are the Essentials grid; folders
// are Grove's own (Chrome's tab groups only live inside one window).
import type { EntryView, WindowState } from '../shared/protocol.ts'
import type { Color, Group } from '../shared/types.ts'
import { Dragger } from './drag'
import { send, subscribe } from './host-client'
import { icons } from './icons'
import sidebarCss from './styles/sidebar.css'
import { svg } from './svg'
import folderSvg from './zen/folder-icon.svg'
import zenTokens from './zen/tokens.css'

const COLOR_HEX: Record<Color, string> = {
  green: '#4caf6e',
  blue: '#4a8fe0',
  purple: '#9a6ce0',
  pink: '#e06ca8',
  red: '#e05a5a',
  orange: '#e8914a',
  yellow: '#d6b43c',
  gray: '#8e8e93'
}

const faviconFor = (url: string): string =>
  `chrome://favicon2/?size=16&scaleFactor=1x&allowGoogleServerFallback=0&pageUrl=${encodeURIComponent(url)}`

class GroveSidebar extends HTMLElement {
  private readonly root = this.attachShadow({ mode: 'open' })
  private state?: WindowState
  private menu?: HTMLElement
  private readonly drag = new Dragger(this, this.root, () => this.state)
  // A render that arrived while a drag was under way (it would pull the
  // dragged row out from under the pointer).
  private renderQueued = false

  connectedCallback(): void {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(zenTokens + sidebarCss)
    this.root.adoptedStyleSheets = [sheet]
    subscribe((s) => {
      this.state = s
      this.render()
    })
    document.addEventListener(
      'mousedown',
      (ev) => {
        if (!this.menu || !ev.composedPath().includes(this.menu)) this.closeMenu()
      },
      true
    )
  }

  private render(): void {
    const s = this.state
    if (!s) return
    if (this.drag.active) {
      this.renderQueued = true
      return
    }
    this.renderQueued = false
    const ws = s.workspace
    const scroll = el('div', 'scroll')

    const pinned = ws.entries.filter((e) => e.pinned)
    if (pinned.length) {
      const grid = el('div', 'essentials')
      grid.dataset.count = String(pinned.length)
      for (const e of pinned) grid.append(this.essential(e, s))
      scroll.append(grid)
    }

    const indicator = el('div', 'workspace-indicator')
    indicator.dataset.kind = 'top'
    indicator.style.setProperty('--ws-color', COLOR_HEX[ws.color])
    indicator.append(iconEl('icon', icons.leaf), el('span', 'name', ws.name))
    scroll.append(indicator)

    const newTab = el('button', 'new-tab')
    newTab.dataset.kind = 'top'
    newTab.append(iconEl('favicon icon', icons.plus), el('span', 'label', 'New Tab'))
    newTab.addEventListener('click', () => send({ type: 'newTab' }))
    scroll.append(newTab)

    const unpinned = ws.entries.filter((e) => !e.pinned)
    const seen = new Set<string>()
    for (const e of unpinned) {
      if (!e.groupId) scroll.append(this.tabRow(e, s))
      else if (!seen.has(e.groupId)) {
        seen.add(e.groupId)
        const group = ws.groups.find((g) => g.id === e.groupId)
        if (group) scroll.append(this.folder(group, unpinned.filter((x) => x.groupId === e.groupId), s))
      }
    }

    this.root.replaceChildren(scroll, this.foot(s))
    if (this.menu) this.root.append(this.menu)
  }

  // Called by the dragger when a drag ends.
  dragEnded(): void {
    if (this.renderQueued) this.render()
  }

  private essential(e: EntryView, s: WindowState): HTMLElement {
    const tile = el('div', `essential${e.id === s.activeEntryId ? ' selected' : ''}${e.live ? '' : ' frozen'}`)
    tile.title = e.title
    tile.style.setProperty('--favicon', `url("${faviconFor(e.url)}")`)
    tile.append(favicon(e))
    tile.dataset.kind = 'essential'
    this.wire(tile, e)
    return tile
  }

  private tabRow(e: EntryView, s: WindowState): HTMLElement {
    const row = el('div', `tab${e.id === s.activeEntryId ? ' selected' : ''}${e.live ? '' : ' frozen'}`)
    row.title = `${e.title}\n${e.url}`
    row.append(favicon(e), el('span', 'label', e.title || e.url || 'New Tab'))
    const close = el('button', 'close')
    close.title = 'Close tab'
    close.append(svg(icons.x))
    close.addEventListener('mousedown', (ev) => ev.stopPropagation())
    close.addEventListener('pointerdown', (ev) => ev.stopPropagation())
    close.addEventListener('click', (ev) => {
      ev.stopPropagation()
      send({ type: 'close', entryId: e.id })
    })
    row.append(close)
    row.dataset.kind = 'tab'
    if (e.groupId) row.dataset.group = e.groupId
    this.wire(row, e)
    return row
  }

  private folder(group: Group, members: EntryView[], s: WindowState): HTMLElement {
    const hasSelected = members.some((m) => m.id === s.activeEntryId)
    const box = el('div', `folder${group.collapsed ? ' collapsed' : ''}${hasSelected ? ' has-selected' : ''}`)
    box.style.setProperty('--folder-accent', COLOR_HEX[group.color])
    const head = el('div', 'folder-header')
    head.append(iconEl('folder-icon', folderSvg), el('span', 'label', group.title || 'Folder'))
    head.dataset.kind = 'folder'
    head.dataset.group = group.id
    head.addEventListener('pointerdown', (ev) => this.drag.press(ev, { groupId: group.id }))
    head.addEventListener('click', () => send({ type: 'toggleFolder', groupId: group.id }))
    head.addEventListener('contextmenu', (ev) => {
      ev.preventDefault()
      this.openMenu(ev, [['Ungroup', () => send({ type: 'ungroup', groupId: group.id })]])
    })
    box.append(head)
    const shown = group.collapsed ? members.filter((m) => m.id === s.activeEntryId) : members
    if (shown.length) {
      const children = el('div', 'folder-tabs')
      for (const m of shown) children.append(this.tabRow(m, s))
      box.append(children)
    }
    return box
  }

  private foot(s: WindowState): HTMLElement {
    const foot = el('div', 'foot')
    const switcher = el('div', 'workspace-switcher')
    for (const w of s.workspaces) {
      const b = el('button', w.id === s.workspace.id ? 'active' : '')
      b.title = w.name
      b.style.color = w.id === s.workspace.id ? COLOR_HEX[w.color] : ''
      b.append(svg(icons.leaf))
      b.addEventListener('click', () => send({ type: 'switchWorkspace', workspaceId: w.id }))
      switcher.append(b)
    }
    const add = el('button', 'tbtn')
    add.title = 'New workspace'
    add.append(svg(icons.plus))
    add.addEventListener('click', () => send({ type: 'newWorkspace' }))
    foot.append(el('span', 'tbtn-spacer'), switcher, add)
    return foot
  }

  private wire(node: HTMLElement, e: EntryView): void {
    node.dataset.entry = e.id
    node.addEventListener('mousedown', (ev) => {
      if (ev.button === 0) send({ type: 'activate', entryId: e.id })
    })
    node.addEventListener('pointerdown', (ev) => this.drag.press(ev, { entryId: e.id }))
    node.addEventListener('auxclick', (ev) => {
      if (ev.button === 1) send({ type: 'close', entryId: e.id })
    })
    node.addEventListener('contextmenu', (ev) => {
      ev.preventDefault()
      this.openMenu(ev, [
        [e.pinned ? 'Unpin' : 'Pin', () => send({ type: 'setPinned', entryId: e.id, pinned: !e.pinned })],
        ['Add to new folder', () => send({ type: 'newFolder', entryId: e.id })],
        ['Close', () => send({ type: 'close', entryId: e.id })]
      ])
    })
  }

  // A small Grove menu for Grove's own model (pins and folders are shared
  // across windows, so Chrome's per-window tab menu can't manage them).
  private openMenu(ev: MouseEvent, items: [string, () => void][]): void {
    this.closeMenu()
    const menu = el('div', 'menu')
    for (const [label, run] of items) {
      const item = el('button', 'menu-item', label)
      item.addEventListener('mousedown', (e) => e.stopPropagation())
      item.addEventListener('click', () => {
        this.closeMenu()
        run()
      })
      menu.append(item)
    }
    const box = this.getBoundingClientRect()
    menu.style.left = `${Math.max(0, Math.min(ev.clientX - box.left, box.width - 170))}px`
    menu.style.top = `${ev.clientY - box.top}px`
    menu.addEventListener('mousedown', (e) => e.stopPropagation())
    this.menu = menu
    this.root.append(menu)
  }

  private closeMenu(): void {
    this.menu?.remove()
    this.menu = undefined
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

function iconEl(cls: string, markup: string): HTMLElement {
  const span = el('span', cls)
  span.append(svg(markup))
  return span
}

function favicon(e: EntryView): HTMLElement {
  if (e.loading) return el('span', 'favicon loading')
  // A blank tab is a page like any other: a globe, never the + of the
  // New Tab button.
  if (!e.url || e.url.startsWith('chrome://newtab')) return iconEl('favicon icon blank-page', icons.globe)
  const img = el('img', 'favicon')
  img.src = faviconFor(e.url)
  img.alt = ''
  img.draggable = false
  return img
}

customElements.define('grove-sidebar', GroveSidebar)
