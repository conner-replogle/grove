// <grove-sidebar>: Grove's tab list, drawn from Chrome's Tab Strip API.
// Pinned tabs are the Essentials grid, tab groups are folders, and the rest
// are the tab list. Webium's own tab strip stays in the page, hidden, so the
// rest of Webium (omnibox, content region) keeps getting its events.
import sidebarCss from './styles/sidebar.css'
import zenTokens from './zen/tokens.css'
import folderSvg from './zen/folder-icon.svg'
import { icons } from './icons'
import { svg } from './svg'
import { faviconUrl, tabsApi, type Container, type GroupData, type NodeId, type Tab, type TabStripService } from './tabs-api'

type Item =
  | { kind: 'tab'; tab: Tab }
  | { kind: 'group'; id: NodeId; data: GroupData; tabs: Tab[] }

interface Model {
  pinnedId?: NodeId
  unpinnedId?: NodeId
  pinned: Tab[]
  items: Item[]
}

const urlString = (u: unknown): string =>
  typeof u === 'string' ? u : ((u as { url?: string } | undefined)?.url ?? '')

// Chrome's tab group colors (tab_groups.mojom.Color), as Zen-like tints.
const GROUP_COLORS = ['#8e8e93', '#4a8fe0', '#e05a5a', '#d6b43c', '#4caf6e', '#e06ca8', '#9a6ce0', '#4fb8c8', '#e8914a']

function toModel(root: Container): Model {
  const model: Model = { pinned: [], items: [] }
  const walk = (c: Container): void => {
    const d = c.data
    if (d.pinnedTabs) {
      model.pinnedId = d.pinnedTabs.id
      for (const child of c.children) if (child.data.tab) model.pinned.push(child.data.tab)
      return
    }
    if (d.unpinnedTabs) {
      model.unpinnedId = d.unpinnedTabs.id
      for (const child of c.children) {
        if (child.data.tab) model.items.push({ kind: 'tab', tab: child.data.tab })
        else if (child.data.tabGroup) {
          const tabs = child.children.flatMap((g) => (g.data.tab ? [g.data.tab] : []))
          model.items.push({ kind: 'group', id: child.data.tabGroup.id, data: child.data.tabGroup.data, tabs })
        }
      }
      return
    }
    c.children.forEach(walk)
  }
  walk(root)
  return model
}

class GroveSidebar extends HTMLElement {
  private model: Model = { pinned: [], items: [] }
  private refreshing = false
  private dirty = false
  private readonly root = this.attachShadow({ mode: 'open' })
  private contextMenu?: (id: NodeId, x: number, y: number) => void

  async connectedCallback(): Promise<void> {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(zenTokens + sidebarCss)
    this.root.adoptedStyleSheets = [sheet]

    const api = await tabsApi()
    const snapshot = await api.service.getTabs()
    this.model = toModel(snapshot.tabStrip)
    this.render()

    const refresh = (): void => this.queueRefresh()
    api.observe(
      {
        onTabsCreated: refresh,
        onNodesClosed: refresh,
        onNodeMoved: refresh,
        onCollectionCreated: refresh,
        onDataChanged: (e) => {
          if (e.tab) this.updateTab(e.tab.data)
          else refresh()
        }
      },
      snapshot.stream.handle
    )

    const ui = await import('/tab_strip_api/tab_strip_ui_controller.mojom-webui.js')
    const controller = ui.TabStripUIController.getRemote()
    this.contextMenu = (id, x, y) => controller.showTabContextMenu(id, { x, y })
  }

  // Re-reads the whole tree after structural changes. Events that arrive
  // while a read is in flight trigger one more read, so none are lost.
  // (A timer, not requestAnimationFrame: rAF stops in hidden windows.)
  private queueRefresh(): void {
    this.dirty = true
    if (this.refreshing) return
    this.refreshing = true
    setTimeout(async () => {
      try {
        while (this.dirty) {
          this.dirty = false
          const { fresh } = await tabsApi()
          const snapshot = await withTimeout(fresh().getTabs(), 2000)
          if (!snapshot) continue
          this.model = toModel(snapshot.tabStrip)
          this.render()
        }
      } finally {
        this.refreshing = false
      }
    }, 16)
  }

  private updateTab(tab: Tab): void {
    const replace = (t: Tab): Tab => (t.id === tab.id ? tab : t)
    this.model.pinned = this.model.pinned.map(replace)
    this.model.items = this.model.items.map((it) =>
      it.kind === 'tab' ? { ...it, tab: replace(it.tab) } : { ...it, tabs: it.tabs.map(replace) }
    )
    this.render()
  }

