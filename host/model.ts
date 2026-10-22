// Pure operations on the workspace model. Every function returns a new
// model or workspace and never mutates its input, so the service can diff,
// the store can save snapshots and the tests need no Electron.
import { randomUUID } from 'node:crypto'
import { COLORS, MAX_SPLIT, type Color, type Entry, type Group, type Model, type MoveTarget, type Section, type Split, type SplitLayout, type SplitNode, type SplitSide, type Workspace, type WorkspaceColor } from '../shared/types.ts'
import { insertPane, layoutTree, leaves, swapPanes, tidy } from './split.ts'

export const newId = (): string => randomUUID()

// ---- Model and workspaces ----

export function emptyModel(): Model {
  const home = newWorkspace('Home', 'green')
  return { version: 1, workspaces: [home], essentials: [], lastActiveWorkspaceId: home.id }
}

function newWorkspace(name: string, color: WorkspaceColor): Workspace {
  return { id: newId(), name, color, entries: [], groups: [] }
}

// Zen's blank windows are indigo; private ones, purple.
export const BLANK_COLOR = '#6366f1'
export const PRIVATE_COLOR = '#8b3fd9'

// A blank window's workspace (see Workspace.blank), or a private window's.
export function createBlankWorkspace(model: Model, isPrivate = false): [Model, string] {
  const ws: Workspace = isPrivate
    ? { ...newWorkspace('Private', PRIVATE_COLOR), blank: true, private: true }
    : { ...newWorkspace('Blank Window', BLANK_COLOR), blank: true }
  return [{ ...model, workspaces: [...model.workspaces, ws] }, ws.id]
}

// The user's workspaces: all but blank windows'.
export const realWorkspaces = (model: Model): Workspace[] => model.workspaces.filter((w) => !w.blank)

// The model as it's saved and synced: without blank windows' workspaces.
export function withoutBlank(model: Model): Model {
  return model.workspaces.some((w) => w.blank) ? { ...model, workspaces: realWorkspaces(model) } : model
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

function nextColor(used: string[]): Color {
  return COLORS.find((c) => !used.includes(c)) ?? COLORS[used.length % COLORS.length]
}

export function createWorkspace(model: Model, name?: string, color?: WorkspaceColor, icon?: string): [Model, string] {
  const real = realWorkspaces(model)
  const ws = newWorkspace(name?.trim() || `Workspace ${real.length + 1}`, color ?? nextColor(real.map((w) => w.color)))
  if (icon?.trim()) ws.icon = icon.trim()
  // Before blank windows' workspaces, which come last.
  return [{ ...model, workspaces: [...real, ws, ...model.workspaces.filter((w) => w.blank)] }, ws.id]
}

export interface WorkspacePatch {
  name?: string
  color?: WorkspaceColor
  icon?: string
}

// Changes a workspace's name, color or icon; an empty name is ignored and
// an empty icon goes back to the default.
export function editWorkspace(model: Model, id: string, patch: WorkspacePatch): Model {
  return withWorkspace(model, id, (ws) => {
    const next = { ...ws }
    if (patch.name?.trim()) next.name = patch.name.trim()
    if (patch.color) next.color = patch.color
    if (patch.icon !== undefined) {
      if (patch.icon.trim()) next.icon = patch.icon.trim()
      else delete next.icon
    }
    return next
  })
}

export function renameWorkspace(model: Model, id: string, name: string): Model {
  const trimmed = name.trim()
  if (!trimmed) return model
  return withWorkspace(model, id, (ws) => ({ ...ws, name: trimmed }))
}

export function recolorWorkspace(model: Model, id: string, color: WorkspaceColor): Model {
  return withWorkspace(model, id, (ws) => ({ ...ws, color }))
}

export function moveWorkspace(model: Model, id: string, toIndex: number): Model {
  const ws = getWorkspace(model, id)
  const rest = model.workspaces.filter((w) => w.id !== id)
  const index = clamp(toIndex, 0, rest.length)
  return { ...model, workspaces: [...rest.slice(0, index), ws, ...rest.slice(index)] }
}

// The last workspace can't be deleted. Its tabs go with it. (A blank
// window's goes whenever its window closes.)
export function deleteWorkspace(model: Model, id: string): Model {
  const real = realWorkspaces(model)
  const index = real.findIndex((w) => w.id === id)
  if (index < 0) return { ...model, workspaces: model.workspaces.filter((w) => w.id !== id) }
  if (real.length <= 1) return model
  const rest = real.filter((w) => w.id !== id)
  const lastActiveWorkspaceId =
    model.lastActiveWorkspaceId === id ? rest[Math.min(index, rest.length - 1)].id : model.lastActiveWorkspaceId
  return { ...model, workspaces: model.workspaces.filter((w) => w.id !== id), lastActiveWorkspaceId }
}

// The workspace `offset` places away from `id`, wrapping around (blank
// windows' aside).
export function neighborWorkspace(model: Model, id: string, offset: number): string {
  const real = realWorkspaces(model)
  const n = real.length
  const index = real.findIndex((w) => w.id === id)
  return real[(((index + offset) % n) + n) % n].id
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
  const moved = { ...entry, pinned: to.pinned, groupId: to.groupId }
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
    if (to.groupId) index = rest.findLastIndex((e) => e.groupId === to.groupId) + 1 || rest.length
    else if (to.pinned) index = rest.filter((e) => e.pinned).length
    else index = rest.length
  }
  return moveEntry(ws, id, { index, pinned: to.pinned, groupId: to.groupId })
}

