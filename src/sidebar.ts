// <grove-sidebar>: the window's workspace, drawn from the Grove host's
// shared model. Every window on a workspace shows the same entries; a click
// asks the host to show that entry here, which moves its page over if it is
// open in another window.
//
// Top to bottom, as in Zen: the Essentials grid (shared by every
// workspace), the workspace's name, its pinned tabs and folders, a
// separator, New Tab and its other tabs and folders (Grove's own: Chrome's
// tab groups only live inside one window). The workspace icons sit at the
// bottom.
import type { EntryView, WindowState, WorkspaceSummary } from '../shared/protocol.ts'
import { COLORS, MAX_SPLIT, type Group, type SplitLayout } from '../shared/types.ts'
import settingsSvg from 'lucide-static/icons/settings.svg'
import { sidebarToggle } from './compact'
import { Dragger } from './drag'
import { downloadsButton, type Seen } from './downloads'
import { send, subscribe } from './host-client'
import { icons } from './icons'
import sidebarCss from './styles/sidebar.css'
import { svg } from './svg'
import { openSettings } from './settings'
import { openNewTabSearch } from './urlbar'
import { updateNotice } from './update-notice'
import { applyWorkspaceTheme } from './theme'
import { COLOR_HEX, colorHex, workspaceEditor, workspaceIcon } from './workspace-editor'
import folderSvg from './zen/folder-icon.svg'
import zenTokens from './zen/tokens.css'

// Chrome's favicon cache, by the page's own icon URL when the tab has
// reported one (a page looked up by its URL is only found once history has
// stored it), else by the page URL.
const faviconFor = (e: EntryView): string =>
  `chrome://favicon2/?size=16&scaleFactor=1x&allowGoogleServerFallback=0&${
    e.favicon && /^https?:/.test(e.favicon) ? `iconUrl=${encodeURIComponent(e.favicon)}` : `pageUrl=${encodeURIComponent(e.url)}`
  }`

type MenuItem = [string, () => void] | 'separator'

class GroveSidebar extends HTMLElement {
  private readonly root = this.attachShadow({ mode: 'open' })
  // The list and the workspace bar; overlays (menu, editor) sit beside it so
  // a re-render doesn't take them (or the editor's focus) away.
  private readonly body = el('div', 'body')
  private state?: WindowState
  private menu?: HTMLElement
  private editor?: HTMLElement
  private readonly drag = new Dragger(this, this.root, () => this.state)
  // A render that arrived while a drag was under way (it would pull the
  // dragged row out from under the pointer).
  private renderQueued = false
  private readonly seenDownloads: Seen = { ids: new Set(), primed: false }

  connectedCallback(): void {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(zenTokens + sidebarCss)
    this.root.adoptedStyleSheets = [sheet]
    this.root.append(this.body)
    subscribe((s) => {
      this.state = s
      this.render()
    })
    addEventListener('grove-sidebar-hidden', () => this.render())
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
    const scrollTop = this.root.querySelector('.scroll')?.scrollTop ?? 0
    const scroll = el('div', 'scroll')

    if (s.essentials.length) {
      const grid = el('div', 'essentials')
      grid.dataset.count = String(s.essentials.length)
      for (const e of s.essentials) grid.append(this.essential(e, s))
      scroll.append(grid)
    }

    const app = (this.getRootNode() as ShadowRoot).host
    if (app) applyWorkspaceTheme(app, colorHex(ws.color))

    const indicator = el('div', 'workspace-indicator')
    indicator.dataset.kind = 'pins-start'
    const wsIcon = el('span', 'icon')
    wsIcon.append(workspaceIcon(ws.icon))
    indicator.append(wsIcon, el('span', 'name', ws.name))
    indicator.addEventListener('dblclick', () => this.openEditor(ws))
    indicator.addEventListener('contextmenu', (ev) => {
      ev.preventDefault()
      this.openMenu(ev, this.workspaceMenu(ws, s))
    })
    scroll.append(indicator)

    const pinned = ws.entries.filter((e) => e.pinned)
    const tabs = ws.entries.filter((e) => !e.pinned)
    scroll.append(...this.items(pinned, s, 'pinned'))
    // Zen's separator, with its Clear button: closes the workspace's tabs,
    // all but its pins. Organize (with sync on) sorts loose tabs into folders.
    const sep = el('div', 'pinned-separator')
    sep.dataset.kind = 'tabs-start'
    sep.classList.toggle('empty', !pinned.length && !tabs.length)
    sep.append(el('span', 'line'))
    if (s.sync.state !== 'off' && tabs.some((e) => !e.groupId)) {
      const organize = el('button', 'clear organize')
      organize.title = s.organize.error ? `Organize failed: ${s.organize.error}` : 'Sort loose tabs into folders'
      organize.classList.toggle('busy', s.organize.busy)
      organize.classList.toggle('failed', !!s.organize.error)
      organize.disabled = s.organize.busy
      organize.append(svg(icons.sparkles), el('span', '', s.organize.busy ? 'Organizing…' : 'Organize'))
      organize.addEventListener('pointerdown', (ev) => ev.stopPropagation())
      organize.addEventListener('click', () => send({ type: 'organize' }))
      sep.append(organize)
    }
    if (tabs.length) {
      const clear = el('button', 'clear')
      clear.title = 'Close all unpinned tabs'
      clear.append(svg(icons.arrowDown), el('span', '', 'Clear'))
      clear.addEventListener('pointerdown', (ev) => ev.stopPropagation())
      clear.addEventListener('click', () => send({ type: 'clearTabs' }))
      sep.append(clear)
    }
    scroll.append(sep)

    const newTab = el('button', 'new-tab')
    newTab.dataset.kind = 'tabs-start'
    newTab.append(iconEl('favicon icon', icons.plus), el('span', 'label', 'New Tab'))
    newTab.addEventListener('click', () => {
      openNewTabSearch()
    })
    scroll.append(newTab)

    scroll.append(...this.items(tabs, s, 'tabs'))

    this.body.replaceChildren(...[scroll, updateNotice(s.update), this.foot(s)].filter((n): n is HTMLElement => !!n))
    scroll.scrollTop = scrollTop
  }

