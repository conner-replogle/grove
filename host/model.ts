// Pure operations on the workspace model. Every function returns a new
// model or workspace and never mutates its input, so the service can diff,
// the store can save snapshots and the tests need no Electron.
import { randomUUID } from 'node:crypto'
import { COLORS, type Color, type Entry, type Group, type Model, type MoveTarget, type Workspace } from '../shared/types.ts'

export const newId = (): string => randomUUID()

// ---- Model and workspaces ----

export function emptyModel(): Model {
  const home = newWorkspace('Home', 'green')
  return { version: 1, workspaces: [home], lastActiveWorkspaceId: home.id }
}

function newWorkspace(name: string, color: Color): Workspace {
  return { id: newId(), name, color, entries: [], groups: [] }
}

export function getWorkspace(model: Model, id: string): Workspace {
  const ws = model.workspaces.find((w) => w.id === id)
  if (!ws) throw new Error(`no workspace ${id}`)
  return ws
}

// Applies `fn` to one workspace and normalizes the result.
export function withWorkspace(model: Model, id: string, fn: (ws: Workspace) => Workspace): Model {
  getWorkspace(model, id)
  return {
    ...model,
    workspaces: model.workspaces.map((w) => (w.id === id ? normalize(fn(w)) : w))
  }
}

function nextColor(used: Color[]): Color {
  return COLORS.find((c) => !used.includes(c)) ?? COLORS[used.length % COLORS.length]
}

export function createWorkspace(model: Model, name?: string, color?: Color): [Model, string] {
  const ws = newWorkspace(
    name?.trim() || `Workspace ${model.workspaces.length + 1}`,
    color ?? nextColor(model.workspaces.map((w) => w.color))
  )
  return [{ ...model, workspaces: [...model.workspaces, ws] }, ws.id]
}

export function renameWorkspace(model: Model, id: string, name: string): Model {
  const trimmed = name.trim()
  if (!trimmed) return model
  return withWorkspace(model, id, (ws) => ({ ...ws, name: trimmed }))
}

export function recolorWorkspace(model: Model, id: string, color: Color): Model {
  return withWorkspace(model, id, (ws) => ({ ...ws, color }))
}

export function moveWorkspace(model: Model, id: string, toIndex: number): Model {
  const ws = getWorkspace(model, id)
  const rest = model.workspaces.filter((w) => w.id !== id)
  const index = clamp(toIndex, 0, rest.length)
  return { ...model, workspaces: [...rest.slice(0, index), ws, ...rest.slice(index)] }
}

// The last workspace can't be deleted. Its tabs go with it.
export function deleteWorkspace(model: Model, id: string): Model {
  if (model.workspaces.length <= 1) return model
  const index = model.workspaces.findIndex((w) => w.id === id)
  if (index < 0) return model
  const workspaces = model.workspaces.filter((w) => w.id !== id)
  const lastActiveWorkspaceId =
    model.lastActiveWorkspaceId === id
      ? workspaces[Math.min(index, workspaces.length - 1)].id
      : model.lastActiveWorkspaceId
  return { ...model, workspaces, lastActiveWorkspaceId }
}

// The workspace `offset` places away from `id`, wrapping around.
export function neighborWorkspace(model: Model, id: string, offset: number): string {
  const n = model.workspaces.length
  const index = model.workspaces.findIndex((w) => w.id === id)
  return model.workspaces[(((index + offset) % n) + n) % n].id
}

// ---- Entries (tabs) ----

export interface NewEntry {
  url: string
  title?: string
  history?: Entry['history']
  historyIndex?: number
}

export interface Placement {
  // Index in `entries` to insert at; default: after `afterId`, else the end.
  index?: number
  afterId?: string
  pinned?: boolean
  groupId?: string
}

export function addEntry(ws: Workspace, init: NewEntry, place: Placement = {}): [Workspace, Entry] {
  const after = place.afterId ? ws.entries.find((e) => e.id === place.afterId) : undefined
  const entry: Entry = {
    id: newId(),
    url: init.url,
    title: init.title ?? '',
    pinned: place.pinned ?? false,
    groupId: place.groupId ?? (after && !place.pinned ? after.groupId : undefined),
    history: init.history ?? [],
    historyIndex: init.historyIndex ?? -1,
    lastActive: 0
  }
  let index = place.index ?? ws.entries.length
  if (place.index === undefined && after) index = ws.entries.indexOf(after) + 1
  const entries = [...ws.entries]
  entries.splice(clamp(index, 0, entries.length), 0, entry)
  const next = normalize({ ...ws, entries })
  return [next, next.entries.find((e) => e.id === entry.id)!]
}

