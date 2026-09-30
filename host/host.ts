// The Grove host: one canonical workspace model shared by every window,
// kept in step with Chrome's real windows and tabs through the bridge
// extension. Windows never own tabs; each window shows one workspace, and
// an entry's page lives in at most one window. Selecting an entry that is
// open in another window moves the live page here (settled decision 1);
// workspaces no window shows keep no pages (decision 2).
import type { HostCommand, WindowState } from '../shared/protocol.ts'
import type { Entry, Model, Workspace } from '../shared/types.ts'
import * as M from './model.ts'
import type { Store } from './store.ts'

export interface BridgeTab {
  id: number
  windowId: number
  index: number
  active: boolean
  url: string
  title: string
  favIconUrl: string
  status: string
  audible: boolean
  openerTabId?: number
}

export type BridgeEvent =
  | { type: 'tabCreated'; tab: BridgeTab; requestId?: string }
  | { type: 'tabRemoved'; tabId: number; windowId: number; windowClosing: boolean }
  | { type: 'tabUpdated'; tab: BridgeTab }
  | { type: 'tabActivated'; tabId: number; windowId: number }
  | { type: 'tabAttached'; tabId: number; windowId: number }
  | { type: 'windowCreated'; windowId: number }
  | { type: 'windowRemoved'; windowId: number }

export interface Bridge {
  call<T = unknown>(fn: string, arg?: unknown): Promise<T>
}

export interface UiSink {
  push(windowId: number, state: WindowState): void
}

interface Binding {
  workspaceId: string
  activeEntryId?: string
}

const NEW_TAB_URL = 'chrome://newtab/'
const isNewTabPage = (url: string): boolean => /^chrome:\/\/(newtab|new-tab-page)\/?$/.test(url)

export class GroveHost {
  private model: Model
  private bridge?: Bridge
  private readonly windows = new Map<number, Binding>()
  // Every normal tab Chrome has, by window, including ones Grove doesn't show.
  private readonly tabWindow = new Map<number, number>()
  private readonly tabOf = new Map<string, number>() // entry id -> tab id
  private readonly entryOf = new Map<number, string>() // tab id -> entry id
  // Tabs Grove opened only so a window isn't left empty.
  private readonly placeholders = new Set<number>()
  // Tabs Grove is closing itself (unload, close); their removal isn't a user close.
  private readonly closingByHost = new Set<number>()
  private readonly loading = new Set<number>()
  // Tabs Grove asked the bridge to create: request id -> what they are for.
  private readonly requests = new Map<string, { entryId?: string; placeholder?: boolean }>()
  private nextRequest = 1
  private pushQueued = false
  // Windows open at start-up whose workspace isn't shown yet, with Chrome's
  // own start-up tabs to drop once it is.
  private readonly startup = new Map<number, number[]>()
  private readonly uiReady = new Set<number>()

  private readonly store: Store
  private readonly ui: UiSink
  private readonly log: (...a: unknown[]) => void

  constructor(store: Store, ui: UiSink, log: (...a: unknown[]) => void = () => {}) {
    this.store = store
    this.ui = ui
    this.log = log
    this.model = store.load()
  }

  // ---- Start-up ----

  async attach(bridge: Bridge): Promise<void> {
    this.bridge = bridge
    const windows = await bridge.call<{ id: number; tabs: BridgeTab[] }[]>('snapshot')
    for (const w of windows) {
      const ws = M.getWorkspace(this.model, this.model.lastActiveWorkspaceId)
      this.windows.set(w.id, { workspaceId: ws.id, activeEntryId: ws.activeEntryId })
      const stray: number[] = []
      for (const tab of w.tabs) {
        this.tabWindow.set(tab.id, w.id)
        // The new-tab page Chrome opens at start-up gives way to the
        // workspace's own tabs, unless the workspace is empty.
        if (isNewTabPage(tab.url) && ws.entries.length) stray.push(tab.id)
        else this.adoptTab(tab)
      }
      this.startup.set(w.id, stray)
    }
    this.pushAll()
    // Windows whose UI said hello before the bridge was up.
    for (const id of this.uiReady) void this.finishStartup(id)
  }

