// The Grove host: one canonical workspace model shared by every window,
// kept in step with Chrome's real windows and tabs through the bridge
// extension. Windows never own tabs; each window shows one workspace, and
// an entry's page lives in at most one window. Selecting an entry that is
// open in another window moves the live page here (settled decision 1);
// workspaces no window shows keep no pages (decision 2).
import { DEFAULT_SETTINGS, type DownloadView, type EntryView, type HistorySuggestion, type HostCommand, type PermissionDecision, type PermissionKind, type SyncStatus, type WindowState } from '../shared/protocol.ts'
import { HistoryIndex, type HistoryItem } from './history-index.ts'
import type { Entry, Model, Workspace } from '../shared/types.ts'
import * as M from './model.ts'
import type { Settings } from './settings.ts'
import { keptByHost, type SitePermissions } from './site-permissions.ts'
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
  // restoredSession: the user reopened a tab Grove had unloaded.
  | { type: 'tabCreated'; tab: BridgeTab; requestId?: string; restoredSession?: string }
  | { type: 'tabRemoved'; tabId: number; windowId: number; windowClosing: boolean }
  | { type: 'tabUpdated'; tab: BridgeTab }
  | { type: 'tabActivated'; tabId: number; windowId: number }
  | { type: 'tabAttached'; tabId: number; windowId: number }
  | { type: 'windowCreated'; windowId: number }
  | { type: 'windowRemoved'; windowId: number }
  | { type: 'permissionRequest'; id: string; tabId: number; origin: string; topOrigin?: string; kinds: PermissionKind[] }
  | { type: 'download'; download: DownloadView; created?: boolean }
  | { type: 'downloadErased'; id: number }
  | { type: 'tabPainted'; tabId: number }
  | { type: 'historyVisited'; item: HistoryItem }
  | { type: 'historyRemoved'; all: boolean; urls: string[] }

export interface Bridge {
  call<T = unknown>(fn: string, arg?: unknown): Promise<T>
}

export interface UiSink {
  push(windowId: number, state: WindowState): void
  // Opens the window's URL bar with keyboard focus, as Ctrl+L does.
  focusUrlBar(windowId: number): void
  // Opens the window's URL bar as a new tab's search, as Zen does: no tab
  // until a result is picked, which then opens in a new tab.
  openNewTabSearch(windowId: number): void
  // History suggestions for what the window's URL bar holds.
  suggestions(windowId: number, input: string, suggestions: HistorySuggestion[]): void
  // A left click at (x, y) in the window's UI, as the user's own would be.
  click(windowId: number, x: number, y: number): void
}

// Sync as the settings page drives it (host/sync/manager.ts).
export interface SyncControl {
  status(): SyncStatus
  setup(server: string): Promise<void>
  join(code: string): Promise<void>
  off(): void
  setScope(scope: { unpinnedTabs: boolean }): void
}

interface Binding {
  workspaceId: string
  activeEntryId?: string
}

