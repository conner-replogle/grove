// What sync carries: the whole workspace model (workspaces, the Essentials,
// every tab and folder, each workspace's active tab and the last workspace
// used) as records of fields. Each field keeps the stamp of its last change
// and the later stamp wins, field by field, so devices merge in any order
// and any number of times to the same result. A record is never removed,
// only marked not alive, so a removal wins over older edits.
// Which window shows what, and pages' own state, stay on the device.
import { COLORS, isWorkspaceColor, type Color, type Entry, type Group, type Model, type Workspace } from '../../shared/types.ts'
import { normalize } from '../model.ts'
import type { Stamp } from './hlc.ts'
import { isStamp } from './hlc.ts'
import { assignKeys } from './order.ts'

export type Kind = 'meta' | 'workspace' | 'entry' | 'group'
export type Value = string | number | boolean | null

// Fields by kind (besides `alive`):
//   meta       lastWorkspace                    (one record, id META)
//   workspace  name, color, icon, active, order
//   entry      parent ('essentials' or a workspace id), pinned, url, title,
//              favicon, group, lastActive, order
//   group      parent (a workspace id), title, color, collapsed, pinned
export interface SyncRecord {
  kind: Kind
  f: Record<string, [Value, Stamp]>
}
export type Records = Map<string, SyncRecord>

export const META = 'model'
const ESSENTIALS = 'essentials'
const KINDS: readonly string[] = ['meta', 'workspace', 'entry', 'group']

const isAlive = (r: SyncRecord | undefined): r is SyncRecord => r?.f.alive?.[0] === true
const str = (r: SyncRecord | undefined, field: string): string | undefined => {
  const v = r?.f[field]?.[0]
  return typeof v === 'string' ? v : undefined
}
// Favicons in data URLs can be big; sync only small ones.
const syncedFavicon = (f: string | undefined): string | null =>
  f && !(f.startsWith('data:') && f.length > 2048) ? f : null

// ---- Merging ----

// Takes the later of each field. Returns whether anything changed.
export function merge(into: Records, incoming: Records): boolean {
  let changed = false
  for (const [id, rec] of incoming) {
    const mine = into.get(id)
    if (!mine) {
      into.set(id, { kind: rec.kind, f: { ...rec.f } })
      changed = true
      continue
    }
    if (mine.kind !== rec.kind) continue
    for (const [field, [value, stamp]] of Object.entries(rec.f)) {
      const cur = mine.f[field]
      if (!cur || stamp > cur[1]) {
        mine.f[field] = [value, stamp]
        changed = true
      }
    }
  }
  return changed
}

// Records from another device, keeping only well-formed ones.
export function parseRecords(raw: unknown): Records {
  const out: Records = new Map()
  if (!Array.isArray(raw)) return out
  for (const item of raw) {
    if (!Array.isArray(item) || typeof item[0] !== 'string') continue
    const [id, rec] = item as [string, { kind?: unknown; f?: unknown }]
    if (!rec || !KINDS.includes(rec.kind as string) || typeof rec.f !== 'object' || !rec.f) continue
    const f: SyncRecord['f'] = Object.create(null)
    for (const [field, pair] of Object.entries(rec.f)) {
      if (!Array.isArray(pair) || !isStamp(pair[1])) continue
      const v = pair[0]
      if (v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) {
        f[field] = [v, pair[1]]
      }
    }
    out.set(id, { kind: rec.kind as Kind, f })
  }
  return out
}

export const serializeRecords = (records: Records, ids?: Iterable<string>): [string, SyncRecord][] =>
  ids ? [...ids].flatMap((id) => (records.has(id) ? [[id, records.get(id)!] as [string, SyncRecord]] : [])) : [...records]

// ---- From the model to records ----

interface Wanted {
  kind: Kind
  values: Record<string, Value>
}

// What the model says the records should hold, and the lists whose order
// the records keep.
function project(model: Model): { wanted: Map<string, Wanted>; lists: string[][] } {
  const wanted = new Map<string, Wanted>()
  const entry = (e: Entry, parent: string): Wanted => ({
    kind: 'entry',
    values: {
      parent,
      pinned: parent !== ESSENTIALS && e.pinned,
      url: e.url,
      title: e.title,
      favicon: syncedFavicon(e.favicon),
      group: e.groupId ?? null,
      lastActive: e.lastActive
    }
  })
  wanted.set(META, { kind: 'meta', values: { lastWorkspace: model.lastActiveWorkspaceId } })
  const lists: string[][] = [model.workspaces.map((w) => w.id), model.essentials.map((e) => e.id)]
  for (const e of model.essentials) wanted.set(e.id, entry(e, ESSENTIALS))
  for (const ws of model.workspaces) {
    wanted.set(ws.id, {
      kind: 'workspace',
      values: { name: ws.name, color: ws.color, icon: ws.icon ?? null, active: ws.activeEntryId ?? null }
    })
    for (const g of ws.groups) {
      wanted.set(g.id, {
        kind: 'group',
        values: { parent: ws.id, title: g.title, color: g.color, collapsed: g.collapsed, pinned: !!g.pinned }
      })
    }
    for (const e of ws.entries) wanted.set(e.id, entry(e, ws.id))
    lists.push(ws.entries.map((e) => e.id))
  }
  return { wanted, lists }
}