  // Opens a start-up window's workspace. Deferred until the window's UI is
  // up: changing its tabs while Webium's UI is still loading hangs that UI.
  private async finishStartup(windowId: number): Promise<void> {
    const stray = this.startup.get(windowId)
    if (!stray) return
    this.startup.delete(windowId)
    await this.showActive(windowId)
    const leftover = stray.filter((id) => this.tabWindow.get(id) === windowId)
    if (leftover.length && this.tabsIn(windowId).length > leftover.length) await this.closeTabs(leftover)
    else leftover.forEach((id) => this.placeholders.add(id))
    this.pushAll()
  }

  windowIds(): number[] {
    return [...this.windows.keys()]
  }

  // ---- Chrome's side ----

  onBridgeEvent(e: BridgeEvent): void {
    switch (e.type) {
      case 'tabCreated':
        return this.onTabCreated(e.tab, e.requestId)
      case 'tabRemoved':
        return this.onTabRemoved(e.tabId, e.windowClosing)
      case 'tabUpdated':
        return this.onTabUpdated(e.tab)
      case 'tabActivated':
        return this.onTabActivated(e.tabId, e.windowId)
      case 'tabAttached':
        this.tabWindow.set(e.tabId, e.windowId)
        return this.queuePush()
      case 'windowCreated':
        this.bindWindow(e.windowId)
        return this.queuePush()
      case 'windowRemoved':
        this.windows.delete(e.windowId)
        return this.queuePush()
    }
  }

  private bindWindow(windowId: number): Binding {
    let b = this.windows.get(windowId)
    if (!b) {
      // Settled decision 4: new windows open on the last active workspace.
      b = { workspaceId: this.model.lastActiveWorkspaceId }
      this.windows.set(windowId, b)
    }
    return b
  }

  private onTabCreated(tab: BridgeTab, requestId?: string): void {
    this.tabWindow.set(tab.id, tab.windowId)
    if (this.entryOf.has(tab.id)) return
    const req = requestId ? this.requests.get(requestId) : undefined
    if (requestId) this.requests.delete(requestId)
    if (req?.placeholder) {
      this.placeholders.add(tab.id)
      return
    }
    if (req?.entryId) {
      this.map(req.entryId, tab.id)
      this.queuePush()
      return
    }
    // A tab the user or a page opened: a new entry in that window's workspace,
    // next to the tab that opened it.
    const entry = this.adoptTab(tab)
    const b = this.bindWindow(tab.windowId)
    if (tab.active) this.setActive(tab.windowId, b, entry.id)
    this.queuePush()
  }

  // Makes an existing Chrome tab an entry of its window's workspace.
  private adoptTab(tab: BridgeTab): Entry {
    const b = this.bindWindow(tab.windowId)
    const opener = tab.openerTabId !== undefined ? this.entryOf.get(tab.openerTabId) : undefined
    let entry!: Entry
    this.update((m) =>
      M.withWorkspace(m, b.workspaceId, (ws) => {
        ;[ws, entry] = M.addEntry(ws, { url: tab.url, title: tab.title }, { afterId: opener })
        return ws
      })
    )
    this.map(entry.id, tab.id)
    if (tab.active) this.setActive(tab.windowId, b, entry.id)
    return entry
  }

  private onTabRemoved(tabId: number, windowClosing: boolean): void {
    const windowId = this.tabWindow.get(tabId)
    this.tabWindow.delete(tabId)
    this.placeholders.delete(tabId)
    this.loading.delete(tabId)
    const entryId = this.entryOf.get(tabId)
    if (entryId) this.unmap(entryId)
    if (this.closingByHost.delete(tabId) || !entryId) return this.queuePush()
    // Closing a window freezes its tabs; closing a tab closes its entry.
    if (!windowClosing) {
      this.closeEntries([entryId])
      if (windowId !== undefined) void this.afterLoss(windowId)
    }
    this.queuePush()
  }

