// What the Grove host and the UI in each window say to each other.
// The host pushes a WindowState whenever anything a window shows changes;
// the UI sends HostCommands and keeps no state of its own.
import type { Group, Section, WorkspaceColor } from './types.ts'

export interface EntryView {
  id: string
  title: string
  url: string
  // The page's own icon URL, once Chrome has seen it.
  favicon?: string
  pinned: boolean
  groupId?: string
  // Open as a Chrome tab somewhere (in this window or another).
  live: boolean
  // Open in this window specifically.
  here: boolean
  loading: boolean
  // Its page has drawn something (or finished loading). Until then the
  // window covers the page's empty, see-through surface.
  painted: boolean
}

export interface WorkspaceSummary {
  id: string
  name: string
  color: WorkspaceColor
  icon?: string
}

// What a site can ask for through Grove's permission prompt. The first
// five are kept as Chrome's site settings by the bridge extension; the rest
// Chrome's extension API can't set, so the host keeps them and applies them
// over DevTools (host/site-permissions.ts).
export const PERMISSION_KINDS = [
  'notifications',
  'geolocation',
  'camera',
  'microphone',
  'clipboard',
  'cameraPanTiltZoom',
  'midi',
  'midiSysex',
  'idleDetection',
  'windowManagement',
  'localFonts',
  'storageAccess',
  'localNetwork'
] as const
export type PermissionKind = (typeof PERMISSION_KINDS)[number]
export type PermissionDecision = 'allow' | 'block' | 'dismiss'

export interface PermissionRequest {
  id: string
  // The site asking: the tab's top-level origin, or for storage access the
  // embedded site's (whose cookies on `topOrigin` it wants).
  origin: string
  topOrigin?: string
  kinds: PermissionKind[]
}

// Grove's own settings (<profile>/grove-settings.json).
export interface GroveSettings {
  // Sync every tab ('all'), or only workspaces, the Essentials, pins and
  // pinned folders ('pinned'): this device's other tabs stay here, and
  // other devices' don't come here.
  syncTabs: 'all' | 'pinned'
  // At launch, go to the workspace and tab last used on another device.
  resume: boolean
  // Unload a tab no window has shown for this many minutes (0: never).
  unloadAfter: number
}
export const DEFAULT_SETTINGS: GroveSettings = { syncTabs: 'all', resume: true, unloadAfter: 20 }
export const UNLOAD_CHOICES = [0, 5, 10, 20, 30, 60, 120]

export interface SyncStatus {
  // 'off': not set up. 'error': the server turned this device away.
  state: 'off' | 'connecting' | 'online' | 'offline' | 'error'
  server?: string
  // What's synced now.
  counts?: { workspaces: number; tabs: number; folders: number }
  // Changes made here the server doesn't have yet.
  pending: number
  lastSync?: number
  // Joins another device to this sync: '<server>#<secret>'.
  code?: string
  // A setup or join under way, and what went wrong with the last one.
  busy?: 'setup' | 'join'
  error?: string
}

// A download, as the sidebar's downloads panel shows it (newest first).
export interface DownloadView {
  id: number
  // The file's name (not its folder), or what the URL says until Chrome
  // has picked one.
  name: string
  url: string
  state: 'in_progress' | 'interrupted' | 'complete'
  paused: boolean
  canResume: boolean
  received: number
  // 0 when unknown.
  total: number
  // Whether the file is still where it was saved.
  exists: boolean
  error?: string
  startTime: string
  // The system's icon for the file, as a data URL.
  icon?: string
}
export type DownloadAction = 'open' | 'show' | 'pause' | 'resume' | 'cancel' | 'retry' | 'remove'

// A newer Grove release (host/updates.ts).
export interface UpdateStatus {
  // 'available': a newer release is out; 'downloading': installing it;
  // 'ready': installed, runs once Grove restarts; 'error': installing failed.
  state: 'none' | 'available' | 'downloading' | 'ready' | 'error'
  current: string
  version?: string
  notes?: string
  url?: string
  error?: string
  // This copy was installed (install.sh or an update) and can update itself;
  // a checkout run with pnpm dev can't.
  installed: boolean
}