// Records the model in `records`, stamping what changed. Returns the ids
// of the records that changed.
export function commit(records: Records, model: Model, stamp: () => Stamp): Set<string> {
  const changed = new Set<string>()
  let at: Stamp | undefined
  const set = (id: string, rec: SyncRecord, field: string, value: Value): void => {
    rec.f[field] = [value, (at ??= stamp())]
    changed.add(id)
  }
  const { wanted, lists } = project(model)
  for (const [id, w] of wanted) {
    let rec = records.get(id)
    if (rec && rec.kind !== w.kind) continue
    if (!rec) records.set(id, (rec = { kind: w.kind, f: Object.create(null) }))
    const alive = isAlive(rec)
    if (!alive) set(id, rec, 'alive', true)
    for (const [field, value] of Object.entries(w.values)) {
      if (!alive || rec.f[field]?.[0] !== value) set(id, rec, field, value)
    }
  }
  for (const list of lists) {
    const keys = assignKeys(list, (id) => records.get(id)?.f.order?.[0])
    list.forEach((id, i) => {
      const rec = records.get(id)!
      if (rec.kind !== wanted.get(id)!.kind) return
      if (rec.f.order?.[0] !== keys[i]) set(id, rec, 'order', keys[i])
    })
  }
  for (const [id, rec] of records) {
    if (isAlive(rec) && !wanted.has(id)) set(id, rec, 'alive', false)
  }
  return changed
}

// ---- From records to the model ----

const byOrder = ([ia, a]: [string, SyncRecord], [ib, b]: [string, SyncRecord]): number => {
  const ka = str(a, 'order') ?? ''
  const kb = str(b, 'order') ?? ''
  return ka < kb ? -1 : ka > kb ? 1 : ia < ib ? -1 : ia > ib ? 1 : 0
}