  private onTabUpdated(tab: BridgeTab): void {
    if (tab.status === 'loading') this.loading.add(tab.id)
    else this.loading.delete(tab.id)
    const entryId = this.entryOf.get(tab.id)
    if (!entryId) return
    const ws = M.workspaceOfEntry(this.model, entryId)
    if (!ws) return
    this.update((m) =>
      M.withWorkspace(m, ws.id, (w) =>
        M.updateEntry(w, entryId, { url: tab.url || undefined, title: tab.title || undefined })
      )
    )
  }

  private onTabActivated(tabId: number, windowId: number): void {
    const entryId = this.entryOf.get(tabId)
    const b = this.windows.get(windowId)
    if (!entryId || !b) return
    if (M.workspaceOfEntry(this.model, entryId)?.id !== b.workspaceId) return
    this.setActive(windowId, b, entryId)
    this.queuePush()
  }

  // ---- The UI's side ----

  async command(windowId: number, c: HostCommand): Promise<void> {
    const b = this.bindWindow(windowId)
    switch (c.type) {
      case 'hello':
        this.uiReady.add(windowId)
        this.push(windowId)
        return this.finishStartup(windowId)
      case 'activate':
        return this.activateIn(windowId, c.entryId)
      case 'close':
        return this.closeEntryEverywhere(c.entryId)
      case 'newTab':
        return this.newTab(windowId)
      case 'setPinned':
        return this.editWorkspace(b, (ws) => M.setPinned(ws, c.entryId, c.pinned))
      case 'newFolder':
        return this.editWorkspace(b, (ws) => M.createGroup(ws, [c.entryId])[0])
      case 'toggleFolder':
        return this.editWorkspace(b, (ws) => {
          const g = ws.groups.find((x) => x.id === c.groupId)
          return g ? M.updateGroup(ws, g.id, { collapsed: !g.collapsed }) : ws
        })
      case 'ungroup':
        return this.editWorkspace(b, (ws) => M.ungroup(ws, c.groupId))
      case 'switchWorkspace':
        return this.switchWorkspace(windowId, c.workspaceId)
      case 'newWorkspace': {
        let id!: string
        this.update((m) => ([m, id] = M.createWorkspace(m))[0])
        return this.switchWorkspace(windowId, id)
      }
      case 'renameWorkspace':
        this.update((m) => M.renameWorkspace(m, c.workspaceId, c.name))
        return
    }
  }

  private editWorkspace(b: Binding, fn: (ws: Workspace) => Workspace): void {
    this.update((m) => M.withWorkspace(m, b.workspaceId, fn))
  }

  // Shows an entry in a window: activates its tab here, moves the live page
  // over from another window, or opens a frozen entry.
  async activateIn(windowId: number, entryId: string): Promise<void> {
    const b = this.bindWindow(windowId)
    if (M.workspaceOfEntry(this.model, entryId)?.id !== b.workspaceId) return
    this.setActive(windowId, b, entryId)
    this.pushAll()
    const bridge = this.bridge!
    const tabId = this.tabOf.get(entryId)
    if (tabId !== undefined) {
      const from = this.tabWindow.get(tabId)!
      if (from === windowId) {
        await bridge.call('activate', tabId)
      } else {
        await this.keepWindowOpen(from, [tabId])
        this.tabWindow.set(tabId, windowId)
        await bridge.call('move', { tabId, windowId })
        const src = this.windows.get(from)
        if (src?.activeEntryId === entryId) await this.afterLoss(from)
      }
    } else {
      const entry = this.entry(entryId)
      if (!entry) return
      await this.createTab(windowId, entry.url || NEW_TAB_URL, entryId)
    }
    await this.dropPlaceholders(windowId)
    this.pushAll()
  }