// Moves a whole folder to just before `beforeId` (an entry outside it), or
// to the end of its section: the pins if `pinned` (default: where it is
// now), else the whole list.
export function placeGroup(ws: Workspace, groupId: string, beforeId?: string, pinned?: boolean): Workspace {
  const group = ws.groups.find((g) => g.id === groupId)
  const members = ws.entries.filter((e) => e.groupId === groupId)
  if (!group || !members.length || members.some((e) => e.id === beforeId)) return ws
  const inPins = pinned ?? !!group.pinned
  const rest = ws.entries.filter((e) => e.groupId !== groupId)
  let at = beforeId ? rest.findIndex((e) => e.id === beforeId) : -1
  if (at < 0) at = inPins ? rest.filter((e) => e.pinned).length : rest.length
  rest.splice(at, 0, ...members.map((e) => (e.pinned === inPins ? e : { ...e, pinned: inPins })))
  const groups = ws.groups.map((g) => (g.id === groupId ? { ...g, pinned: inPins } : g))
  return normalize({ ...ws, groups, entries: rest })
}

// Pins a folder (to the end of the pins) or unpins it (to the start of the
// other tabs), tabs and all.
export function setGroupPinned(ws: Workspace, groupId: string, pinned: boolean): Workspace {
  const group = ws.groups.find((g) => g.id === groupId)
  if (!group || !!group.pinned === pinned) return ws
  const firstTab = ws.entries.find((e) => !e.pinned && e.groupId !== groupId)?.id
  return placeGroup(ws, groupId, pinned ? undefined : firstTab, pinned)
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
  const members = new Set(entryIds)
  // The folder takes the place of its first member, and its pin.
  const first = ws.entries.findIndex((e) => members.has(e.id))
  const group: Group = {
    id: newId(),
    title,
    color: color ?? nextColor(ws.groups.map((g) => g.color)),
    collapsed: false,
    pinned: ws.entries[first]?.pinned ?? false
  }
  if (first < 0) return [ws, group.id]
  const moved = ws.entries
    .filter((e) => members.has(e.id))
    .map((e) => ({ ...e, pinned: group.pinned!, groupId: group.id }))
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
  const pinned = !!ws.groups.find((g) => g.id === anchorGroup)?.pinned
  return moveEntry(ws, id, { index, pinned, groupId })
}

export function groupEntryIds(ws: Workspace, groupId: string): string[] {
  return ws.entries.filter((e) => e.groupId === groupId).map((e) => e.id)
}

// ---- Invariants ----