  // One section's rows: its loose tabs and splits, and a box for each folder.
  private items(entries: EntryView[], s: WindowState, section: 'pinned' | 'tabs'): HTMLElement[] {
    const out: HTMLElement[] = []
    const seen = new Set<string>()
    const loose: EntryView[] = []
    const flush = (): void => {
      out.push(...this.rows(loose, s, section))
      loose.length = 0
    }
    for (const e of entries) {
      if (!e.groupId) loose.push(e)
      else if (!seen.has(e.groupId)) {
        flush()
        seen.add(e.groupId)
        const group = s.workspace.groups.find((g) => g.id === e.groupId)
        if (group) out.push(this.folder(group, entries.filter((x) => x.groupId === e.groupId), s, section))
      }
    }
    flush()
    return out
  }

  // Tab rows, with a split's tabs (next to each other) in one capsule.
  private rows(entries: EntryView[], s: WindowState, section: 'pinned' | 'tabs'): HTMLElement[] {
    const out: HTMLElement[] = []
    for (let i = 0; i < entries.length; ) {
      const splitId = entries[i].splitId
      let j = i + 1
      while (splitId && j < entries.length && entries[j].splitId === splitId) j++
      out.push(splitId ? this.splitGroup(splitId, entries.slice(i, j), s, section) : this.tabRow(entries[i], s, section))
      i = j
    }
    return out
  }

  // Zen's split group (zen-split-group.inc.css): the split's tabs side by
  // side in one capsule.
  private splitGroup(splitId: string, members: EntryView[], s: WindowState, section: 'pinned' | 'tabs'): HTMLElement {
    const selected = members.some((m) => m.id === s.activeEntryId)
    const box = el('div', `split-group${selected ? ' has-selected' : ''}`)
    box.dataset.split = splitId
    for (const m of members) {
      const row = this.tabRow(m, s, section)
      row.classList.add('split-tab')
      box.append(row)
    }
    return box
  }

  // Called by the dragger when a drag ends.
  dragEnded(): void {
    if (this.renderQueued) this.render()
  }

  private essential(e: EntryView, s: WindowState): HTMLElement {
    const tile = el('div', `essential${e.id === s.activeEntryId ? ' selected' : ''}${e.live ? '' : ' frozen'}${s.paused?.entryId === e.id ? ' paused' : ''}`)
    tile.title = e.title
    tile.style.setProperty('--favicon', `url("${faviconFor(e)}")`)
    tile.append(favicon(e))
    tile.dataset.kind = 'essential'
    this.wire(tile, e, [
      ['Remove from Essentials', () => send({ type: 'setEssential', entryId: e.id, essential: false })],
      ['Pin to this workspace', () => send({ type: 'setPinned', entryId: e.id, pinned: true })],
      'separator',
      ...unloadItem(e),
      ['Close', () => send({ type: 'close', entryId: e.id })]
    ])
    return tile
  }

