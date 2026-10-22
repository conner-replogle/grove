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

// Zen's split view: up to MAX_SPLIT tabs shown side by side. A leaf is
// one tab's pane; a node lays its children out in a row or a column.
// `size` is the percent of the parent's width (in a row) or height (in a
// column) a child takes; siblings' sizes add up to 100. A node always has
// two or more children, none with its own direction.
export type SplitNode = SplitLeaf | SplitBranch
export interface SplitLeaf {
  entryId: string
  size: number
}
export interface SplitBranch {
  direction: 'row' | 'column'
  size: number
  children: SplitNode[]
}
export interface Split {
  id: string
  layout: SplitNode
}
// Zen's three layouts: side by side, stacked, and a grid of pairs.
export type SplitLayout = 'vsep' | 'hsep' | 'grid'
// Where a pane goes next to another: its side of that pane.
export type SplitSide = 'left' | 'right' | 'top' | 'bottom'
export const MAX_SPLIT = 4

export interface Workspace {
  id: string
  name: string
  color: WorkspaceColor
  // A Lucide icon name from the workspace icon set, or an emoji.
  icon?: string
  // Tab order: pinned entries first, then the rest.
  entries: Entry[]
  groups: Group[]
  // Tabs shown together. A split's tabs sit next to each other in the tab
  // order, in the same section and folder; Essentials are never split.
  splits?: Split[]
  activeEntryId?: string
  // A blank window's own tabs (Zen's New Blank Window): not one of the
  // user's workspaces. It has no pins, folders or Essentials, is never
  // saved or synced, and goes when its window closes.
  blank?: true
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