// Pinned entries come first; an entry in a folder is pinned just when its
// folder is; a folder's entries sit together at the place of its first
// entry; empty folders, unknown folder ids and a dangling active id are
// dropped.
export function normalize(ws: Workspace): Workspace {
  const pinnedGroups = new Map(ws.groups.map((g) => [g.id, !!g.pinned]))
  let clean = ws.entries.map((e) => {
    const inPins = e.groupId === undefined ? undefined : pinnedGroups.get(e.groupId)
    const groupId = inPins === undefined ? undefined : e.groupId
    const pinned = inPins ?? e.pinned
    return groupId === e.groupId && pinned === e.pinned ? e : { ...e, groupId, pinned }
  })
  const splits = cleanSplits(ws, clean)
  clean = gatherSplits(clean, splits)

  const gather = (list: Entry[]): Entry[] => {
    const out: Entry[] = []
    const placed = new Set<string>()
    for (const e of list) {
      if (!e.groupId) out.push(e)
      else if (!placed.has(e.groupId)) {
        placed.add(e.groupId)
        out.push(...list.filter((m) => m.groupId === e.groupId))
      }
    }
    return out
  }
  const entries = [...gather(clean.filter((e) => e.pinned)), ...gather(clean.filter((e) => !e.pinned))]

  const used = new Set(entries.map((e) => e.groupId).filter(Boolean))
  const groups = ws.groups.filter((g) => used.has(g.id))
  const activeEntryId = entries.some((e) => e.id === ws.activeEntryId)
    ? ws.activeEntryId
    : undefined

  const same =
    entries.length === ws.entries.length &&
    entries.every((e, i) => e === ws.entries[i]) &&
    groups.length === ws.groups.length &&
    activeEntryId === ws.activeEntryId &&
    JSON.stringify(splits) === JSON.stringify(ws.splits ?? [])
  if (same) return ws
  const next: Workspace = { ...ws, entries, groups, activeEntryId }
  if (splits.length) next.splits = splits
  else delete next.splits
  return next
}

// A workspace's splits with their panes' entries still in it, each entry
// in one split at most, and at least two panes each.
function cleanSplits(ws: Workspace, entries: Entry[]): Split[] {
  const present = new Set(entries.map((e) => e.id))
  const claimed = new Set<string>()
  const out: Split[] = []
  for (const split of ws.splits ?? []) {
    const layout = tidy(split.layout, (id) => present.has(id) && !claimed.has(id))
    if (!layout) continue
    const ids = leaves(layout)
    if (ids.length < 2 || ids.length > MAX_SPLIT) continue
    ids.forEach((id) => claimed.add(id))
    out.push({ id: split.id, layout })
  }
  return out
}

// A split's tabs sit together, where its first one in the tab order is,
// in the order its panes read, and share that one's section and folder.
function gatherSplits(entries: Entry[], splits: Split[]): Entry[] {
  if (!splits.length) return entries
  const splitOf = new Map<string, string[]>()
  for (const s of splits) for (const id of leaves(s.layout)) splitOf.set(id, leaves(s.layout))
  const byId = new Map(entries.map((e) => [e.id, e]))
  const out: Entry[] = []
  const placed = new Set<string>()
  for (const e of entries) {
    if (placed.has(e.id)) continue
    const members = splitOf.get(e.id)
    if (!members) {
      out.push(e)
      continue
    }
    for (const id of members) {
      const m = byId.get(id)!
      placed.add(id)
      const same = m.pinned === e.pinned && m.groupId === e.groupId
      out.push(same ? m : { ...m, pinned: e.pinned, groupId: e.groupId })
    }
  }
  return out
}

// ---- Split view ----

export function splitOf(ws: Workspace, entryId: string): Split | undefined {
  return ws.splits?.find((s) => leaves(s.layout).includes(entryId))
}

// The entries split with `entryId` (itself included), or just it.
export function splitMembers(ws: Workspace, entryId: string): string[] {
  const split = splitOf(ws, entryId)
  return split ? leaves(split.layout) : [entryId]
}

// Moves `ids` to just after `refId`, into its section and folder, so a
// split made of them sits where `refId` is.
function gatherAt(ws: Workspace, refId: string, ids: string[]): Workspace {
  const ref = ws.entries.find((e) => e.id === refId)
  if (!ref) return ws
  const moving = new Set(ids.filter((id) => id !== refId))
  const moved = ws.entries.filter((e) => moving.has(e.id)).map((e) => ({ ...e, pinned: ref.pinned, groupId: ref.groupId }))
  const rest = ws.entries.filter((e) => !moving.has(e.id))
  rest.splice(rest.findIndex((e) => e.id === refId) + 1, 0, ...moved)
  return { ...ws, entries: rest }
}