const NEW_TAB_URL = 'chrome://newtab/'
const originOf = (url: string): string | undefined => {
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}
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
  // Tabs shown as loading get their state re-read from Chrome now and then,
  // so a missed "complete" can't leave one spinning for good.
  private readonly loadingChecks = new Map<number, ReturnType<typeof setInterval>>()
  // Tabs Grove asked the bridge to create: request id -> what they are for.
  private readonly requests = new Map<string, { entryId?: string; placeholder?: boolean }>()
  private nextRequest = 1
  private pushQueued = false
  // Windows open at start-up whose workspace isn't shown yet, with Chrome's
  // own start-up tabs to drop once it is.
  private readonly startup = new Map<number, number[]>()
  // The last look of an entry a window gave up to another one (a JPEG data URL).
  private readonly snapshots = new Map<string, string>()
  private readonly uiReady = new Set<number>()
  // Permission requests waiting for an answer, oldest first. A window shows
  // the first one its visible tab made.
  private permissions: { id: string; tabId: number; origin: string; topOrigin?: string; kinds: PermissionKind[] }[] = []
  // Chrome's downloads, newest first.
  private downloads: DownloadView[] = []
  // Whether the user has done anything yet this launch (see resume).
  private userActed = false
  // Unloaded entries Chrome can restore whole (back/forward list and all):
  // entry id -> its recently closed session. For this launch only.
  private readonly sessions = new Map<string, string>()
  // When a window last showed each tab (see unloadIdle).
  private readonly shownAt = new Map<number, number>()
  private readonly audible = new Set<number>()
  // Tabs whose page has drawn (or finished loading); see EntryView.painted.
  private readonly painted = new Set<number>()
  readonly history = new HistoryIndex()

  // Told of every change the host makes to the model (sync records them).
  onModelChange?: () => void
  settings?: Settings
  sync?: SyncControl

  private readonly store: Store
  private readonly ui: UiSink
  private readonly log: (...a: unknown[]) => void
  private readonly sitePermissions?: SitePermissions

  constructor(store: Store, ui: UiSink, log: (...a: unknown[]) => void = () => {}, sitePermissions?: SitePermissions) {
    this.store = store
    this.ui = ui
    this.log = log
    this.sitePermissions = sitePermissions
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
        if (tab.status === 'complete') this.painted.add(tab.id)
        // The new-tab page Chrome opens at start-up gives way to the
        // workspace's own tabs, unless the workspace is empty.
        if (isNewTabPage(tab.url) && ws.entries.length) stray.push(tab.id)
        else this.adoptTab(tab)
      }
      this.startup.set(w.id, stray)
    }
    this.downloads = await bridge.call<DownloadView[]>('downloads').catch(() => [])
    void bridge
      .call<HistoryItem[]>('history')
      .then((items) => {
        this.history.load(items)
        this.log(`history: ${this.history.size} pages`)
      })
      .catch((e: unknown) => this.log('history', e))
    setInterval(() => void this.unloadIdle(), 60_000)
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
        return this.onTabCreated(e.tab, e.requestId, e.restoredSession)
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
      case 'permissionRequest':
        this.permissions.push({ id: e.id, tabId: e.tabId, origin: e.origin, topOrigin: e.topOrigin, kinds: e.kinds })
        return this.queuePush()
      case 'download': {
        const rest = this.downloads.filter((d) => d.id !== e.download.id)
        const at = this.downloads.findIndex((d) => d.id === e.download.id)
        if (at < 0) rest.unshift(e.download)
        else rest.splice(at, 0, e.download)
        this.downloads = rest.slice(0, 50)
        return this.queuePush()
      }
      case 'downloadErased':
        this.downloads = this.downloads.filter((d) => d.id !== e.id)
        return this.queuePush()
      case 'tabPainted':
        if (!this.tabWindow.has(e.tabId) || this.painted.has(e.tabId)) return
        this.painted.add(e.tabId)
        return this.queuePush()
      case 'historyVisited':
        return this.history.visit(e.item)
      case 'historyRemoved':
        if (e.all) this.history.clear()
        else this.history.remove(e.urls)
        return
    }
  }

  // Answers a permission request, and the same tab's other requests for
  // the same site that this answer covers.
  private answerPermission(id: string, decision: PermissionDecision): void {
    const answered = this.permissions.find((p) => p.id === id)
    if (!answered) return
    const covered = this.permissions.filter(
      (p) =>
        p === answered ||
        (decision !== 'dismiss' &&
          p.tabId === answered.tabId &&
          p.origin === answered.origin &&
          p.kinds.every((k) => answered.kinds.includes(k)))
    )
    this.permissions = this.permissions.filter((p) => !covered.includes(p))
    this.queuePush()
    void (async () => {
      // Kinds the host keeps are in place before the page's call goes on.
      if (decision !== 'dismiss') {
        const setting = decision === 'allow' ? 'granted' : 'denied'
        for (const kind of answered.kinds.filter(keptByHost)) {
          await this.sitePermissions?.set(answered.origin, kind, setting).catch((e: unknown) => this.log('permission', e))
        }
      }
      for (const p of covered) await this.bridge?.call('answerPermission', { id: p.id, decision }).catch(() => {})
    })()
  }

  // Drops a tab's requests that no longer apply: the tab closed, or left
  // the site that asked.
  private dropPermissions(tabId: number, url?: string): void {
    for (const p of this.permissions) {
      if (p.tabId !== tabId) continue
      if (url !== undefined && originOf(url) === (p.topOrigin ?? p.origin)) continue
      this.answerPermission(p.id, 'dismiss')
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

  private onTabCreated(tab: BridgeTab, requestId?: string, restoredSession?: string): void {
    this.tabWindow.set(tab.id, tab.windowId)
    if (tab.audible) this.audible.add(tab.id)
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
    // Reopened (Ctrl+Shift+T) after Grove unloaded it: its entry's page again.
    const unloadedEntry = restoredSession && [...this.sessions].find(([, s]) => s === restoredSession)?.[0]
    if (unloadedEntry && this.entry(unloadedEntry) && !this.tabOf.has(unloadedEntry)) {
      this.sessions.delete(unloadedEntry)
      this.map(unloadedEntry, tab.id)
      const b = this.bindWindow(tab.windowId)
      if (tab.active && this.shows(b, unloadedEntry)) this.setActive(tab.windowId, b, unloadedEntry)
      // An entry of a workspace this window doesn't show goes back to
      // sleep (after a moment: closing a tab Chrome is still making
      // crashes Webium).
      else if (!this.shows(b, unloadedEntry)) setTimeout(() => void this.settle(unloadedEntry, true), 1000)
      this.queuePush()
      return
    }
    // A new tab of the user's own (Ctrl+T): as with New Tab, there's no tab
    // until the search opens one, so this one goes and the search opens.
    // (A window's only tab stays: something has to show.)
    if (tab.active && isNewTabPage(tab.url) && this.tabsIn(tab.windowId).length > 1) {
      // Back to the page the window showed first, then the search: switching
      // tabs gives the page the keyboard, which would take it from the
      // search. Then close the new tab: closing it while Chrome is still
      // making it crashes Webium.
      const back = this.bindWindow(tab.windowId).activeEntryId
      const backTab = back ? this.tabOf.get(back) : undefined
      const reactivated = backTab !== undefined ? this.bridge!.call('activate', backTab).catch(() => {}) : Promise.resolve()
      void reactivated.then(() => this.ui.openNewTabSearch(tab.windowId))
      setTimeout(() => void this.closeTabs([tab.id]), 500)
      return
    }
    // A tab the user or a page opened: a new entry in that window's workspace,
    // next to the tab that opened it.
    const entry = this.adoptTab(tab)
    const b = this.bindWindow(tab.windowId)
    if (tab.active) this.setActive(tab.windowId, b, entry.id)
    if (tab.active && isNewTabPage(tab.url)) this.ui.focusUrlBar(tab.windowId)
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
    this.shownAt.delete(tabId)
    this.audible.delete(tabId)
    this.painted.delete(tabId)
    this.stopLoading(tabId)
    this.dropPermissions(tabId)
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
    if (tab.audible) this.audible.add(tab.id)
    else this.audible.delete(tab.id)
    if (tab.status === 'loading') this.startLoading(tab.id)
    else this.stopLoading(tab.id)
    // Chrome's own pages run no content scripts to say they painted.
    if (tab.status === 'complete') this.painted.add(tab.id)
    if (tab.url) this.dropPermissions(tab.id, tab.url)
    const entryId = this.entryOf.get(tab.id)
    if (!entryId) return this.queuePush()
    this.update((m) =>
      M.editEntry(m, entryId, (e) => ({
        ...e,
        url: tab.url || e.url,
        title: tab.title || e.title,
        favicon: tab.favIconUrl || e.favicon
      }))
    )
  }

  private startLoading(tabId: number): void {
    this.loading.add(tabId)
    if (this.loadingChecks.has(tabId)) return
    const check = setInterval(() => {
      void this.bridge
        ?.call<BridgeTab | null>('get', tabId)
        .then((tab) => {
          if (!tab) this.stopLoading(tabId)
          else if (tab.status !== 'loading') this.onTabUpdated(tab)
          this.queuePush()
        })
        .catch(() => {})
    }, 5000)
    this.loadingChecks.set(tabId, check)
  }

  private stopLoading(tabId: number): void {
    this.loading.delete(tabId)
    clearInterval(this.loadingChecks.get(tabId))
    this.loadingChecks.delete(tabId)
  }

  private onTabActivated(tabId: number, windowId: number): void {
    const entryId = this.entryOf.get(tabId)
    const b = this.windows.get(windowId)
    if (!entryId || !b) return
    if (!this.shows(b, entryId)) return
    this.setActive(windowId, b, entryId)
    this.queuePush()
  }

  // ---- The UI's side ----

  async command(windowId: number, c: HostCommand): Promise<void> {
    const b = this.bindWindow(windowId)
    if (c.type !== 'hello') this.userActed = true
    switch (c.type) {
      case 'hello':
        this.uiReady.add(windowId)
        this.push(windowId)
        return this.finishStartup(windowId)
      case 'activate':
        return this.activateIn(windowId, c.entryId)
      case 'close':
        return this.closeEntriesEverywhere([c.entryId])
      case 'unload':
        return this.unloadByUser(c.entryId)
      case 'clearTabs': {
        const ws = M.getWorkspace(this.model, b.workspaceId)
        return this.closeEntriesEverywhere(ws.entries.filter((e) => !e.pinned).map((e) => e.id))
      }
      case 'newTab':
        return this.newTab(windowId)
      case 'setPinned':
        if (!M.findEntry(this.model, c.entryId)?.workspace) return this.moveEntry(windowId, c.entryId, { section: 'pinned' })
        return this.editWorkspace(b, (ws) => M.setPinned(ws, c.entryId, c.pinned))
      case 'setEssential':
        return this.moveEntry(windowId, c.entryId, { section: c.essential ? 'essentials' : 'tabs' })
      case 'newFolder':
        return this.editWorkspace(b, (ws) => M.createGroup(ws, [c.entryId])[0])
      case 'toggleFolder':
        return this.editWorkspace(b, (ws) => {
          const g = ws.groups.find((x) => x.id === c.groupId)
          return g ? M.updateGroup(ws, g.id, { collapsed: !g.collapsed }) : ws
        })
      case 'ungroup':
        return this.editWorkspace(b, (ws) => M.ungroup(ws, c.groupId))
      case 'setFolderPinned':
        return this.editWorkspace(b, (ws) => M.setGroupPinned(ws, c.groupId, c.pinned))
      case 'moveEntry':
        return this.moveEntry(windowId, c.entryId, { section: c.section, beforeId: c.beforeId, groupId: c.groupId })
      case 'moveToWorkspace':
        this.update((m) => M.sendToWorkspace(m, c.entryId, c.workspaceId))
        return this.settle(c.entryId)
      case 'moveWorkspace':
        this.update((m) => M.placeWorkspace(m, c.workspaceId, c.beforeId))
        return
      case 'moveFolder':
        return this.editWorkspace(b, (ws) => M.placeGroup(ws, c.groupId, c.beforeId, c.pinned))
      case 'switchWorkspace':
        return this.switchWorkspace(windowId, c.workspaceId)
      case 'newWorkspace': {
        let id!: string
        this.update((m) => ([m, id] = M.createWorkspace(m, c.name, c.color, c.icon))[0])
        return this.switchWorkspace(windowId, id)
      }
      case 'editWorkspace':
        this.update((m) => M.editWorkspace(m, c.workspaceId, { name: c.name, color: c.color, icon: c.icon }))
        return
      case 'answerPermission':
        return this.answerPermission(c.id, c.decision)
      case 'deleteWorkspace':
        return this.deleteWorkspace(c.workspaceId)
      case 'setSettings': {
        const changed = this.settings?.update(c.settings) ?? {}
        if (changed.syncTabs) this.sync?.setScope({ unpinnedTabs: changed.syncTabs === 'all' })
        return this.pushAll()
      }
      case 'syncSetup':
        return this.sync?.setup(c.server)
      case 'syncJoin':
        return this.sync?.join(c.code)
      case 'syncOff':
        return this.sync?.off()
      case 'download':
        return void (await this.bridge?.call('downloadAction', { id: c.id, action: c.action }).catch((e: unknown) => this.log('download', e)))
      case 'clearDownloads':
        return void (await this.bridge?.call('clearDownloads').catch(() => {}))
      case 'suggest':
        return this.ui.suggestions(windowId, c.input, this.history.suggest(c.input))
      case 'open':
        return this.open(windowId, c.url, c.newTab)
      case 'forgetUrl':
        this.history.remove([c.url])
        return void (await this.bridge?.call('forgetUrl', c.url).catch(() => {}))
      case 'claimKeyboard':
        return this.ui.click(windowId, c.x, c.y)
    }
  }

  private editWorkspace(b: Binding, fn: (ws: Workspace) => Workspace): void {
    this.update((m) => M.withWorkspace(m, b.workspaceId, fn))
  }

  private async moveEntry(windowId: number, entryId: string, drop: M.SectionDrop): Promise<void> {
    const b = this.bindWindow(windowId)
    this.update((m) => M.moveTo(m, entryId, b.workspaceId, drop))
    await this.settle(entryId)
  }

  // After an entry changed workspace: windows on another workspace that
  // were showing it move on, and if no window shows its new workspace, its
  // page is unloaded (workspaces no window shows keep no pages).
  // `strayed`: the page is in a window that doesn't show its workspace,
  // so it's unloaded even if another window shows that workspace.
  private async settle(entryId: string, strayed = false): Promise<void> {
    const found = M.findEntry(this.model, entryId)
    if (!found?.workspace) return this.pushAll()
    const home = found.workspace.id
    for (const [windowId, b] of this.windows) {
      if (b.activeEntryId !== entryId || b.workspaceId === home) continue
      await this.afterLoss(windowId)
      if (!b.activeEntryId) await this.showActive(windowId)
    }
    if (strayed || ![...this.windows.values()].some((b) => b.workspaceId === home)) await this.unload([entryId])
    this.pushAll()
  }

  // Windows on the workspace move to a neighbor first, which unloads it.
  private async deleteWorkspace(workspaceId: string): Promise<void> {
    if (this.model.workspaces.length <= 1) return
    const next = M.neighborWorkspace(this.model, workspaceId, -1)
    for (const [windowId, b] of this.windows) {
      if (b.workspaceId === workspaceId) await this.switchWorkspace(windowId, next)
    }
    await this.unloadIfHidden(workspaceId)
    this.update((m) => M.deleteWorkspace(m, workspaceId))
    this.pushAll()
  }

  // Shows an entry in a window: activates its tab here, moves the live page
  // over from another window, or opens a frozen entry.
  async activateIn(windowId: number, entryId: string): Promise<void> {
    const b = this.bindWindow(windowId)
    if (!this.shows(b, entryId)) return
    this.setActive(windowId, b, entryId)
    this.pushAll()
    const bridge = this.bridge!
    const tabId = this.tabOf.get(entryId)
    if (tabId !== undefined) {
      const from = this.tabWindow.get(tabId)!
      if (from === windowId) {
        await bridge.call('activate', tabId)
      } else {
        // The window giving the page up keeps the entry selected, paused.
        const src = this.windows.get(from)
        if (src?.activeEntryId === entryId) await this.pause(from, entryId)
        else await this.keepWindowOpen(from, [tabId])
        this.tabWindow.set(tabId, windowId)
        await bridge.call('move', { tabId, windowId })
      }
    } else {
      const entry = this.entry(entryId)
      if (!entry) return
      if (!(await this.restore(windowId, entryId))) await this.createTab(windowId, entry.url || NEW_TAB_URL, entryId)
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
    // Chrome has made the new tab active (and given its page the keyboard):
    // open the URL bar, as Zen does for a new tab.
    this.ui.focusUrlBar(windowId)
    await this.dropPlaceholders(windowId)
    this.pushAll()
  }

  // Opens a URL bar suggestion of Grove's own: in the window's tab, or in a
  // new tab next to the others, as New Tab's search does.
  private async open(windowId: number, url: string, newTab: boolean): Promise<void> {
    const b = this.bindWindow(windowId)
    const tabId = b.activeEntryId ? this.tabOf.get(b.activeEntryId) : undefined
    if (!newTab && tabId !== undefined && this.tabWindow.get(tabId) === windowId) {
      await this.bridge!.call('navigate', { tabId, url })
      return
    }
    let entry!: Entry
    this.update((m) => M.withWorkspace(m, b.workspaceId, (ws) => ([ws, entry] = M.addEntry(ws, { url, title: url }))[0]))
    this.setActive(windowId, b, entry.id)
    await this.createTab(windowId, url, entry.id)
    await this.dropPlaceholders(windowId)
    this.pushAll()
  }

  private async closeEntriesEverywhere(entryIds: string[]): Promise<void> {
    if (!entryIds.length) return
    const ids = new Set(entryIds)
    const affected = [...this.windows].filter(([, b]) => b.activeEntryId && ids.has(b.activeEntryId)).map(([id]) => id)
    const tabs = entryIds.map((id) => this.tabOf.get(id)).filter((t) => t !== undefined)
    this.closeEntries(entryIds)
    const byWindow = new Map<number, number[]>()
    for (const t of tabs) {
      const w = this.tabWindow.get(t)!
      byWindow.set(w, [...(byWindow.get(w) ?? []), t])
    }
    for (const [windowId, windowTabs] of byWindow) await this.keepWindowOpen(windowId, windowTabs)
    await this.closeTabs(tabs)
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

  // A window is about to give its page to another window: snapshot it, then
  // show a blank placeholder tab under the UI's paused overlay (activated
  // first, so Chrome doesn't pick one of the window's other tabs).
  private async pause(windowId: number, entryId: string): Promise<void> {
    const snapshot = await this.bridge!.call<string | null>('capture', windowId).catch(() => null)
    if (snapshot) this.snapshots.set(entryId, snapshot)
    else this.snapshots.delete(entryId)
    const placeholder = [...this.placeholders].find((t) => this.tabWindow.get(t) === windowId)
    if (placeholder !== undefined) await this.bridge!.call('activate', placeholder)
    else await this.createTab(windowId, 'about:blank', undefined, { placeholder: true, active: true })
  }

  // A window lost the entry it showed (closed, or moved to another window):
  // show its most recent entry that is already open here, without pulling
  // pages from other windows.
  private async afterLoss(windowId: number): Promise<void> {
    const b = this.windows.get(windowId)
    if (!b) return
    const ws = M.getWorkspace(this.model, b.workspaceId)
    const here = [...ws.entries, ...this.model.essentials].filter((e) => {
      const t = this.tabOf.get(e.id)
      return t !== undefined && this.tabWindow.get(t) === windowId && e.id !== b.activeEntryId
    })
    const next = M.mostRecent(here)
    b.activeEntryId = next?.id
    if (next) {
      await this.bridge?.call('activate', this.tabOf.get(next.id))
      await this.dropPlaceholders(windowId)
    }
    this.pushAll()
  }

  // Workspaces no window shows keep no pages.
  private async unloadIfHidden(workspaceId: string): Promise<void> {
    if ([...this.windows.values()].some((b) => b.workspaceId === workspaceId)) return
    const ws = this.model.workspaces.find((w) => w.id === workspaceId)
    await this.unload((ws?.entries ?? []).map((e) => e.id))
  }

  // Closes entries' pages and keeps the entries. Chrome keeps each closed
  // page as a session, which restore() brings back with its back/forward
  // list; the least recently used go first, as Chrome forgets the oldest.
  private async unload(entryIds: string[]): Promise<void> {
    const entries = entryIds
      .flatMap((id) => this.entry(id) ?? [])
      .filter((e) => this.tabOf.has(e.id))
      .sort((a, b) => a.lastActive - b.lastActive)
    if (!entries.length) return
    const tabs = entries.map((e) => this.tabOf.get(e.id)!)
    const entryOfTab = new Map(entries.map((e, i) => [tabs[i], e.id]))
    entries.forEach((e) => this.unmap(e.id))
    const byWindow = new Map<number, number[]>()
    for (const t of tabs) {
      const w = this.tabWindow.get(t)!
      byWindow.set(w, [...(byWindow.get(w) ?? []), t])
    }
    for (const [w, ids] of byWindow) await this.keepWindowOpen(w, ids)
    tabs.forEach((t) => this.closingByHost.add(t))
    const sessions = await this.bridge!.call<Record<string, string>>('unload', tabs).catch((e: unknown) => {
      this.log('unload failed', e)
      return {}
    })
    for (const [tabId, sessionId] of Object.entries(sessions)) {
      const entryId = entryOfTab.get(Number(tabId))
      if (entryId) this.sessions.set(entryId, sessionId)
    }
    this.pushAll()
  }

  // Reopens an unloaded entry's page whole, if Chrome still has it.
  private async restore(windowId: number, entryId: string): Promise<boolean> {
    const sessionId = this.sessions.get(entryId)
    if (!sessionId) return false
    this.sessions.delete(entryId)
    const requestId = `r${this.nextRequest++}`
    this.requests.set(requestId, { entryId })
    const tab = await this.bridge!.call<BridgeTab | null>('restore', { sessionId, windowId, requestId }).catch(() => null)
    if (!tab) this.requests.delete(requestId)
    return !!tab
  }

  // Unload, from the tab's menu. A window showing it moves on to another
  // tab first.
  private async unloadByUser(entryId: string): Promise<void> {
    if (!this.tabOf.has(entryId)) return
    for (const [windowId, b] of this.windows) {
      if (b.activeEntryId !== entryId) continue
      await this.afterLoss(windowId)
      if (b.activeEntryId) continue
      const ws = M.getWorkspace(this.model, b.workspaceId)
      const next = M.mostRecent(ws.entries, entryId)
      // The workspace's only tab stays.
      if (!next) {
        b.activeEntryId = entryId
        return this.pushAll()
      }
      await this.activateIn(windowId, next.id)
    }
    await this.unload([entryId])
  }

  // Unloads tabs no window has shown for the minutes in the settings, but
  // not one playing sound, asking for a permission, or holding text the
  // user typed and hasn't sent.
  private async unloadIdle(): Promise<void> {
    const minutes = this.settings?.get().unloadAfter ?? DEFAULT_SETTINGS.unloadAfter
    if (!this.bridge || this.startup.size) return
    this.noteShown()
    if (!minutes) return
    const now = Date.now()
    const idle: string[] = []
    for (const [entryId, tabId] of this.tabOf) {
      const since = this.shownAt.get(tabId)
      if (since === undefined) this.shownAt.set(tabId, now)
      else if (now - since >= minutes * 60_000 && !this.audible.has(tabId) && !this.permissions.some((p) => p.tabId === tabId)) {
        idle.push(entryId)
      }
    }
    const keep = await Promise.all(idle.map((id) => this.bridge!.call<boolean>('edited', this.tabOf.get(id)).catch(() => true)))
    // Shown again while that was asked.
    const shown = new Set([...this.windows.values()].map((b) => b.activeEntryId))
    const go = idle.filter((id, i) => !keep[i] && !shown.has(id) && this.tabOf.has(id))
    if (!go.length) return
    this.log(`unloading ${go.length} idle tab(s)`)
    await this.unload(go)
  }

  // The tabs windows show now count as just seen.
  private noteShown(): void {
    const now = Date.now()
    for (const b of this.windows.values()) {
      const t = b.activeEntryId ? this.tabOf.get(b.activeEntryId) : undefined
      if (t !== undefined) this.shownAt.set(t, now)
    }
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
    ids.forEach((id) => {
      this.snapshots.delete(id)
      this.sessions.delete(id)
    })
    this.update((m) => M.removeEntries(m, ids))
  }

  // Whether a window on binding `b` shows the entry: its workspace's own,
  // or an Essential.
  private shows(b: Binding, entryId: string): boolean {
    const found = M.findEntry(this.model, entryId)
    return !!found && (!found.workspace || found.workspace.id === b.workspaceId)
  }

  private setActive(_windowId: number, b: Binding, entryId: string): void {
    // The tab the window showed until now was last seen just now.
    const was = b.activeEntryId ? this.tabOf.get(b.activeEntryId) : undefined
    if (was !== undefined) this.shownAt.set(was, Date.now())
    b.activeEntryId = entryId
    if (!M.findEntry(this.model, entryId)?.workspace) {
      // An Essential: the workspace keeps its own last tab.
      const now = Date.now()
      this.update((m) => ({ ...M.editEntry(m, entryId, (e) => ({ ...e, lastActive: now })), lastActiveWorkspaceId: b.workspaceId }))
      return
    }
    this.update((m) => ({
      ...M.withWorkspace(m, b.workspaceId, (ws) => M.activateEntry(ws, entryId)),
      lastActiveWorkspaceId: b.workspaceId
    }))
  }

  private entry(entryId: string): Entry | undefined {
    return M.findEntry(this.model, entryId)?.entry
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
    this.onModelChange?.()
  }

  // ---- Sync ----

  get current(): Model {
    return this.model
  }

  isLive(entryId: string): boolean {
    return this.tabOf.has(entryId)
  }

  // Takes a model with other devices' changes merged in, and brings the
  // windows and Chrome's tabs in line: pages of entries closed elsewhere
  // close, entries moved to another workspace settle, and windows on a
  // workspace that's gone (deleted elsewhere, or merged into the synced one
  // of the same name when this device joined) move on. Windows showing an
  // entry keep showing it.
  async applySynced(next: Model, remap: ReadonlyMap<string, string>): Promise<void> {
    const prev = this.model
    const idsOf = (m: Model) => new Set([...m.essentials, ...m.workspaces.flatMap((w) => w.entries)].map((e) => e.id))
    const kept = idsOf(next)
    const gone = [...idsOf(prev)].filter((id) => !kept.has(id))
    const moved = [...kept].filter((id) => {
      const was = M.findEntry(prev, id)
      return was && was.workspace?.id !== M.findEntry(next, id)!.workspace?.id
    })
    this.model = next
    this.store.save(next)
    const rebound: number[] = []
    for (const [windowId, b] of this.windows) {
      if (next.workspaces.some((w) => w.id === b.workspaceId)) continue
      const to = remap.get(b.workspaceId)
      b.workspaceId = to && next.workspaces.some((w) => w.id === to) ? to : next.lastActiveWorkspaceId
      if (b.activeEntryId && !this.shows(b, b.activeEntryId)) b.activeEntryId = undefined
      rebound.push(windowId)
    }
    this.pushAll()
    if (!this.bridge) return
    await this.started()
    await this.closeEntriesEverywhere(gone)
    for (const id of moved) await this.settle(id)
    for (const windowId of rebound) if (!this.windows.get(windowId)?.activeEntryId) await this.showActive(windowId)
    this.pushAll()
  }

  // Once sync has caught up at launch, if the user was last on another
  // device: unless they've started on something here, the first window
  // goes to the workspace and tab they were on there.
  async resume(workspaceId: string, entryId: string | undefined): Promise<void> {
    if (this.userActed || !this.bridge || this.settings?.get().resume === false) return
    await this.started()
    const windowId = [...this.windows.keys()][0]
    const b = windowId === undefined ? undefined : this.windows.get(windowId)
    if (!b || this.userActed || !this.model.workspaces.some((w) => w.id === workspaceId)) return
    this.log('resuming where the user was on another device')
    await this.switchWorkspace(windowId, workspaceId)
    if (entryId && entryId !== b.activeEntryId && this.shows(b, entryId)) await this.activateIn(windowId, entryId)
  }

  // Until the windows open at launch show their workspaces: their tabs
  // mustn't change while Webium's UI is still loading.
  private async started(): Promise<void> {
    for (let i = 0; i < 100 && this.startup.size; i++) await new Promise((r) => setTimeout(r, 200))
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

  // Something the windows show besides the model changed (sync's status).
  refresh(): void {
    this.queuePush()
  }

  private pushAll(): void {
    this.noteShown()
    for (const id of this.windows.keys()) this.push(id)
  }

  push(windowId: number): void {
    const b = this.windows.get(windowId)
    if (b) this.ui.push(windowId, this.view(windowId, b))
  }

  private pausedIn(windowId: number, b: Binding): WindowState['paused'] {
    const entryId = b.activeEntryId
    const tabId = entryId ? this.tabOf.get(entryId) : undefined
    if (!entryId || tabId === undefined || this.tabWindow.get(tabId) === windowId) return undefined
    return { entryId, title: this.entry(entryId)?.title ?? '', snapshot: this.snapshots.get(entryId) }
  }

  private permissionIn(windowId: number, b: Binding): WindowState['permission'] {
    const tabId = b.activeEntryId ? this.tabOf.get(b.activeEntryId) : undefined
    if (tabId === undefined || this.tabWindow.get(tabId) !== windowId) return undefined
    const p = this.permissions.find((x) => x.tabId === tabId)
    return p && { id: p.id, origin: p.origin, topOrigin: p.topOrigin, kinds: p.kinds }
  }

  private view(windowId: number, b: Binding): WindowState {
    const ws = M.getWorkspace(this.model, b.workspaceId)
    const entryView = (e: Entry): EntryView => {
      const t = this.tabOf.get(e.id)
      return {
        id: e.id,
        title: e.title || e.url,
        url: e.url,
        favicon: e.favicon,
        pinned: e.pinned,
        groupId: e.groupId,
        live: t !== undefined,
        here: t !== undefined && this.tabWindow.get(t) === windowId,
        loading: t !== undefined && this.loading.has(t),
        painted: t !== undefined && this.painted.has(t)
      }
    }
    return {
      windowId,
      workspaces: this.model.workspaces.map(({ id, name, color, icon }) => ({ id, name, color, icon })),
      workspace: {
        id: ws.id,
        name: ws.name,
        color: ws.color,
        icon: ws.icon,
        groups: ws.groups,
        entries: ws.entries.map(entryView)
      },
      essentials: this.model.essentials.map(entryView),
      activeEntryId: b.activeEntryId,
      paused: this.pausedIn(windowId, b),
      permission: this.permissionIn(windowId, b),
      settings: this.settings?.get() ?? DEFAULT_SETTINGS,
      sync: this.sync?.status() ?? { state: 'off', pending: 0 },
      downloads: this.downloads
    }
  }
}