export function closeEntries(ws: Workspace, ids: string[]): Workspace {
  const gone = new Set(ids)
  const entries = ws.entries.filter((e) => !gone.has(e.id))
  let activeEntryId = ws.activeEntryId
  if (activeEntryId && gone.has(activeEntryId)) activeEntryId = mostRecent(entries)?.id
  return normalize({ ...ws, entries, activeEntryId })
}

export function closeEntry(ws: Workspace, id: string): Workspace {
  return closeEntries(ws, [id])
}

// The most recently active entry, other than `excludeId`.
export function mostRecent(entries: Entry[], excludeId?: string): Entry | undefined {
  let best: Entry | undefined
  for (const e of entries) {
    if (e.id === excludeId) continue
    if (!best || e.lastActive > best.lastActive) best = e
  }
  return best
}

export function activateEntry(ws: Workspace, id: string, now = Date.now()): Workspace {
  return {
    ...ws,
    activeEntryId: id,
    entries: ws.entries.map((e) => (e.id === id ? { ...e, lastActive: now } : e))
  }
}

export type EntryPatch = Partial<
  Pick<Entry, 'url' | 'title' | 'favicon' | 'history' | 'historyIndex'>
>

export function updateEntry(ws: Workspace, id: string, patch: EntryPatch): Workspace {
  return { ...ws, entries: ws.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)) }
}

export function moveEntry(ws: Workspace, id: string, to: MoveTarget): Workspace {
  const entry = ws.entries.find((e) => e.id === id)
  if (!entry) return ws
  const rest = ws.entries.filter((e) => e.id !== id)
  const moved = { ...entry, pinned: to.pinned, groupId: to.pinned ? undefined : to.groupId }
  rest.splice(clamp(to.index, 0, rest.length), 0, moved)
  return normalize({ ...ws, entries: rest })
}

// Where a dragged entry lands: just before `beforeId`, or at the end of its
// section (the pinned tabs, the folder `groupId`, or the whole list).
export interface Drop {
  beforeId?: string
  pinned: boolean
  groupId?: string
}

export function placeEntry(ws: Workspace, id: string, to: Drop): Workspace {
  if (to.beforeId === id || !ws.entries.some((e) => e.id === id)) return ws
  const rest = ws.entries.filter((e) => e.id !== id)
  let index = to.beforeId ? rest.findIndex((e) => e.id === to.beforeId) : -1
  if (index < 0) {
    if (to.pinned) index = rest.filter((e) => e.pinned).length
    else if (to.groupId) index = rest.findLastIndex((e) => e.groupId === to.groupId) + 1 || rest.length
    else index = rest.length
  }
  return moveEntry(ws, id, { index, pinned: to.pinned, groupId: to.pinned ? undefined : to.groupId })
}

// Moves a whole folder to just before `beforeId` (an entry outside it), or
// to the end of the list.
export function placeGroup(ws: Workspace, groupId: string, beforeId?: string): Workspace {
  const members = ws.entries.filter((e) => e.groupId === groupId)
  if (!members.length || members.some((e) => e.id === beforeId)) return ws
  const rest = ws.entries.filter((e) => e.groupId !== groupId)
  const at = beforeId ? rest.findIndex((e) => e.id === beforeId) : -1
  rest.splice(at < 0 ? rest.length : at, 0, ...members)
  return normalize({ ...ws, entries: rest })
}

// Pinning puts the entry at the end of the pinned tabs; unpinning at the
// start of the others.
export function setPinned(ws: Workspace, id: string, pinned: boolean): Workspace {
  const entry = ws.entries.find((e) => e.id === id)
  if (!entry || entry.pinned === pinned) return ws
  const pinnedCount = ws.entries.filter((e) => e.pinned && e.id !== id).length
  return moveEntry(ws, id, { index: pinnedCount, pinned })
}

// ---- Groups (folders) ----