// Splits tabs (Zen's Join Tabs and its layout shortcuts), where the first
// of them is. Tabs already in a split bring that split's other tabs along,
// up to MAX_SPLIT; given just one split's tabs, it takes the new layout.
export function createSplit(ws: Workspace, entryIds: string[], layout: SplitLayout = 'grid'): [Workspace, string | undefined] {
  const present = new Set(ws.entries.map((e) => e.id))
  const asked = [...new Set(entryIds)].filter((id) => present.has(id))
  if (!asked.length) return [ws, undefined]
  const joined = (ws.splits ?? []).filter((s) => leaves(s.layout).some((id) => asked.includes(id)))
  const base = joined.length === 1 ? leaves(joined[0].layout) : []
  const ids = [...base, ...asked.filter((id) => !base.includes(id))].slice(0, MAX_SPLIT)
  if (ids.length < 2) return [ws, undefined]
  const id = joined.length === 1 ? joined[0].id : newId()
  // First, so its tabs leave any other split (see cleanSplits).
  const splits = [{ id, layout: layoutTree(ids, layout) }, ...(ws.splits ?? []).filter((s) => s.id !== id)]
  return [normalize(gatherAt({ ...ws, splits }, ids[0], ids)), id]
}

// Puts tab `entryId` on one side of the pane of `targetId` (Zen's drop of
// a tab onto the page): a new split of the two, or one more pane of the
// split `targetId` is in. Within one split, it moves the pane there.
export function splitBeside(ws: Workspace, entryId: string, targetId: string, side: SplitSide): Workspace {
  if (entryId === targetId || !ws.entries.some((e) => e.id === entryId)) return ws
  if (!ws.entries.some((e) => e.id === targetId)) return ws
  const target = splitOf(ws, targetId)
  const own = splitOf(ws, entryId)
  if (target && own?.id !== target.id && leaves(target.layout).length >= MAX_SPLIT) return ws
  const layout = insertPane(target?.layout ?? { entryId: targetId, size: 100 }, entryId, side, targetId)
  const id = target?.id ?? newId()
  const splits = [{ id, layout }, ...(ws.splits ?? []).filter((s) => s.id !== id)]
  return normalize(gatherAt({ ...ws, splits }, targetId, [entryId]))
}

// Trades two panes of one split (Zen's rearrange, dropped on a pane's middle).
export function swapSplitPanes(ws: Workspace, a: string, b: string): Workspace {
  const split = splitOf(ws, a)
  if (!split || splitOf(ws, b)?.id !== split.id) return ws
  return replaceSplit(ws, { ...split, layout: swapPanes(split.layout, a, b) })
}

// Takes a tab out of its split (Zen's Split Out Tab); a split left with
// one tab is no more.
export function unsplitEntry(ws: Workspace, entryId: string): Workspace {
  const split = splitOf(ws, entryId)
  if (!split) return ws
  const layout = tidy(split.layout, (id) => id !== entryId)
  return layout ? replaceSplit(ws, { ...split, layout }) : removeSplit(ws, split.id)
}

export function removeSplit(ws: Workspace, splitId: string): Workspace {
  return normalize({ ...ws, splits: (ws.splits ?? []).filter((s) => s.id !== splitId) })
}

// A split's panes laid out anew: one of Zen's layouts, or a tree of the
// same panes (resized or rearranged in the window).
export function setSplitLayout(ws: Workspace, splitId: string, layout: SplitLayout | SplitNode): Workspace {
  const split = ws.splits?.find((s) => s.id === splitId)
  if (!split) return ws
  const ids = leaves(split.layout)
  if (typeof layout === 'string') return replaceSplit(ws, { ...split, layout: layoutTree(ids, layout) })
  const next = tidy(layout)
  const same = next && leaves(next).length === ids.length && leaves(next).every((id) => ids.includes(id))
  return same ? replaceSplit(ws, { ...split, layout: next }) : ws
}