  private async newTab(windowId: number): Promise<void> {
    const b = this.bindWindow(windowId)
    let entry!: Entry
    this.update((m) =>
      M.withWorkspace(m, b.workspaceId, (ws) => ([ws, entry] = M.addEntry(ws, { url: NEW_TAB_URL, title: 'New Tab' }))[0])
    )
    this.setActive(windowId, b, entry.id)
    await this.createTab(windowId, NEW_TAB_URL, entry.id)
    await this.dropPlaceholders(windowId)
    this.pushAll()
  }

  private async closeEntryEverywhere(entryId: string): Promise<void> {
    const tabId = this.tabOf.get(entryId)
    const affected = [...this.windows].filter(([, b]) => b.activeEntryId === entryId).map(([id]) => id)
    this.closeEntries([entryId])
    if (tabId !== undefined) {
      const windowId = this.tabWindow.get(tabId)!
      await this.keepWindowOpen(windowId, [tabId])
      await this.closeTabs([tabId])
    }
    for (const w of affected) await this.afterLoss(w)
    this.pushAll()
  }

  private async switchWorkspace(windowId: number, workspaceId: string): Promise<void> {
    const b = this.bindWindow(windowId)
    if (b.workspaceId === workspaceId) return
    const old = b.workspaceId
    const ws = M.getWorkspace(this.model, workspaceId)
    b.workspaceId = workspaceId
    b.activeEntryId = ws.activeEntryId ?? M.mostRecent(ws.entries)?.id
    this.update((m) => ({ ...m, lastActiveWorkspaceId: workspaceId }))
    this.pushAll()
    await this.showActive(windowId)
    await this.unloadIfHidden(old)
    this.pushAll()
  }

  // ---- Internals ----

  private async showActive(windowId: number): Promise<void> {
    const b = this.bindWindow(windowId)
    const ws = M.getWorkspace(this.model, b.workspaceId)
    const entryId = ws.entries.some((e) => e.id === b.activeEntryId)
      ? b.activeEntryId
      : M.mostRecent(ws.entries)?.id
    if (entryId) await this.activateIn(windowId, entryId)
    else await this.newTab(windowId)
  }

  // A window lost the entry it showed (closed, or moved to another window):
  // show its most recent entry that is already open here, without pulling
  // pages from other windows.
  private async afterLoss(windowId: number): Promise<void> {
    const b = this.windows.get(windowId)
    if (!b) return
    const ws = M.getWorkspace(this.model, b.workspaceId)
    const here = ws.entries.filter((e) => {
      const t = this.tabOf.get(e.id)
      return t !== undefined && this.tabWindow.get(t) === windowId && e.id !== b.activeEntryId
    })
    const next = M.mostRecent(here)
    b.activeEntryId = next?.id
    if (next) await this.bridge?.call('activate', this.tabOf.get(next.id))
    this.pushAll()
  }

  // Workspaces no window shows keep no pages.
  private async unloadIfHidden(workspaceId: string): Promise<void> {
    if ([...this.windows.values()].some((b) => b.workspaceId === workspaceId)) return
    const ws = this.model.workspaces.find((w) => w.id === workspaceId)
    const tabs = (ws?.entries ?? []).flatMap((e) => {
      const t = this.tabOf.get(e.id)
      return t === undefined ? [] : [t]
    })
    for (const tabId of tabs) {
      const entryId = this.entryOf.get(tabId)
      if (entryId) this.unmap(entryId)
    }
    const byWindow = new Map<number, number[]>()
    for (const t of tabs) {
      const w = this.tabWindow.get(t)!
      byWindow.set(w, [...(byWindow.get(w) ?? []), t])
    }
    for (const [w, ids] of byWindow) await this.keepWindowOpen(w, ids)
    await this.closeTabs(tabs)
  }

