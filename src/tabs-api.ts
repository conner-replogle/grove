// Chrome's Tab Strip API (components/browser_apis/tab_strip), loaded at
// runtime from the browser's own WebUI resources.

export type NodeId = string

export interface Tab {
  id: NodeId
  title: string
  url: { url: string }
  favicon: { dataUrl: { url: string } | string }
  alertStates: number[]
  networkState: number
  isActive: boolean
  isSelected: boolean
  isBlocked: boolean
}

export interface GroupData {
  title: string
  color: number
  isCollapsed: boolean
}

export interface Container {
  data: {
    tab?: Tab
    tabGroup?: { id: NodeId; data: GroupData }
    pinnedTabs?: { id: NodeId }
    unpinnedTabs?: { id: NodeId }
    tabStrip?: { id: NodeId }
    splitTab?: { id: NodeId }
    window?: { id: NodeId }
  }
  children: Container[]
}

export interface Position {
  path?: { components: NodeId[] }
  index: number
}

export interface TabStripService {
  getTabs(): Promise<{ tabStrip: Container; stream: { handle: unknown } }>
  createTabAt(pos: Position | null, url: { url: string } | null): Promise<unknown>
  closeNodes(ids: NodeId[]): Promise<unknown>
  activateTab(id: NodeId): Promise<unknown>
  moveNode(id: NodeId, position: Position): Promise<unknown>
  update(data: Container['data'], mask: string[] | null): Promise<unknown>
}

export interface TabStripObserver {
  onTabsCreated(e: unknown): void
  onNodesClosed(e: unknown): void
  onNodeMoved(e: unknown): void
  onDataChanged(e: { tab?: { data: Tab }; tabGroup?: { data: { id: NodeId; data: GroupData } } }): void
  onCollectionCreated(e: unknown): void
}

interface Observation {
  bind(handle: unknown): void
}

export interface TabsApi {
  service: TabStripService
  // A new connection, for one mutating call. Replies to mutations are
  // unreliable in Chromium 154 (moveNode's never arrives, and an error reply
  // can close the pipe), so each change gets its own and nobody waits on it.
  fresh(): TabStripService
  observe(observer: TabStripObserver, handle: unknown): Observation
}

let api: Promise<TabsApi> | undefined

export function tabsApi(): Promise<TabsApi> {
  api ??= (async () => {
    const svc = await import('/tab_strip_api/tab_strip_api.mojom-webui.js')
    const obs = await import('/tab_strip_api/tab_strip_observation.js')
    const service = svc.TabStripService.getRemote() as TabStripService
    return {
      service,
      fresh: () => svc.TabStripService.getRemote() as TabStripService,
      observe(observer: TabStripObserver, handle: unknown) {
        const o = new obs.TabStripObservation(observer) as Observation
        o.bind(handle)
        return o
      }
    }
  })()
  return api
}

export function faviconUrl(tab: Tab): string {
  const f = tab.favicon?.dataUrl
  return typeof f === 'string' ? f : (f?.url ?? '')
}