export function createGroup(
  ws: Workspace,
  entryIds: string[],
  title = 'New Folder',
  color?: Color
): [Workspace, string] {
  const group: Group = {
    id: newId(),
    title,
    color: color ?? nextColor(ws.groups.map((g) => g.color)),
    collapsed: false
  }
  const members = new Set(entryIds)
  // The folder takes the place of its first member.
  const first = ws.entries.findIndex((e) => members.has(e.id))
  if (first < 0) return [ws, group.id]
  const moved = ws.entries
    .filter((e) => members.has(e.id))
    .map((e) => ({ ...e, pinned: false, groupId: group.id }))
  const rest = ws.entries.filter((e) => !members.has(e.id))
  const at = ws.entries.slice(0, first).filter((e) => !members.has(e.id)).length
  rest.splice(at, 0, ...moved)
  return [normalize({ ...ws, groups: [...ws.groups, group], entries: rest }), group.id]
}

export type GroupPatch = Partial<Pick<Group, 'title' | 'color' | 'collapsed'>>

export function updateGroup(ws: Workspace, id: string, patch: GroupPatch): Workspace {
  if (patch.title !== undefined && !patch.title.trim()) return ws
  return { ...ws, groups: ws.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)) }
}

// Removes the folder but keeps its tabs where they are.
export function ungroup(ws: Workspace, id: string): Workspace {
  return normalize({
    ...ws,
    groups: ws.groups.filter((g) => g.id !== id),
    entries: ws.entries.map((e) => (e.groupId === id ? { ...e, groupId: undefined } : e))
  })
}

// Moves an entry into a folder (at its end) or out of one (just below it).
export function setEntryGroup(ws: Workspace, id: string, groupId: string | undefined): Workspace {
  const entry = ws.entries.find((e) => e.id === id)
  if (!entry || entry.groupId === groupId) return ws
  const rest = ws.entries.filter((e) => e.id !== id)
  const anchorGroup = groupId ?? entry.groupId
  const lastInGroup = rest.findLastIndex((e) => e.groupId === anchorGroup)
  const index = lastInGroup >= 0 ? lastInGroup + 1 : rest.length
  return moveEntry(ws, id, { index, pinned: false, groupId })
}

export function groupEntryIds(ws: Workspace, groupId: string): string[] {
  return ws.entries.filter((e) => e.groupId === groupId).map((e) => e.id)
}

// ---- Invariants ----

// Pinned entries come first and are never in a folder; a folder's entries
// sit together at the place of its first entry; empty folders, unknown
// folder ids and a dangling active id are dropped.
export function normalize(ws: Workspace): Workspace {
  const groupIds = new Set(ws.groups.map((g) => g.id))
  const clean = ws.entries.map((e) => {
    const groupId = e.pinned || !e.groupId || !groupIds.has(e.groupId) ? undefined : e.groupId
    return groupId === e.groupId ? e : { ...e, groupId }
  })

  const pinned = clean.filter((e) => e.pinned)
  const unpinned: Entry[] = []
  const placed = new Set<string>()
  for (const e of clean) {
    if (e.pinned) continue
    if (!e.groupId) unpinned.push(e)
    else if (!placed.has(e.groupId)) {
      placed.add(e.groupId)
      unpinned.push(...clean.filter((m) => !m.pinned && m.groupId === e.groupId))
    }
  }
  const entries = [...pinned, ...unpinned]

  const used = new Set(entries.map((e) => e.groupId).filter(Boolean))
  const groups = ws.groups.filter((g) => used.has(g.id))
  const activeEntryId = entries.some((e) => e.id === ws.activeEntryId)
    ? ws.activeEntryId
    : undefined

  const same =
    entries.length === ws.entries.length &&
    entries.every((e, i) => e === ws.entries[i]) &&
    groups.length === ws.groups.length &&
    activeEntryId === ws.activeEntryId
  return same ? ws : { ...ws, entries, groups, activeEntryId }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

// ---- Across workspaces ----

// Moves an entry to the end of another workspace, keeping its pin but not
// its folder.
export function transferEntry(model: Model, entryId: string, fromId: string, toId: string): Model {
  if (fromId === toId) return model
  const entry = getWorkspace(model, fromId).entries.find((e) => e.id === entryId)
  if (!entry) return model
  const moved = { ...entry, groupId: undefined }
  const without = withWorkspace(model, fromId, (ws) => closeEntry(ws, entryId))
  return withWorkspace(without, toId, (ws) => ({ ...ws, entries: [...ws.entries, moved] }))
}

// The workspace holding an entry, if any.
export function workspaceOfEntry(model: Model, entryId: string): Workspace | undefined {
  return model.workspaces.find((w) => w.entries.some((e) => e.id === entryId))
}
