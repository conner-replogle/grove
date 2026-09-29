// <grove-sidebar>: Grove's tab list, drawn from Chrome's Tab Strip API.
// Pinned tabs are the Essentials grid, tab groups are folders, and the rest
// are the tab list. Webium's own tab strip stays in the page, hidden, so the
// rest of Webium (omnibox, content region) keeps getting its events.
import sidebarCss from './styles/sidebar.css'
import { faviconUrl, tabsApi, type Container, type GroupData, type NodeId, type Tab } from './tabs-api'

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
  private refreshQueued = false
  private readonly root = this.attachShadow({ mode: 'open' })
  private contextMenu?: (id: NodeId, x: number, y: number) => void

  async connectedCallback(): Promise<void> {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(sidebarCss)
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

  private queueRefresh(): void {
    if (this.refreshQueued) return
    this.refreshQueued = true
    requestAnimationFrame(async () => {
      this.refreshQueued = false
      const { service } = await tabsApi()
      const snapshot = await service.getTabs()
      this.model = toModel(snapshot.tabStrip)
      this.render()
    })
  }

  private updateTab(tab: Tab): void {
    const replace = (t: Tab): Tab => (t.id === tab.id ? tab : t)
    this.model.pinned = this.model.pinned.map(replace)
    this.model.items = this.model.items.map((it) =>
      it.kind === 'tab' ? { ...it, tab: replace(it.tab) } : { ...it, tabs: it.tabs.map(replace) }
    )
    this.render()
  }

  private async act(fn: (s: Awaited<ReturnType<typeof tabsApi>>['service']) => Promise<unknown>): Promise<void> {
    const { service } = await tabsApi()
    await fn(service).catch((e: unknown) => console.error('[grove]', e))
  }

  private render(): void {
    const { pinned, items } = this.model
    const frag = document.createDocumentFragment()

    if (pinned.length) {
      const grid = el('div', 'essentials')
      for (const tab of pinned) grid.append(this.essential(tab))
      frag.append(grid)
    }

    const header = el('div', 'workspace-indicator')
    header.append(el('span', 'workspace-icon', '🌿'), el('span', 'workspace-name', 'Home'))
    frag.append(header)

    const newTab = el('button', 'new-tab')
    newTab.append(el('span', 'new-tab-plus', '+'), el('span', 'label', 'New Tab'))
    newTab.addEventListener('click', () => this.act((s) => s.createTabAt(null, null)))
    frag.append(newTab)

    const list = el('div', 'tabs')
    for (const item of items) {
      if (item.kind === 'tab') list.append(this.tabRow(item.tab))
      else list.append(this.folder(item))
    }
    frag.append(list)

    this.root.replaceChildren(frag)
  }

  private essential(tab: Tab): HTMLElement {
    const tile = el('div', `essential${tab.isActive ? ' selected' : ''}`)
    tile.title = tab.title
    tile.append(favicon(tab))
    this.wireTab(tile, tab)
    return tile
  }

  private tabRow(tab: Tab): HTMLElement {
    const row = el('div', `tab${tab.isActive ? ' selected' : ''}`)
    row.title = `${tab.title}\n${urlString(tab.url)}`
    row.append(favicon(tab), el('span', 'label', tab.title || urlString(tab.url) || 'New Tab'))
    const close = el('button', 'close', '×')
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
    const box = el('div', `folder${group.data.isCollapsed ? ' collapsed' : ''}`)
    box.style.setProperty('--folder-color', GROUP_COLORS[group.data.color] ?? GROUP_COLORS[0])
    const head = el('div', 'folder-header')
    head.append(folderIcon(), el('span', 'label', group.data.title || 'Folder'))
    head.addEventListener('click', () =>
      this.act((s) =>
        s.update({ tabGroup: { id: group.id, data: { ...group.data, isCollapsed: !group.data.isCollapsed } } }, [
          'is_collapsed'
        ])
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

function folderIcon(): HTMLElement {
  const span = el('span', 'folder-icon')
  span.innerHTML =
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M1.5 4.5a1.5 1.5 0 0 1 1.5-1.5h3l1.5 1.5h5.5a1.5 1.5 0 0 1 1.5 1.5v5.5a1.5 1.5 0 0 1-1.5 1.5H3a1.5 1.5 0 0 1-1.5-1.5z" fill="var(--folder-color)" /></svg>'
  return span
}

customElements.define('grove-sidebar', GroveSidebar)
