// The canonical workspace model from docs/design/shared-tabs-and-workspaces.md
// (conner-replogle/grove), as stored in the profile's grove-workspaces.json.
// Ported from the Electron prototype (grove-electron).

export const COLORS = [
  'green',
  'blue',
  'purple',
  'pink',
  'red',
  'orange',
  'yellow',
  'gray'
] as const
export type Color = (typeof COLORS)[number]
// A workspace's color, which themes its windows: a named one or any
// '#rrggbb' picked in the workspace editor.
export type WorkspaceColor = Color | `#${string}`
export const isWorkspaceColor = (c: unknown): c is WorkspaceColor =>
  COLORS.includes(c as Color) || (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c))

// One page of a tab's back/forward list, as Electron's
// navigationHistory.getAllEntries() returns it.
export interface HistoryEntry {
  url: string
  title: string
  pageState?: string
}

export interface Entry {
  id: string
  url: string
  title: string
  favicon?: string
  pinned: boolean
  groupId?: string
  // Back/forward list for restoring a frozen tab; empty until it has loaded.
  history: HistoryEntry[]
  historyIndex: number
  lastActive: number
}

// A folder of tabs. Its entries sit next to each other in the tab order.
// A pinned folder sits among the workspace's pins, and so do its tabs.
export interface Group {
  id: string
  title: string
  color: Color
  collapsed: boolean
  pinned?: boolean
}

export interface Workspace {
  id: string
  name: string
  color: WorkspaceColor
  // A Lucide icon name from the workspace icon set, or an emoji.
  icon?: string
  // Tab order: pinned entries first, then the rest.
  entries: Entry[]
  groups: Group[]
  activeEntryId?: string
}

export interface Model {
  version: 1
  workspaces: Workspace[]
  // Zen's Essentials: pinned pages every workspace shares. Workspace pins
  // (entries with `pinned`) belong to their workspace only.
  essentials: Entry[]
  lastActiveWorkspaceId: string
}

// Where an entry sits: the shared Essentials, its workspace's pins, or
// its workspace's other tabs.
export type Section = 'essentials' | 'pinned' | 'tabs'

// Where a dragged entry lands: an index among the other entries, plus the
// section and folder it joins.
export interface MoveTarget {
  index: number
  pinned: boolean
  groupId?: string
}
