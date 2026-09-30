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
}

export interface WorkspaceSummary {
  id: string
  name: string
  color: WorkspaceColor
  icon?: string
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
}

export type HostCommand =
  | { type: 'hello' }
  | { type: 'activate'; entryId: string }
  | { type: 'close'; entryId: string }
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

// The page-side names the launcher installs and calls.
export const UI_BINDING = 'groveHostCall'
export const UI_RECEIVER = '__groveHost'
