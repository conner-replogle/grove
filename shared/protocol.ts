// What the Grove host and the UI in each window say to each other.
// The host pushes a WindowState whenever anything a window shows changes;
// the UI sends HostCommands and keeps no state of its own.
import type { Color, Group } from './types.ts'

export interface EntryView {
  id: string
  title: string
  url: string
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
  color: Color
}

export interface WindowState {
  windowId: number
  workspaces: WorkspaceSummary[]
  workspace: WorkspaceSummary & { entries: EntryView[]; groups: Group[] }
  activeEntryId?: string
}

export type HostCommand =
  | { type: 'hello' }
  | { type: 'activate'; entryId: string }
  | { type: 'close'; entryId: string }
  | { type: 'newTab' }
  | { type: 'setPinned'; entryId: string; pinned: boolean }
  | { type: 'newFolder'; entryId: string }
  | { type: 'toggleFolder'; groupId: string }
  | { type: 'ungroup'; groupId: string }
  | { type: 'switchWorkspace'; workspaceId: string }
  | { type: 'newWorkspace' }
  | { type: 'renameWorkspace'; workspaceId: string; name: string }

// The page-side names the launcher installs and calls.
export const UI_BINDING = 'groveHostCall'
export const UI_RECEIVER = '__groveHost'