// The model the records describe. What the records know nothing of (never
// synced: see adopt) stays, after the synced parts; so does what they
// don't carry: tabs' back/forward lists.
export function materialize(model: Model, records: Records): Model {
  const alive = [...records].filter(([, r]) => isAlive(r))
  const aliveOf = (kind: Kind) => alive.filter(([, r]) => r.kind === kind).sort(byOrder)
  const known = (id: string): boolean => records.has(id)
  const localWs = new Map(model.workspaces.map((w) => [w.id, w]))
  const localEntry = new Map<string, Entry>()
  for (const e of model.essentials) localEntry.set(e.id, e)
  for (const w of model.workspaces) for (const e of w.entries) localEntry.set(e.id, e)

  // Workspaces: synced ones in their order, then ones never synced. There
  // is always one.
  const wsIds = [...aliveOf('workspace').map(([id]) => id), ...model.workspaces.filter((w) => !known(w.id)).map((w) => w.id)]
  if (!wsIds.length && model.workspaces.length) wsIds.push(model.workspaces[0].id)
  const inModel = (id: string | undefined): id is string => !!id && wsIds.includes(id)

  const entriesOf = new Map<string, [string, SyncRecord][]>()
  for (const item of aliveOf('entry')) {
    const parent = str(item[1], 'parent')
    if (parent !== ESSENTIALS && !inModel(parent)) continue
    entriesOf.set(parent, [...(entriesOf.get(parent) ?? []), item])
  }
  const claimed = new Set<string>()
  for (const list of entriesOf.values()) for (const [id] of list) claimed.add(id)
  const unsynced = (e: Entry): boolean => !known(e.id) && !claimed.has(e.id)

  const fromRecord = ([id, r]: [string, SyncRecord], parent: string): Entry => {
    const local = localEntry.get(id)
    const favicon = str(r, 'favicon') ?? (local?.favicon && !syncedFavicon(local.favicon) ? local.favicon : undefined)
    const group = parent === ESSENTIALS ? undefined : str(r, 'group')
    const lastActive = r.f.lastActive?.[0]
    const e: Entry = {
      id,
      url: str(r, 'url') ?? '',
      title: str(r, 'title') ?? '',
      pinned: parent !== ESSENTIALS && r.f.pinned?.[0] === true,
      history: local?.history ?? [],
      historyIndex: local?.historyIndex ?? -1,
      lastActive: typeof lastActive === 'number' ? lastActive : (local?.lastActive ?? 0)
    }
    if (favicon) e.favicon = favicon
    if (group) e.groupId = group
    return e
  }

  const essentials = [
    ...(entriesOf.get(ESSENTIALS) ?? []).map((item) => fromRecord(item, ESSENTIALS)),
    ...model.essentials.filter(unsynced)
  ]

  const groupRecords = aliveOf('group')
  const workspaces = wsIds.map((id): Workspace => {
    const local = localWs.get(id)
    const rec = records.get(id)
    const synced = isAlive(rec) ? rec : undefined
    const color = synced?.f.color?.[0]
    const ws: Workspace = {
      id,
      name: str(synced, 'name') || local?.name || 'Workspace',
      color: isWorkspaceColor(color) ? color : (local?.color ?? 'gray'),
      entries: [],
      groups: []
    }
    const icon = synced ? str(synced, 'icon') : local?.icon
    if (icon) ws.icon = icon
    const active = synced ? str(synced, 'active') : local?.activeEntryId
    if (active) ws.activeEntryId = active

    const syncedGroups = groupRecords
      .filter(([, r]) => str(r, 'parent') === id)
      .map(([gid, r]): Group => {
        const c = r.f.color?.[0]
        return {
          id: gid,
          title: str(r, 'title') || 'Folder',
          color: COLORS.includes(c as Color) ? (c as Color) : 'gray',
          collapsed: r.f.collapsed?.[0] === true,
          pinned: r.f.pinned?.[0] === true
        }
      })
    const groupIds = new Set(syncedGroups.map((g) => g.id))
    ws.groups = [...syncedGroups, ...(local?.groups ?? []).filter((g) => !groupIds.has(g.id) && !known(g.id))]
    ws.entries = [
      ...(entriesOf.get(id) ?? []).map((item) => fromRecord(item, id)),
      ...(local?.entries ?? []).filter(unsynced)
    ]
    return normalize(ws)
  })

  const last = str(records.get(META), 'lastWorkspace')
  return {
    version: 1,
    workspaces,
    essentials,
    lastActiveWorkspaceId: inModel(last) ? last : inModel(model.lastActiveWorkspaceId) ? model.lastActiveWorkspaceId : wsIds[0]
  }
}

// A device's first sync: its workspaces join the synced ones of the same
// name, and its tabs that are already synced (the same URL in the same
// place) are dropped, unless their page is open here (`isLive`). What's left
// joins in after the synced parts. Returns the new model and which of the
// device's workspaces became which synced one.
export function adopt(
  model: Model,
  records: Records,
  isLive: (entryId: string) => boolean
): { model: Model; remap: Map<string, string> } {
  const remap = new Map<string, string>()
  const synced = [...records].filter(([, r]) => isAlive(r))
  const byName = new Map<string, string>()
  for (const [id, r] of synced) {
    const name = r.kind === 'workspace' ? str(r, 'name')?.trim().toLowerCase() : undefined
    if (name && !byName.has(name)) byName.set(name, id)
  }
  const taken = new Set<string>()
  for (const w of model.workspaces) {
    const to = byName.get(w.name.trim().toLowerCase())
    if (to && !taken.has(to) && !records.has(w.id)) {
      remap.set(w.id, to)
      taken.add(to)
    }
  }
  const urlsIn = new Map<string, Set<string>>()
  for (const [, r] of synced) {
    const parent = r.kind === 'entry' ? str(r, 'parent') : undefined
    if (!parent) continue
    if (!urlsIn.has(parent)) urlsIn.set(parent, new Set())
    urlsIn.get(parent)!.add(str(r, 'url') ?? '')
  }
  const keep = (e: Entry, parent: string): boolean =>
    records.has(e.id) || !urlsIn.get(parent)?.has(e.url) || isLive(e.id)

  const renamed: Model = {
    ...model,
    workspaces: model.workspaces.map((w) => {
      const id = remap.get(w.id) ?? w.id
      // A synced workspace's own active tab wins.
      const { activeEntryId, ...rest } = w
      return normalize({ ...rest, ...(remap.has(w.id) ? {} : { activeEntryId }), id, entries: w.entries.filter((e) => keep(e, id)) })
    }),
    essentials: model.essentials.filter((e) => keep(e, ESSENTIALS)),
    lastActiveWorkspaceId: remap.get(model.lastActiveWorkspaceId) ?? model.lastActiveWorkspaceId
  }
  return { model: materialize(renamed, records), remap }
}