  // Sends one change to the browser; see TabsApi.fresh for why it doesn't wait.
  private async act(fn: (s: TabStripService) => Promise<unknown>): Promise<void> {
    const { fresh } = await tabsApi()
    fn(fresh()).catch((e: unknown) => console.error('[grove]', e))
  }

  private render(): void {
    const { pinned, items } = this.model
    const scroll = el('div', 'scroll')

    if (pinned.length) {
      const grid = el('div', 'essentials')
      grid.dataset.count = String(pinned.length)
      for (const tab of pinned) grid.append(this.essential(tab))
      scroll.append(grid)
    }

    const indicator = el('div', 'workspace-indicator')
    indicator.append(iconEl('icon', icons.leaf), el('span', 'name', 'Home'), iconEl('actions', icons.ellipsis))
    scroll.append(indicator)

    const newTab = el('button', 'new-tab')
    newTab.append(iconEl('favicon icon', icons.plus), el('span', 'label', 'New Tab'))
    newTab.addEventListener('click', () => this.act((s) => s.createTabAt(null, null)))
    scroll.append(newTab)

    for (const item of items) scroll.append(item.kind === 'tab' ? this.tabRow(item.tab) : this.folder(item))

    const foot = el('div', 'foot')
    const switcher = el('div', 'workspace-switcher')
    const home = el('button', 'active')
    home.title = 'Home'
    home.append(svg(icons.leaf))
    switcher.append(home)
    const add = el('button', 'tbtn')
    add.title = 'New workspace'
    add.append(svg(icons.plus))
    foot.append(el('span', 'tbtn-spacer'), switcher, add)

    this.root.replaceChildren(scroll, foot)
  }

  private essential(tab: Tab): HTMLElement {
    const tile = el('div', `essential${tab.isActive ? ' selected' : ''}`)
    tile.title = tab.title
    const url = faviconUrl(tab)
    if (url) tile.style.setProperty('--favicon', `url("${url}")`)
    tile.append(favicon(tab))
    this.wireTab(tile, tab)
    return tile
  }

  private tabRow(tab: Tab): HTMLElement {
    const row = el('div', `tab${tab.isActive ? ' selected' : ''}`)
    row.title = `${tab.title}\n${urlString(tab.url)}`
    row.append(favicon(tab), el('span', 'label', tab.title || urlString(tab.url) || 'New Tab'))
    const close = el('button', 'close')
    close.append(svg(icons.x))
    close.title = 'Close tab'
    close.addEventListener('mousedown', (e) => e.stopPropagation())
    close.addEventListener('click', (e) => {
      e.stopPropagation()
      void this.act((s) => s.closeNodes([tab.id]))
    })
    row.append(close)
    this.wireTab(row, tab)
    return row
  }

  private folder(group: Extract<Item, { kind: 'group' }>): HTMLElement {
    const hasSelected = group.tabs.some((t) => t.isActive)
    const box = el('div', `folder${group.data.isCollapsed ? ' collapsed' : ''}${hasSelected ? ' has-selected' : ''}`)
    box.style.setProperty('--folder-accent', GROUP_COLORS[group.data.color] ?? GROUP_COLORS[0])
    const head = el('div', 'folder-header')
    head.append(iconEl('folder-icon', folderSvg), el('span', 'label', group.data.title || 'Folder'))
    head.addEventListener('click', () =>
      this.act((s) =>
        // The update mask only knows title and color; no mask replaces the
        // whole visual data, which is how the collapsed flag changes.
        s.update({ tabGroup: { id: group.id, data: { ...group.data, isCollapsed: !group.data.isCollapsed } } }, null)
      )
    )
    box.append(head)
    const shown = group.data.isCollapsed ? group.tabs.filter((t) => t.isActive) : group.tabs
    if (shown.length) {
      const children = el('div', 'folder-tabs')
      for (const tab of shown) children.append(this.tabRow(tab))
      box.append(children)
    }
    return box
  }

  private wireTab(node: HTMLElement, tab: Tab): void {
    node.addEventListener('mousedown', (e) => {
      if (e.button === 0) void this.act((s) => s.activateTab(tab.id))
    })
    node.addEventListener('auxclick', (e) => {
      if (e.button === 1) void this.act((s) => s.closeNodes([tab.id]))
    })
    node.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      this.contextMenu?.(tab.id, e.screenX, e.screenY)
    })
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))])
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

function favicon(tab: Tab): HTMLElement {
  const url = faviconUrl(tab)
  if (tab.networkState === 1 || tab.networkState === 2) return el('span', 'favicon loading')
  if (!url) return el('span', 'favicon blank')
  const img = el('img', 'favicon')
  img.src = url
  img.alt = ''
  return img
}

function iconEl(cls: string, markup: string): HTMLElement {
  const span = el('span', cls)
  span.append(svg(markup))
  return span
}

customElements.define('grove-sidebar', GroveSidebar)