  private tabRow(e: EntryView, s: WindowState, section: 'pinned' | 'tabs'): HTMLElement {
    const row = el('div', `tab${e.id === s.activeEntryId ? ' selected' : ''}${e.live ? '' : ' frozen'}${s.paused?.entryId === e.id ? ' paused' : ''}`)
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
    row.dataset.section = section
    if (e.groupId) row.dataset.group = e.groupId
    const others = s.workspaces.filter((w) => w.id !== s.workspace.id)
    this.wire(row, e, [
      ...this.splitItems(e, s),
      ['Add to Essentials', () => send({ type: 'setEssential', entryId: e.id, essential: true })],
      [e.pinned ? 'Unpin from workspace' : 'Pin to workspace', () => send({ type: 'setPinned', entryId: e.id, pinned: !e.pinned })],
      ...(e.groupId ? [] : [['Add to new folder', () => send({ type: 'newFolder', entryId: e.id })] as MenuItem]),
      ...(others.length ? (['separator'] as MenuItem[]) : []),
      ...others.map((w): MenuItem => [`Move to ${w.name}`, () => send({ type: 'moveToWorkspace', entryId: e.id, workspaceId: w.id })]),
      'separator',
      ...unloadItem(e),
      ['Close', () => send({ type: 'close', entryId: e.id })]
    ])
    return row
  }

  // Split view, in a tab's menu (Zen's Add Split View…, Join Tabs and
  // Split Out Tab, and its layouts).
  private splitItems(e: EntryView, s: WindowState): MenuItem[] {
    const entries = s.workspace.entries
    const active = entries.find((x) => x.id === s.activeEntryId)
    if (e.splitId) {
      const count = entries.filter((x) => x.splitId === e.splitId).length
      const layout = (label: string, l: SplitLayout): MenuItem => [label, () => send({ type: 'split', entryIds: [e.id], layout: l })]
      return [
        ['Split out tab', () => send({ type: 'unsplit', entryId: e.id })],
        ['Close split view', () => send({ type: 'unsplitAll', splitId: e.splitId! })],
        layout('Side by side', 'vsep'),
        layout('Stacked', 'hsep'),
        ...(count > 2 ? [layout('Grid', 'grid')] : []),
        'separator'
      ]
    }
    if (e.id === s.activeEntryId) {
      return [
        [
          'New split view…',
          () =>
            openNewTabSearch((opened) => {
              if (opened) send({ type: 'splitNextTab', entryId: e.id })
            })
        ],
        'separator'
      ]
    }
    if (!active) return []
    const full = active.splitId && entries.filter((x) => x.splitId === active.splitId).length >= MAX_SPLIT
    if (full) return []
    return [
      [active.splitId ? 'Add to split view' : 'Split with current tab', () => send({ type: 'split', entryIds: [active.id, e.id] })],
      'separator'
    ]
  }

  private folder(group: Group, members: EntryView[], s: WindowState, section: 'pinned' | 'tabs'): HTMLElement {
    const hasSelected = members.some((m) => m.id === s.activeEntryId)
    const box = el('div', `folder${group.collapsed ? ' collapsed' : ''}${hasSelected ? ' has-selected' : ''}`)
    box.style.setProperty('--folder-accent', COLOR_HEX[group.color])
    box.dataset.section = section
    const head = el('div', 'folder-header')
    head.append(iconEl('folder-icon', folderSvg), el('span', 'label', group.title || 'Folder'))
    head.dataset.kind = 'folder'
    head.dataset.group = group.id
    head.dataset.section = section
    head.addEventListener('pointerdown', (ev) => this.drag.press(ev, { groupId: group.id }))
    head.addEventListener('click', () => send({ type: 'toggleFolder', groupId: group.id }))
    head.addEventListener('contextmenu', (ev) => {
      ev.preventDefault()
      this.openMenu(ev, [
        [
          group.pinned ? 'Unpin from workspace' : 'Pin to workspace',
          () => send({ type: 'setFolderPinned', groupId: group.id, pinned: !group.pinned })
        ],
        'separator',
        ['Ungroup', () => send({ type: 'ungroup', groupId: group.id })],
        [`Delete folder and ${tabCount(members.length)}`, () => send({ type: 'deleteFolder', groupId: group.id })]
      ])
    })
    head.append(this.deleteFolderButton(group, members.length))
    box.append(head)
    const active = members.find((m) => m.id === s.activeEntryId)
    const shown = group.collapsed
      ? members.filter((m) => m === active || (active?.splitId && m.splitId === active.splitId))
      : members
    if (shown.length) {
      const children = el('div', 'folder-tabs')
      children.append(...this.rows(shown, s, section))
      box.append(children)
    }
    return box
  }

  // Deletes the folder with its tabs. The first click only arms it (the
  // button turns red), so a stray click can't close a whole folder.
  private deleteFolderButton(group: Group, count: number): HTMLElement {
    const button = el('button', 'close folder-delete')
    const idle = `Delete folder and ${tabCount(count)}`
    button.title = idle
    button.append(svg(icons.trash))
    let disarm: ReturnType<typeof setTimeout> | undefined
    const reset = (): void => {
      clearTimeout(disarm)
      disarm = undefined
      button.classList.remove('armed')
      button.title = idle
    }
    button.addEventListener('mousedown', (ev) => ev.stopPropagation())
    button.addEventListener('pointerdown', (ev) => ev.stopPropagation())
    button.addEventListener('mouseleave', reset)
    button.addEventListener('click', (ev) => {
      ev.stopPropagation()
      if (!count || disarm) {
        reset()
        return send({ type: 'deleteFolder', groupId: group.id })
      }
      button.classList.add('armed')
      button.title = 'Click again to delete'
      disarm = setTimeout(reset, 3000)
    })
    return button
  }