function replaceSplit(ws: Workspace, split: Split): Workspace {
  return normalize({ ...ws, splits: (ws.splits ?? []).map((s) => (s.id === split.id ? split : s)) })
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

// ---- Essentials, and entries wherever they are ----

// Where an entry lives: a workspace, or the Essentials (workspace undefined).
export function findEntry(model: Model, id: string): { entry: Entry; workspace?: Workspace } | undefined {
  const essential = model.essentials.find((e) => e.id === id)
  if (essential) return { entry: essential }
  const workspace = workspaceOfEntry(model, id)
  const entry = workspace?.entries.find((e) => e.id === id)
  return entry && { entry, workspace }
}

// Applies `fn` to an entry wherever it lives.
export function editEntry(model: Model, id: string, fn: (e: Entry) => Entry): Model {
  if (model.essentials.some((e) => e.id === id)) {
    return { ...model, essentials: model.essentials.map((e) => (e.id === id ? fn(e) : e)) }
  }
  const ws = workspaceOfEntry(model, id)
  if (!ws) return model
  return withWorkspace(model, ws.id, (w) => ({ ...w, entries: w.entries.map((e) => (e.id === id ? fn(e) : e)) }))
}

// Removes entries wherever they live.
export function removeEntries(model: Model, ids: string[]): Model {
  const gone = new Set(ids)
  let next = model
  if (model.essentials.some((e) => gone.has(e.id))) {
    next = { ...next, essentials: next.essentials.filter((e) => !gone.has(e.id)) }
  }
  for (const ws of model.workspaces) {
    if (ws.entries.some((e) => gone.has(e.id))) next = withWorkspace(next, ws.id, (w) => closeEntries(w, ids))
  }
  return next
}

export interface SectionDrop {
  section: Section
  // The entry it lands in front of; without it, the end of the section.
  beforeId?: string
  groupId?: string
}

// Moves an entry (from any workspace or the Essentials) to a place in the
// Essentials or in workspace `workspaceId`.
export function moveTo(model: Model, entryId: string, workspaceId: string, drop: SectionDrop): Model {
  const found = findEntry(model, entryId)
  if (!found || drop.beforeId === entryId) return model
  const { entry, workspace: from } = found
  const plain = { ...entry, pinned: false, groupId: undefined }

  if (drop.section === 'essentials') {
    const without = from ? withWorkspace(model, from.id, (w) => closeEntry(w, entryId)) : model
    const rest = without.essentials.filter((e) => e.id !== entryId)
    const at = drop.beforeId ? rest.findIndex((e) => e.id === drop.beforeId) : -1
    rest.splice(at < 0 ? rest.length : at, 0, plain)
    return { ...without, essentials: rest }
  }

  const pinned = drop.section === 'pinned'
  if (from?.id === workspaceId) {
    return withWorkspace(model, workspaceId, (w) =>
      placeEntry(w, entryId, { beforeId: drop.beforeId, pinned, groupId: drop.groupId })
    )
  }
  // From the Essentials or another workspace: add it at the end, then place it.
  const without = from
    ? withWorkspace(model, from.id, (w) => closeEntry(w, entryId))
    : { ...model, essentials: model.essentials.filter((e) => e.id !== entryId) }
  return withWorkspace(without, workspaceId, (w) =>
    placeEntry(normalize({ ...w, entries: [...w.entries, plain] }), entryId, {
      beforeId: drop.beforeId,
      pinned,
      groupId: drop.groupId
    })
  )
}

// Sends an entry to the end of another workspace's tabs (dropped on its
// icon), keeping a workspace pin.
export function sendToWorkspace(model: Model, entryId: string, workspaceId: string): Model {
  const found = findEntry(model, entryId)
  if (!found || found.workspace?.id === workspaceId) return model
  return moveTo(model, entryId, workspaceId, { section: found.entry.pinned ? 'pinned' : 'tabs' })
}

// Moves workspace `id` to just before `beforeId`, or to the end.
export function placeWorkspace(model: Model, id: string, beforeId?: string): Model {
  if (id === beforeId) return model
  const rest = model.workspaces.filter((w) => w.id !== id)
  const at = beforeId ? rest.findIndex((w) => w.id === beforeId) : -1
  return moveWorkspace(model, id, at < 0 ? rest.length : at)
}