  // Chrome closes a window when its last tab leaves; give it a placeholder.
  private async keepWindowOpen(windowId: number, leaving: number[]): Promise<void> {
    const remaining = this.tabsIn(windowId).filter((t) => !leaving.includes(t))
    if (remaining.length === 0) await this.createTab(windowId, NEW_TAB_URL, undefined, { placeholder: true, active: false })
  }

  private async dropPlaceholders(windowId: number): Promise<void> {
    const ids = [...this.placeholders].filter((t) => this.tabWindow.get(t) === windowId)
    if (!ids.length || this.tabsIn(windowId).length <= ids.length) return
    await this.closeTabs(ids)
  }

  private async createTab(
    windowId: number,
    url: string,
    entryId?: string,
    opts: { placeholder?: boolean; active?: boolean } = {}
  ): Promise<void> {
    const requestId = `r${this.nextRequest++}`
    this.requests.set(requestId, { entryId, placeholder: opts.placeholder })
    await this.bridge!.call('create', { windowId, url, active: opts.active ?? true, requestId })
  }

  private async closeTabs(tabIds: number[]): Promise<void> {
    if (!tabIds.length) return
    tabIds.forEach((t) => this.closingByHost.add(t))
    await this.bridge!.call('remove', tabIds).catch((e: unknown) => this.log('remove failed', e))
  }

  private tabsIn(windowId: number): number[] {
    return [...this.tabWindow].filter(([, w]) => w === windowId).map(([t]) => t)
  }

  private closeEntries(ids: string[]): void {
    const ws = M.workspaceOfEntry(this.model, ids[0])
    if (!ws) return
    this.update((m) => M.withWorkspace(m, ws.id, (w) => M.closeEntries(w, ids)))
  }

  private setActive(_windowId: number, b: Binding, entryId: string): void {
    b.activeEntryId = entryId
    this.update((m) => ({
      ...M.withWorkspace(m, b.workspaceId, (ws) => M.activateEntry(ws, entryId)),
      lastActiveWorkspaceId: b.workspaceId
    }))
  }

  private entry(entryId: string): Entry | undefined {
    return M.workspaceOfEntry(this.model, entryId)?.entries.find((e) => e.id === entryId)
  }

  private map(entryId: string, tabId: number): void {
    this.tabOf.set(entryId, tabId)
    this.entryOf.set(tabId, entryId)
  }

  private unmap(entryId: string): void {
    const t = this.tabOf.get(entryId)
    if (t !== undefined) this.entryOf.delete(t)
    this.tabOf.delete(entryId)
  }

  private update(fn: (m: Model) => Model): void {
    const next = fn(this.model)
    if (next === this.model) return
    this.model = next
    this.store.save(next)
    this.queuePush()
  }

  flush(): void {
    this.store.save(this.model)
    this.store.flush()
  }

  // ---- Telling the windows ----

  private queuePush(): void {
    if (this.pushQueued) return
    this.pushQueued = true
    queueMicrotask(() => {
      this.pushQueued = false
      this.pushAll()
    })
  }

  private pushAll(): void {
    for (const id of this.windows.keys()) this.push(id)
  }

  push(windowId: number): void {
    const b = this.windows.get(windowId)
    if (b) this.ui.push(windowId, this.view(windowId, b))
  }

  private view(windowId: number, b: Binding): WindowState {
    const ws = M.getWorkspace(this.model, b.workspaceId)
    return {
      windowId,
      workspaces: this.model.workspaces.map(({ id, name, color }) => ({ id, name, color })),
      workspace: {
        id: ws.id,
        name: ws.name,
        color: ws.color,
        groups: ws.groups,
        entries: ws.entries.map((e) => {
          const t = this.tabOf.get(e.id)
          return {
            id: e.id,
            title: e.title || e.url,
            url: e.url,
            pinned: e.pinned,
            groupId: e.groupId,
            live: t !== undefined,
            here: t !== undefined && this.tabWindow.get(t) === windowId,
            loading: t !== undefined && this.loading.has(t)
          }
        })
      },
      activeEntryId: b.activeEntryId
    }
  }
}
