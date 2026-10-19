// The device's side of sync: keeps the synced records (grove-sync.json in
// the profile), records the host's changes in them, seals and pushes them
// to the sync server, and merges what other devices pushed back into the
// host's model. Works offline: changes wait in `pending` until the server
// is back.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Model } from '../../shared/types.ts'
import { SYNC_PROTOCOL, type ClientMessage, type ServerMessage } from '../../shared/sync-protocol.ts'
import { deriveKeys, seal, unseal, type SyncKeys } from './crypto.ts'
import { Clock, newDeviceId, type Stamp } from './hlc.ts'
import { ALL, adopt, commit, materialize, merge, META, parseRecords, serializeRecords, type Records, type Scope, type SyncRecord } from './records.ts'

export interface SyncConfig {
  url: string
  secret: string
}

export interface SyncHost {
  model(): Model
  // Whether an entry's page is open here.
  isLive(entryId: string): boolean
  // Takes a model with other devices' changes merged in. `remap` says which
  // of the device's workspaces became which synced one (first sync only).
  apply(next: Model, remap: ReadonlyMap<string, string>): Promise<void>
  // Once per launch, when first caught up, if the user was last on another
  // device: go to the workspace (and tab) they were on there, unless
  // they've started doing something here.
  resume(workspaceId: string, entryId: string | undefined): Promise<void>
}

interface Socket {
  readonly readyState: number
  send(data: string): void
  close(): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
}

export interface SavedSyncState {
  version: 1
  device: string
  clock: Stamp
  // The last server change merged in.
  cursor: number
  // Whether this device has had its first sync (see adopt).
  joined: boolean
  records: [string, SyncRecord][]
  // Records changed here that the server doesn't have yet.
  pending: string[]
  lastSync?: number
}

const OPEN = 1
const COMMIT_DELAY_MS = 1000
const SAVE_DELAY_MS = 500
const BATCH = 500
// Log length past which a device replaces it with a snapshot.
const COMPACT_AT = 200

export function socketUrl(base: string, account: string): string {
  const u = new URL(base)
  u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:'
  u.pathname = `${u.pathname.replace(/\/$/, '')}/v1/${account}`
  return u.toString()
}

export type Connection = 'connecting' | 'online' | 'offline' | 'error'

export interface ClientStatus {
  state: Connection
  counts: { workspaces: number; tabs: number; folders: number }
  pending: number
  lastSync?: number
  error?: string
}

// What alive records there are of each kind.
export function countRecords(records: Iterable<[string, SyncRecord]>): ClientStatus['counts'] {
  const counts = { workspaces: 0, tabs: 0, folders: 0 }
  for (const [, r] of records) {
    if (r.f.alive?.[0] !== true) continue
    if (r.kind === 'workspace') counts.workspaces++
    else if (r.kind === 'entry') counts.tabs++
    else if (r.kind === 'group') counts.folders++
  }
  return counts
}

// Says hello to a sync server with a secret's account and token (and, to
// start an account on an invite-only server, an invite code): resolves
// once it answers ready, rejects with what went wrong.
export async function probe(server: string, secret: string, invite?: string, timeoutMs = 10_000): Promise<void> {
  const keys = await deriveKeys(secret)
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(socketUrl(server, keys.account))
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`no answer from ${server}`))
    }, timeoutMs)
    const end = (err?: Error) => {
      clearTimeout(timer)
      ws.onclose = ws.onerror = ws.onmessage = null
      ws.close()
      if (err) reject(err)
      else resolve()
    }
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', v: SYNC_PROTOCOL, token: keys.token, cursor: 0, invite } satisfies ClientMessage))
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as ServerMessage
      if (msg.t === 'error') end(new Error(`the server says: ${msg.message}`))
      else if (msg.t === 'ready') end()
    }
    ws.onerror = () => end(new Error(`can't reach ${server} (or it turned this account away)`))
    ws.onclose = () => end(new Error(`${server} closed the connection`))
  })
}

export function loadSyncState(path: string): SavedSyncState | undefined {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8')) as SavedSyncState
    return s?.version === 1 ? s : undefined
  } catch {
    return undefined
  }
}

export class SyncClient {
  private readonly path: string
  private readonly config: SyncConfig
  private readonly host: SyncHost
  private readonly log: (...a: unknown[]) => void
  private readonly connect: (url: string) => Socket
  private readonly commitDelayMs: number
  private readonly onStatus: () => void
  private scope: Scope
  private connection: Connection = 'connecting'

  private keys?: SyncKeys
  private readonly records: Records
  private readonly clock: Clock
  private cursor: number
  private joined: boolean
  private lastSync?: number
  private readonly pending: Set<string>
  private readonly inflight = new Map<number, string[]>()
  private nextBatch = 1