  private foot(s: WindowState): HTMLElement {
    const foot = el('div', 'foot')
    const switcher = el('div', 'workspace-switcher')
    for (const w of s.workspaces) {
      const active = w.id === s.workspace.id
      const b = el('button', active ? 'active' : '')
      b.title = w.name
      b.style.setProperty('--ws-color', colorHex(w.color))
      b.dataset.kind = 'workspace'
      b.dataset.workspace = w.id
      b.append(workspaceIcon(w.icon))
      b.addEventListener('pointerdown', (ev) => this.drag.press(ev, { workspaceId: w.id }))
      b.addEventListener('click', () => send({ type: 'switchWorkspace', workspaceId: w.id }))
      b.addEventListener('contextmenu', (ev) => {
        ev.preventDefault()
        this.openMenu(ev, this.workspaceMenu(w, s))
      })
      switcher.append(b)
    }
    const add = el('button', 'tbtn')
    add.title = 'New workspace'
    add.append(svg(icons.plus))
    add.addEventListener('click', () => this.openEditor(undefined))
    // Bottom left, as in Zen: hide the sidebar, downloads, and Grove's
    // settings.
    const left = el('div', 'foot-left')
    const settings = el('button', 'tbtn')
    settings.title = 'Settings'
    settings.append(svg(settingsSvg))
    settings.addEventListener('click', openSettings)
    left.append(sidebarToggle(), downloadsButton(s, this.seenDownloads), settings)
    foot.append(left, switcher, add)
    return foot
  }

  private workspaceMenu(w: WorkspaceSummary, s: WindowState): MenuItem[] {
    return [
      ['Edit workspace…', () => this.openEditor(w)],
      ...(s.workspaces.length > 1
        ? (['separator', ['Delete workspace', () => send({ type: 'deleteWorkspace', workspaceId: w.id })]] as MenuItem[])
        : [])
    ]
  }

  private openEditor(existing: WorkspaceSummary | undefined): void {
    this.closeMenu()
    this.editor?.remove()
    const s = this.state
    if (!s) return
    const used = s.workspaces.map((w) => w.color)
    const defaults = {
      name: `Workspace ${s.workspaces.length + 1}`,
      color: COLORS.find((c) => !used.includes(c)) ?? 'gray'
    }
    this.editor = workspaceEditor(existing, defaults, (fields) => {
      this.editor?.remove()
      this.editor = undefined
      if (!fields) return
      if (existing) send({ type: 'editWorkspace', workspaceId: existing.id, ...fields })
      else send({ type: 'newWorkspace', ...fields })
    })
    this.root.append(this.editor)
  }

  private wire(node: HTMLElement, e: EntryView, menu: MenuItem[]): void {
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
      this.openMenu(ev, menu)
    })
  }

  // A small Grove menu for Grove's own model (pins, Essentials, folders and
  // workspaces are shared across windows, so Chrome's per-window tab menu
  // can't manage them).
  private openMenu(ev: MouseEvent, items: MenuItem[]): void {
    this.closeMenu()
    const menu = el('div', 'menu')
    for (const item of items) {
      if (item === 'separator') {
        menu.append(el('div', 'menu-separator'))
        continue
      }
      const [label, run] = item
      const button = el('button', 'menu-item', label)
      button.addEventListener('mousedown', (e) => e.stopPropagation())
      button.addEventListener('click', () => {
        this.closeMenu()
        run()
      })
      menu.append(button)
    }
    menu.addEventListener('mousedown', (e) => e.stopPropagation())
    this.menu = menu
    this.root.append(menu)
    // Keep it inside the sidebar: open upward near the bottom.
    const box = this.getBoundingClientRect()
    const h = menu.offsetHeight
    const top = Math.min(ev.clientY - box.top, box.height - h - 4)
    menu.style.left = `${Math.max(0, Math.min(ev.clientX - box.left, box.width - 170))}px`
    menu.style.top = `${Math.max(0, top)}px`
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
  img.src = faviconFor(e)
  img.alt = ''
  img.draggable = false
  return img
}

customElements.define('grove-sidebar', GroveSidebar)

// Unloading frees a page's memory; selecting the tab reopens it as it was.
function unloadItem(e: EntryView): MenuItem[] {
  return e.live ? [['Unload tab', () => send({ type: 'unload', entryId: e.id })]] : []
}

function tabCount(n: number): string {
  return n === 1 ? '1 tab' : `${n} tabs`
}