export interface WindowState {
  windowId: number
  workspaces: WorkspaceSummary[]
  workspace: WorkspaceSummary & { entries: EntryView[]; groups: Group[] }
  // Shared by every workspace.
  essentials: EntryView[]
  // The window's entry is showing in another window: this one keeps it
  // selected, greyed out over a snapshot of how it last looked here.
  paused?: { entryId: string; title: string; snapshot?: string }
  activeEntryId?: string
  // A permission the page this window shows is asking for.
  permission?: PermissionRequest
  settings: GroveSettings
  sync: SyncStatus
  downloads: DownloadView[]
  update?: UpdateStatus
}

export type HostCommand =
  | { type: 'hello' }
  | { type: 'activate'; entryId: string }
  | { type: 'close'; entryId: string }
  // Closes an entry's page and keeps the entry; selecting it reopens it.
  | { type: 'unload'; entryId: string }
  // Closes the window's workspace's tabs, all but its pins (Zen's Clear).
  | { type: 'clearTabs' }
  | { type: 'newTab' }
  | { type: 'setPinned'; entryId: string; pinned: boolean }
  | { type: 'setEssential'; entryId: string; essential: boolean }
  | { type: 'newFolder'; entryId: string }
  | { type: 'toggleFolder'; groupId: string }
  | { type: 'ungroup'; groupId: string }
  | { type: 'setFolderPinned'; groupId: string; pinned: boolean }
  // Drag and drop: `beforeId` is the entry the dragged one lands in front
  // of; without it, the end of the section (or of the folder `groupId`).
  | { type: 'moveEntry'; entryId: string; section: Section; beforeId?: string; groupId?: string }
  // `pinned`: the section the folder lands in.
  | { type: 'moveFolder'; groupId: string; beforeId?: string; pinned: boolean }
  | { type: 'moveToWorkspace'; entryId: string; workspaceId: string }
  | { type: 'moveWorkspace'; workspaceId: string; beforeId?: string }
  | { type: 'switchWorkspace'; workspaceId: string }
  | { type: 'newWorkspace'; name?: string; color?: WorkspaceColor; icon?: string }
  | { type: 'editWorkspace'; workspaceId: string; name?: string; color?: WorkspaceColor; icon?: string }
  | { type: 'deleteWorkspace'; workspaceId: string }
  | { type: 'answerPermission'; id: string; decision: PermissionDecision }
  | { type: 'setSettings'; settings: Partial<GroveSettings> }
  // Starts a new sync account on a server, or joins one with a sync code.
  | { type: 'syncSetup'; server: string }
  | { type: 'syncJoin'; code: string }
  | { type: 'syncOff' }
  | { type: 'download'; id: number; action: DownloadAction }
  // Takes finished and failed downloads off the list (the files stay).
  | { type: 'clearDownloads' }
  // The URL bar's text changed: the host answers with history suggestions
  // (UiSink.suggestions).
  | { type: 'suggest'; input: string }
  // Opens one of those suggestions, in this tab or a new one.
  | { type: 'open'; url: string; newTab: boolean }
  // Takes a suggestion's page out of history (its remove button).
  | { type: 'forgetUrl'; url: string }
  // The URL bar opened without a click (New Tab from the keyboard, a new
  // tab's page): the host clicks the field at (x, y), which moves Chrome's
  // keyboard focus from the page to the window's UI. Focusing the field
  // from script doesn't.
  | { type: 'claimKeyboard'; x: number; y: number }
  // Updates: install the release on offer, then restart into it.
  | { type: 'installUpdate' }
  | { type: 'restartForUpdate' }
  | { type: 'dismissUpdate' }

// A history suggestion for the URL bar (host/history-index.ts).
export interface HistorySuggestion {
  url: string
  title: string
  // What the URL bar shows for it; an autofill's starts with what was typed.
  text: string
  autofill: boolean
}

// The page-side names the launcher installs and calls.
export const UI_BINDING = 'groveHostCall'
export const UI_RECEIVER = '__groveHost'