  private socket?: Socket
  // Caught up with the server on the current connection.
  private ready = false
  private needsApply = false
  private resumed = false
  // When this device last recorded where the user was, as of launch; and
  // the latest place other devices have reported since.
  private readonly launchStamp?: Stamp
  private elsewhere?: { workspaceId: string; stamp: Stamp }
  private readonly activeElsewhere = new Map<string, { entryId: string; stamp: Stamp }>()
  private stopped = false
  private fatal?: string
  private retryMs = 1000
  private queue: Promise<void> = Promise.resolve()
  private commitTimer?: ReturnType<typeof setTimeout>
  private saveTimer?: ReturnType<typeof setTimeout>
  private retryTimer?: ReturnType<typeof setTimeout>

  constructor(opts: {
    statePath: string
    config: SyncConfig
    host: SyncHost
    log?: (...a: unknown[]) => void
    connect?: (url: string) => Socket
    commitDelayMs?: number
    scope?: Scope
    // Told when the status changes.
    onStatus?: () => void
  }) {
    this.path = opts.statePath
    this.config = opts.config
    this.host = opts.host
    this.log = opts.log ?? (() => {})
    this.connect = opts.connect ?? ((url) => new WebSocket(url) as unknown as Socket)
    this.commitDelayMs = opts.commitDelayMs ?? COMMIT_DELAY_MS
    this.scope = opts.scope ?? ALL
    this.onStatus = opts.onStatus ?? (() => {})
    const saved = loadSyncState(this.path)
    this.records = new Map(saved?.records ?? [])
    this.clock = new Clock(saved?.device ?? newDeviceId(), saved?.clock)
    this.cursor = saved?.cursor ?? 0
    this.joined = saved?.joined ?? false
    this.lastSync = saved?.lastSync
    this.pending = new Set(saved?.pending ?? [])
    this.launchStamp = this.records.get(META)?.f.lastWorkspace?.[1]
  }

  async start(): Promise<void> {
    this.keys = await deriveKeys(this.config.secret)
    this.open()
  }

  status(): ClientStatus {
    return {
      state: this.connection,
      counts: countRecords(this.records),
      pending: this.pending.size + [...this.inflight.values()].reduce((n, ids) => n + ids.length, 0),
      lastSync: this.lastSync,
      error: this.fatal
    }
  }

  // Changes what this device syncs, from now on.
  async setScope(scope: Scope): Promise<void> {
    this.scope = scope
    if (!this.joined) return
    // Turning unpinned tabs on sends this device's (commit first), then
    // brings in other devices'.
    this.commitLocal()
    await this.applyRemote()
    this.commitLocal()
    await this.push()
    this.onStatus()
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.retryTimer)
    clearTimeout(this.commitTimer)
    this.socket?.close()
  }

  // The host's model changed: record it soon, and push it.
  localChanged(): void {
    if (!this.joined) return
    clearTimeout(this.commitTimer)
    this.commitTimer = setTimeout(() => {
      this.commitLocal()
      void this.push()
    }, this.commitDelayMs)
  }

  // Synchronous: for quitting. What wasn't pushed goes next time.
  flush(): void {
    clearTimeout(this.commitTimer)
    this.commitLocal()
    clearTimeout(this.saveTimer)
    this.save()
  }

  // ---- The connection ----

  private open(): void {
    if (this.stopped || !this.keys) return
    const keys = this.keys
    const socket = this.connect(socketUrl(this.config.url, keys.account))
    this.socket = socket
    this.ready = false
    this.setConnection('connecting')
    socket.onopen = () => this.send({ t: 'hello', v: SYNC_PROTOCOL, token: keys.token, cursor: this.cursor })
    socket.onmessage = (ev) => {
      let msg: ServerMessage
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      this.queue = this.queue.then(() => this.handle(msg)).catch((e: unknown) => this.log('sync:', e))
    }
    socket.onerror = () => {}
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = undefined
      this.ready = false
      for (const ids of this.inflight.values()) ids.forEach((id) => this.pending.add(id))
      this.inflight.clear()
      if (this.stopped) return
      if (this.fatal) return this.setConnection('error')
      this.setConnection('offline')
      this.log(`sync: offline, retrying in ${this.retryMs / 1000}s`)
      this.retryTimer = setTimeout(() => this.open(), this.retryMs)
      this.retryMs = Math.min(this.retryMs * 2, 60_000)
    }
  }

  private send(msg: ClientMessage): boolean {
    if (this.socket?.readyState !== OPEN) return false
    this.socket.send(JSON.stringify(msg))
    return true
  }

  private async handle(msg: ServerMessage): Promise<void> {
    switch (msg.t) {
      case 'snapshot':
      case 'change':
        return this.receive(msg.seq, msg.blob)
      case 'ready': {
        if (msg.seq < this.cursor) {
          // The server lost changes this device had seen: send it everything.
          this.log('sync: the server is behind this device; sending everything again')
          for (const id of this.records.keys()) this.pending.add(id)
          this.cursor = msg.seq
        }
        this.ready = true
        this.retryMs = 1000
        this.lastSync = Date.now()
        this.setConnection('online')
        if (!this.joined) {
          const { model, remap } = adopt(this.host.model(), this.records, (id) => this.host.isLive(id), this.scope)
          this.joined = true
          this.needsApply = false
          await this.host.apply(model, remap)
          this.log('sync: joined')
        } else if (this.needsApply) {
          this.needsApply = false
          await this.applyRemote()
        }
        this.commitLocal()
        this.saveSoon()
        if (!this.resumed) {
          this.resumed = true
          const e = this.elsewhere
          if (e && (!this.launchStamp || e.stamp > this.launchStamp)) {
            await this.host.resume(e.workspaceId, this.activeElsewhere.get(e.workspaceId)?.entryId)
          }
        }
        await this.push()
        if (msg.backlog > COMPACT_AT) await this.compact()
        return
      }
      case 'ack':
        this.inflight.delete(msg.id)
        this.cursor = Math.max(this.cursor, msg.seq)
        this.lastSync = Date.now()
        this.saveSoon()
        this.onStatus()
        return
      case 'error':
        this.log('sync: the server says:', msg.message)
        if (/token|account/i.test(msg.message)) this.fatal = msg.message
        return
    }
  }

  // A change (or snapshot) from the server: merged into the records, then
  // into the host's model once caught up.
  private async receive(seq: number, blob: string): Promise<void> {
    let incoming: Records
    try {
      incoming = parseRecords(JSON.parse(await unseal(this.keys!, blob)).r)
    } catch (e) {
      this.log(`sync: can't open change ${seq}, skipping it:`, e)
      this.cursor = Math.max(this.cursor, seq)
      return
    }
    // Local changes are recorded first, so they merge with a fair stamp
    // rather than being overwritten by the model built from the records.
    if (this.joined) this.commitLocal()
    for (const rec of incoming.values()) for (const [, stamp] of Object.values(rec.f)) this.clock.observe(stamp)
    this.noteElsewhere(incoming)
    const changed = merge(this.records, incoming)
    this.cursor = Math.max(this.cursor, seq)
    this.saveSoon()
    if (this.ready) this.lastSync = Date.now()
    this.onStatus()
    if (!changed) return
    if (this.ready && this.joined) await this.applyRemote()
    else this.needsApply = true
  }

  // Where other devices say the user was, for resume.
  private noteElsewhere(incoming: Records): void {
    const mine = (stamp: Stamp) => stamp.endsWith(`-${this.clock.device}`)
    for (const [id, rec] of incoming) {
      const field = rec.kind === 'meta' && id === META ? rec.f.lastWorkspace : rec.kind === 'workspace' ? rec.f.active : undefined
      if (!field || typeof field[0] !== 'string' || mine(field[1])) continue
      const [value, stamp] = field as [string, Stamp]
      if (rec.kind === 'meta') {
        if (!this.elsewhere || stamp > this.elsewhere.stamp) this.elsewhere = { workspaceId: value, stamp }
      } else if (stamp > (this.activeElsewhere.get(id)?.stamp ?? '')) {
        this.activeElsewhere.set(id, { entryId: value, stamp })
      }
    }
  }

  private async applyRemote(): Promise<void> {
    const next = materialize(this.host.model(), this.records, this.scope)
    await this.host.apply(next, new Map())
  }

  private commitLocal(): void {
    if (!this.joined) return
    const changed = commit(this.records, this.host.model(), () => this.clock.tick(), this.scope)
    if (!changed.size) return
    changed.forEach((id) => this.pending.add(id))
    this.saveSoon()
    this.onStatus()
  }

  private async push(): Promise<void> {
    while (this.ready && this.pending.size && this.socket?.readyState === OPEN) {
      const ids = [...this.pending].slice(0, BATCH)
      ids.forEach((id) => this.pending.delete(id))
      const id = this.nextBatch++
      this.inflight.set(id, ids)
      const blob = await seal(this.keys!, JSON.stringify({ r: serializeRecords(this.records, ids) }))
      if (!this.inflight.has(id)) return // the connection dropped meanwhile
      if (!this.send({ t: 'push', id, blob })) return
    }
  }

  private setConnection(c: Connection): void {
    if (this.connection === c) return
    this.connection = c
    this.onStatus()
  }

  private async compact(): Promise<void> {
    const seq = this.cursor
    const blob = await seal(this.keys!, JSON.stringify({ r: serializeRecords(this.records) }))
    this.send({ t: 'compact', seq, blob })
  }

  // ---- Saving ----

  private saveSoon(): void {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.save(), SAVE_DELAY_MS)
  }

  private save(): void {
    const state: SavedSyncState = {
      version: 1,
      device: this.clock.device,
      clock: this.clock.last,
      cursor: this.cursor,
      joined: this.joined,
      records: serializeRecords(this.records),
      pending: [...new Set([...this.pending, ...[...this.inflight.values()].flat()])],
      lastSync: this.lastSync
    }
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(`${this.path}.tmp`, JSON.stringify(state))
      renameSync(`${this.path}.tmp`, this.path)
    } catch (e) {
      this.log('sync: saving state failed:', e)
    }
  }
}
