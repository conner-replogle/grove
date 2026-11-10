import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryStore, Room, type Peer } from '../sync-worker/src/room.ts'
import { InviteBook, MemoryInviteStore, normalizeInvite } from '../sync-worker/src/invites.ts'
import { MAX_ACCOUNT_BYTES, MAX_BLOB } from '../shared/sync-protocol.ts'
import * as M from '../host/model.ts'
import { SyncClient } from '../host/sync/client.ts'
import { deriveKeys, newSecret, seal, unseal } from '../host/sync/crypto.ts'
import { Clock, MAX_SKEW_MS } from '../host/sync/hlc.ts'
import { assignKeys, keyBetween } from '../host/sync/order.ts'
import { adopt, commit, gcTombstones, materialize, MAX_TITLE, MAX_URL, merge, parseRecords, serializeRecords, TOMBSTONE_DAYS, type Records } from '../host/sync/records.ts'
import type { Model } from '../shared/types.ts'

// A model with workspaces of tabs; a leading '*' pins one.
function model(spec: Record<string, string[]>): Model {
  let m = M.emptyModel()
  const home = m.workspaces[0].id
  for (const [name, tabs] of Object.entries(spec)) {
    let id = home
    if (name !== 'Home') [m, id] = M.createWorkspace(m, name)
    for (const t of tabs) {
      const title = t.replace('*', '')
      m = M.withWorkspace(m, id, (w) => M.addEntry(w, { url: `https://${title}.test/`, title }, { pinned: t.startsWith('*') })[0])
    }
  }
  return m
}

// The model as the user sees it, ids aside.
const look = (m: Model) => ({
  workspaces: m.workspaces.map((w) => ({
    name: w.name,
    tabs: w.entries.map((e) => (e.pinned ? '*' : '') + e.title + (e.groupId ? `[${w.groups.find((g) => g.id === e.groupId)?.title}]` : ''))
  })),
  essentials: m.essentials.map((e) => e.title)
})

// Test clocks share one time, which moves on with every stamp.
let t = 1_000_000
const clock = (device: string) => {
  const c = new Clock(device, undefined, () => t++)
  return () => c.tick()
}

// A copy of records, as another device would receive them.
const copy = (r: Records): Records => parseRecords(JSON.parse(JSON.stringify(serializeRecords(r))))

describe('order keys', () => {
  it('fall between their neighbors', () => {
    let keys = [keyBetween(undefined, undefined)]
    for (let i = 0; i < 50; i++) keys.push(keyBetween(keys.at(-1), undefined))
    for (let i = 0; i < 50; i++) keys.unshift(keyBetween(undefined, keys[0]))
    for (let i = 0; i < 50; i++) keys.splice(51, 0, keyBetween(keys[50], keys[51]))
    expect([...keys].sort()).toEqual(keys)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('are kept where they still fit', () => {
    const current: Record<string, string> = { a: 'A', b: 'B', c: 'C', d: 'D' }
    // d moved to the front: only d gets a new key.
    const keys = assignKeys(['d', 'a', 'b', 'c'], (id) => current[id])
    expect(keys.slice(1)).toEqual(['A', 'B', 'C'])
    expect(keys[0] < 'A').toBe(true)
    // A new item between b and c.
    const withNew = assignKeys(['a', 'b', 'x', 'c', 'd'], (id) => current[id])
    expect(withNew[2] > 'B' && withNew[2] < 'C').toBe(true)
  })
})

describe('records', () => {
  it('describe the model exactly', () => {
    let m = model({ Home: ['*mail', 'news', 'docs'], Work: ['*jira', 'ci'] })
    const work = m.workspaces[1]
    m = M.withWorkspace(m, work.id, (w) => M.createGroup(w, [w.entries[1].id], 'Builds')[0])
    m = M.moveTo(m, m.workspaces[0].entries[2].id, work.id, { section: 'essentials' })
    m = M.withWorkspace(m, m.workspaces[0].id, (w) => M.createSplit(w, [w.entries[1].id, w.entries[0].id], 'vsep')[0])
    const records: Records = new Map()
    const changed = commit(records, m, clock('a'))
    expect(changed.size).toBeGreaterThan(0)
    // Nothing more to record, and the records give the same model back.
    expect(commit(records, m, clock('a')).size).toBe(0)
    const back = materialize({ ...M.emptyModel(), workspaces: [] }, copy(records))
    expect(look(back)).toEqual(look(m))
    expect(back.lastActiveWorkspaceId).toBe(m.lastActiveWorkspaceId)
    expect(back.workspaces[1].activeEntryId).toBe(m.workspaces[1].activeEntryId)
    expect(back.workspaces[0].splits).toEqual(m.workspaces[0].splits)
    expect(commit(copy(records), back, clock('b')).size).toBe(0)
  })

  it("carry a pin's own page", () => {
    let m = M.keepPins(model({ Home: ['*mail'] }))
    const id = m.workspaces[0].entries[0].id
    m = M.editEntry(m, id, (e) => ({ ...e, url: 'https://mail.test/inbox', title: 'Inbox' }))
    const records: Records = new Map()
    commit(records, m, clock('a'))
    const back = materialize({ ...M.emptyModel(), workspaces: [] }, copy(records))
    expect(back.workspaces[0].entries[0].pin).toEqual({ url: 'https://mail.test/', title: 'mail' })
    expect(M.pinChanged(back.workspaces[0].entries[0])).toBe(true)
    expect(commit(copy(records), back, clock('b')).size).toBe(0)
  })

  it('merge concurrent edits field by field', () => {
    const base = model({ Home: ['a', 'b', 'c'], Work: ['x'] })
    const shared: Records = new Map()
    commit(shared, base, clock('z'))
    const onA = copy(shared)
    const onB = copy(shared)
    const [a, b, c] = base.workspaces[0].entries.map((e) => e.id)
    const home = base.workspaces[0].id
    const work = base.workspaces[1].id

    // A: renames Work and moves c to the front. B: closes b and pins a.
    let mA = M.renameWorkspace(base, work, 'Job')
    mA = M.withWorkspace(mA, home, (w) => M.placeEntry(w, c, { beforeId: a, pinned: false }))
    let mB = M.withWorkspace(base, home, (w) => M.closeEntry(w, b))
    mB = M.withWorkspace(mB, home, (w) => M.setPinned(w, a, true))
    commit(onA, mA, clock('a'))
    commit(onB, mB, clock('b'))

    merge(onA, copy(onB))
    merge(onB, copy(onA))
    const onDeviceA = materialize(mA, onA)
    const onDeviceB = materialize(mB, onB)
    expect(look(onDeviceA)).toEqual(look(onDeviceB))
    expect(look(onDeviceA).workspaces).toEqual([
      { name: 'Home', tabs: ['*a', 'c'] },
      { name: 'Job', tabs: ['x'] }
    ])
  })

  it('let a removal win over an older edit', () => {
    const base = model({ Home: ['a'], Work: ['x'] })
    const shared: Records = new Map()
    commit(shared, base, clock('z'))
    const onA = copy(shared)
    const onB = copy(shared)
    const work = base.workspaces[1].id
    commit(onA, M.renameWorkspace(base, work, 'Job'), clock('a'))
    commit(onB, M.deleteWorkspace(base, work), clock('b')) // later stamps
    merge(onA, onB)
    expect(look(materialize(base, onA)).workspaces.map((w) => w.name)).toEqual(['Home'])
  })

  it('join a new device without duplicating what is synced', () => {
    const synced: Records = new Map()
    commit(synced, model({ Home: ['*mail', 'news'], Work: ['jira'] }), clock('a'))
    const device = model({ Home: ['*mail', 'recipes'], Play: ['game'] })
    const { model: joined, remap } = adopt(device, copy(synced), () => false)
    expect(remap.size).toBe(1)
    expect(look(joined).workspaces).toEqual([
      { name: 'Home', tabs: ['*mail', 'news', 'recipes'] },
      { name: 'Work', tabs: ['jira'] },
      { name: 'Play', tabs: ['game'] }
    ])
  })
})

describe('keeping sync small', () => {
  it('empties what a removed tab held, and forgets it after a month', () => {
    const base = model({ Home: ['mail', 'secret'] })
    const records: Records = new Map()
    commit(records, base, clock('a'))
    const gone = base.workspaces[0].entries[1].id
    commit(records, M.withWorkspace(base, base.workspaces[0].id, (w) => M.closeEntry(w, gone)), clock('a'))
    const rec = records.get(gone)!
    expect(rec.f.alive[0]).toBe(false)
    expect(rec.f.url[0]).toBeNull()
    expect(rec.f.title[0]).toBeNull()
    // Every field emptied with the removal's own stamp.
    expect(rec.f.url[1]).toBe(rec.f.alive[1])
    // It stays (for devices that haven't heard) until a month has passed.
    const removedAt = parseInt(rec.f.alive[1].split('-')[0], 36)
    expect(gcTombstones(records, removedAt + 86_400_000)).toBe(0)
    expect(gcTombstones(records, removedAt + (TOMBSTONE_DAYS + 1) * 86_400_000)).toBe(1)
    expect(records.has(gone)).toBe(false)
    // A device that had it open still has it, unaffected.
    const back = materialize(base, copy(records))
    expect(look(back).workspaces[0].tabs).toEqual(['mail', 'secret'])
  })

  it("doesn't sync when a tab was last shown, cuts long titles, and keeps huge addresses here", () => {
    let m = model({ Home: ['mail'] })
    const records: Records = new Map()
    commit(records, m, clock('a'))
    const id = m.workspaces[0].entries[0].id
    m = M.editEntry(m, id, (e) => ({ ...e, lastActive: e.lastActive + 60_000 }))
    expect(commit(records, m, clock('a')).size).toBe(0)
    m = M.editEntry(m, id, (e) => ({ ...e, title: 'x'.repeat(5000) }))
    commit(records, m, clock('a'))
    expect((records.get(id)!.f.title[0] as string).length).toBe(MAX_TITLE)
    m = M.withWorkspace(m, m.workspaces[0].id, (w) => M.addEntry(w, { url: `data:text/html,${'x'.repeat(MAX_URL)}`, title: 'big' })[0])
    const big = m.workspaces[0].entries.find((e) => e.title === 'big')!.id
    commit(records, m, clock('a'))
    expect(records.has(big)).toBe(false)
  })

  it("doesn't follow a clock that's far ahead", () => {
    let now = 1_000_000_000
    const c = new Clock('a', undefined, () => now)
    const far = new Clock('b', undefined, () => now + 2 * MAX_SKEW_MS).tick()
    expect(c.observe(far)).toBe(true)
    expect(c.tick() < far).toBe(true)
    const near = new Clock('b', undefined, () => now + 60_000).tick()
    expect(c.observe(near)).toBe(false)
    expect(c.tick() > near).toBe(true)
    // A full counter moves on to the next millisecond.
    const stamps = Array.from({ length: 5 }, () => c.tick())
    expect([...stamps].sort()).toEqual(stamps)
    now += 0
  })
})

describe('syncing only pins', () => {
  const PINS = { unpinnedTabs: false }
  const setup = () => {
    const base = model({ Home: ['*mail', 'news'], Work: ['jira'] })
    const shared: Records = new Map()
    commit(shared, base, clock('z'))
    return { base, shared }
  }

  it("neither sends this device's tabs nor closes other devices'", () => {
    const { base, shared } = setup()
    const onPins = copy(shared)
    // Opens a tab and closes `news`: neither leaves this device.
    let m = M.withWorkspace(base, base.workspaces[0].id, (w) => M.addEntry(w, { url: 'https://local.test/', title: 'local' })[0])
    m = M.withWorkspace(m, m.workspaces[0].id, (w) => M.closeEntry(w, w.entries.find((e) => e.title === 'news')!.id))
    const changed = commit(onPins, m, clock('p'), PINS)
    expect(changed.size).toBe(0)
    const elsewhere = copy(shared)
    merge(elsewhere, onPins)
    expect(look(materialize(base, elsewhere)).workspaces[0].tabs).toEqual(['*mail', 'news'])
  })

  it("keeps this device's tabs when other devices' tabs change", () => {
    const { base, shared } = setup()
    const onPins = copy(shared)
    const local = M.withWorkspace(base, base.workspaces[0].id, (w) => M.addEntry(w, { url: 'https://local.test/', title: 'local' })[0])
    commit(onPins, local, clock('p'), PINS)
    // Another device closes `news` and opens `far`.
    const other = copy(shared)
    let o = M.withWorkspace(base, base.workspaces[0].id, (w) => M.closeEntry(w, w.entries.find((e) => e.title === 'news')!.id))
    o = M.withWorkspace(o, o.workspaces[1].id, (w) => M.addEntry(w, { url: 'https://far.test/', title: 'far' })[0])
    commit(other, o, clock('o'))
    merge(onPins, other)
    expect(look(materialize(local, onPins, PINS)).workspaces).toEqual([
      { name: 'Home', tabs: ['*mail', 'news', 'local'] },
      { name: 'Work', tabs: ['jira'] }
    ])
  })

  it('sends an unpin once, and takes other devices’ unpins', () => {
    const { base, shared } = setup()
    const home = base.workspaces[0].id
    const mail = base.workspaces[0].entries[0].id
    // Unpinned here: other devices see it become an ordinary tab.
    const onPins = copy(shared)
    const unpinned = M.withWorkspace(base, home, (w) => M.setPinned(w, mail, false))
    expect(commit(onPins, unpinned, clock('p'), PINS).has(mail)).toBe(true)
    expect(commit(onPins, unpinned, clock('p'), PINS).size).toBe(0)
    const elsewhere = copy(shared)
    merge(elsewhere, onPins)
    expect(look(materialize(base, elsewhere)).workspaces[0].tabs).toEqual(['mail', 'news'])
    // Unpinned elsewhere: here it becomes an ordinary tab, and stays one.
    const here = copy(shared)
    merge(here, onPins)
    const next = materialize(base, here, PINS)
    expect(look(next).workspaces[0].tabs).toEqual(['mail', 'news'])
    expect(commit(here, next, clock('q'), PINS).size).toBe(0)
  })
})

describe('crypto', () => {
  it('seals so only the same secret opens', async () => {
    const secret = newSecret()
    const keys = await deriveKeys(secret)
    expect(keys.account).toMatch(/^[0-9a-f]{32}$/)
    const blob = await seal(keys, 'hello')
    expect(blob).not.toContain('hello')
    expect(await unseal(await deriveKeys(secret), blob)).toBe('hello')
    await expect(unseal(await deriveKeys(newSecret()), blob)).rejects.toThrow()
  })
})

// ---- Two devices through the server's room ----

class FakeSocket {
  readyState = 0
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  private readonly peer: Peer
  private readonly server: Server

  constructor(server: Server) {
    this.server = server
    this.peer = {
      send: (m) => setTimeout(() => this.readyState === 1 && this.onmessage?.({ data: m })),
      close: () => this.close(),
      authed: false
    }
    server.peers.add(this.peer)
    setTimeout(() => {
      this.readyState = 1
      this.onopen?.({})
    })
  }

  send(data: string): void {
    this.server.queue = this.server.queue.then(() => this.server.room.message(this.peer, data, this.server.peers))
  }

  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.server.peers.delete(this.peer)
    setTimeout(() => this.onclose?.({}))
  }
}

interface Server {
  room: Room
  peers: Set<Peer>
  queue: Promise<void>
}

class Device {
  model: Model
  readonly client: SyncClient
  socket?: FakeSocket
  readonly logs: string[] = []

  constructor(name: string, start: Model, secret: string, server: Server, dir: string) {
    this.model = start
    this.client = new SyncClient({
      statePath: join(dir, `${name}.json`),
      config: { url: 'https://sync.test', secret },
      host: {
        model: () => this.model,
        isLive: () => false,
        apply: async (next) => {
          this.model = next
        },
        resume: async () => {}
      },
      connect: () => (this.socket = new FakeSocket(server)),
      commitDelayMs: 0,
      log: (...a) => this.logs.push(a.map(String).join(' '))
    })
  }

  edit(fn: (m: Model) => Model): void {
    this.model = fn(this.model)
    this.client.localChanged()
  }
}

const settle = () => new Promise((r) => setTimeout(r, 60))

describe('sync between devices', () => {
  it('brings every device to the same model', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'grove-sync-'))
    const server: Server = { room: new Room(new MemoryStore()), peers: new Set(), queue: Promise.resolve() }
    const secret = newSecret()
    const laptop = new Device('laptop', model({ Home: ['*mail', 'news'], Work: ['jira', 'ci'] }), secret, server, dir)
    await laptop.client.start()
    await settle()
    const mac = new Device('mac', M.emptyModel(), secret, server, dir)
    await mac.client.start()
    await settle()
    expect(look(mac.model)).toEqual(look(laptop.model))

    // Both edit at once.
    const work = laptop.model.workspaces[1]
    laptop.edit((m) => M.withWorkspace(m, work.id, (w) => M.closeEntry(w, w.entries[1].id)))
    mac.edit((m) => M.editWorkspace(m, work.id, { name: 'Job', icon: '💼' }))
    mac.edit((m) => M.withWorkspace(m, m.workspaces[0].id, (w) => M.addEntry(w, { url: 'https://new.test/', title: 'new' })[0]))
    await settle()
    expect(look(mac.model)).toEqual(look(laptop.model))
    expect(look(laptop.model).workspaces).toEqual([
      { name: 'Home', tabs: ['*mail', 'news', 'new'] },
      { name: 'Job', tabs: ['jira'] }
    ])

    // The mac goes offline, edits, comes back.
    mac.socket!.close()
    await settle()
    mac.edit((m) => M.deleteWorkspace(m, work.id))
    await settle()
    expect(laptop.model.workspaces).toHaveLength(2)
    await new Promise((r) => setTimeout(r, 1100)) // reconnect backoff
    await settle()
    expect(look(laptop.model).workspaces.map((w) => w.name)).toEqual(['Home'])

    // A third device joins after the log was compacted to a snapshot.
    const phone = new Device('phone', M.emptyModel(), secret, server, dir)
    await phone.client.start()
    await settle()
    expect(look(phone.model)).toEqual(look(laptop.model))
    for (const d of [laptop, mac, phone]) d.client.stop()
  })

  it('sends many big changes in batches the server takes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'grove-sync-'))
    const store = new MemoryStore()
    const server: Server = { room: new Room(store), peers: new Set(), queue: Promise.resolve() }
    const secret = newSecret()
    // ~2.5 MB of tabs: more than one blob can carry.
    let start = M.emptyModel()
    start = M.withWorkspace(start, start.workspaces[0].id, (w) => {
      for (let i = 0; i < 2500; i++) w = M.addEntry(w, { url: `https://t${i}.test/`, title: `${i} ${'y'.repeat(900)}` })[0]
      return w
    })
    const laptop = new Device('laptop', start, secret, server, dir)
    await laptop.client.start()
    await new Promise((r) => setTimeout(r, 1500))
    const sent = store.since(0)
    expect(sent.length).toBeGreaterThan(1)
    expect(Math.max(...sent.map((e) => e.blob.length))).toBeLessThanOrEqual(MAX_BLOB)
    const mac = new Device('mac', M.emptyModel(), secret, server, dir)
    await mac.client.start()
    await new Promise((r) => setTimeout(r, 1500))
    expect(mac.model.workspaces[0].entries).toHaveLength(2500)
    expect(laptop.client.status().error).toBeUndefined()
    for (const d of [laptop, mac]) d.client.stop()
  })

  it('compacts while connected once the log grows, and makes room when the account is full', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'grove-sync-'))
    const store = new MemoryStore()
    const server: Server = {
      room: new Room(store, { maxAccountBytes: 120_000 }),
      peers: new Set(),
      queue: Promise.resolve()
    }
    const secret = newSecret()
    const laptop = new Device('laptop', model({ Home: ['a'] }), secret, server, dir)
    await laptop.client.start()
    await settle()
    const id = laptop.model.workspaces[0].entries[0].id
    // Each rename is a change of its own; the account fills before 200.
    for (let i = 0; i < 260; i++) {
      laptop.edit((m) => M.editEntry(m, id, (e) => ({ ...e, title: `a ${i} ${'z'.repeat(300)}` })))
      await new Promise((r) => setTimeout(r, 3))
    }
    await new Promise((r) => setTimeout(r, 500))
    expect(Number(store.get('snapshotSeq') ?? 0)).toBeGreaterThan(0)
    expect(laptop.logs.some((l) => l.includes('account is full'))).toBe(true)
    expect(laptop.client.status().error).toBeUndefined()
    expect(laptop.client.status().pending).toBe(0)
    // What the last rename said got there.
    const phone = new Device('phone', M.emptyModel(), secret, server, dir)
    await phone.client.start()
    await settle()
    expect(phone.model.workspaces[0].entries[0].title).toMatch(/^a 259 /)
    for (const d of [laptop, phone]) d.client.stop()
  })

  it('gets past a full account on a server from before error codes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'grove-sync-'))
    const store = new MemoryStore()
    // The server as deployed before November 2026: no codes or backlog, and
    // every error closes the connection.
    const room = new Room(store, { maxAccountBytes: 120_000 })
    const old = {
      async message(peer: Peer, data: string, peers: Iterable<Peer>) {
        const wrapped: Peer = {
          get authed() {
            return peer.authed
          },
          set authed(v) {
            peer.authed = v
          },
          close: (c, r) => peer.close(c, r),
          send: (m) => {
            const msg = JSON.parse(m)
            delete msg.code
            delete msg.backlog
            if (msg.t === 'error') delete msg.id
            peer.send(JSON.stringify(msg))
            // (After the message: a WebSocket delivers what was sent first.)
            if (msg.t === 'error') setTimeout(() => peer.close(1008, msg.message), 5)
          }
        }
        return room.message(wrapped, data, peers)
      }
    } as unknown as Room
    const server: Server = { room: old, peers: new Set(), queue: Promise.resolve() }
    const secret = newSecret()
    const laptop = new Device('laptop', model({ Home: ['a'] }), secret, server, dir)
    await laptop.client.start()
    await settle()
    const id = laptop.model.workspaces[0].entries[0].id
    for (let i = 0; i < 260; i++) {
      laptop.edit((m) => M.editEntry(m, id, (e) => ({ ...e, title: `a ${i} ${'z'.repeat(300)}` })))
      await new Promise((r) => setTimeout(r, 3))
    }
    // Closed on "full", back after the reconnect delay, compacted, pushed.
    await new Promise((r) => setTimeout(r, 2500))
    expect(laptop.logs.some((l) => l.includes('account is full'))).toBe(true)
    expect(laptop.client.status().error).toBeUndefined()
    expect(laptop.client.status().pending).toBe(0)
    const phone = new Device('phone', M.emptyModel(), secret, server, dir)
    await phone.client.start()
    await settle()
    expect(phone.model.workspaces[0].entries[0].title).toMatch(/^a 259 /)
    for (const d of [laptop, phone]) d.client.stop()
  })

  it('keeps what other devices made while this one was offline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'grove-sync-'))
    const server: Server = { room: new Room(new MemoryStore()), peers: new Set(), queue: Promise.resolve() }
    const secret = newSecret()
    const laptop = new Device('laptop', model({ Home: ['*mail', '*news', 'ci'] }), secret, server, dir)
    await laptop.client.start()
    await settle()
    const mac = new Device('mac', M.emptyModel(), secret, server, dir)
    await mac.client.start()
    await settle()

    mac.socket!.close()
    await settle()
    // Separate changes, so the mac catches up on several of them.
    const home = laptop.model.workspaces[0].id
    laptop.edit((m) => M.withWorkspace(m, home, (w) => M.createGroup(w, [w.entries[0].id])[0]))
    await settle()
    laptop.edit((m) => M.withWorkspace(m, home, (w) => M.setEntryGroup(w, w.entries[1].id, w.groups[0].id)))
    await settle()
    laptop.edit((m) => M.withWorkspace(m, home, (w) => M.addEntry(w, { url: 'https://docs.test/', title: 'docs' }, { pinned: true })[0]))
    await settle()
    await new Promise((r) => setTimeout(r, 1100)) // reconnect backoff
    await settle()

    expect(look(laptop.model).workspaces[0].tabs).toEqual(['*mail[New Folder]', '*news[New Folder]', '*docs', 'ci'])
    expect(look(mac.model)).toEqual(look(laptop.model))
    for (const d of [laptop, mac]) d.client.stop()
  })

  it('turns away a device with the wrong token', async () => {
    const store = new MemoryStore()
    const room = new Room(store)
    const sent: string[] = []
    const peer: Peer = { send: (m) => sent.push(m), close: () => {}, authed: false }
    await room.message(peer, JSON.stringify({ t: 'hello', v: 1, token: 'a'.repeat(43), cursor: 0 }), [peer])
    expect(peer.authed).toBe(true)
    const other: Peer = { send: (m) => sent.push(m), close: () => {}, authed: false }
    await room.message(other, JSON.stringify({ t: 'hello', v: 1, token: 'b'.repeat(43), cursor: 0 }), [other])
    expect(other.authed).toBe(false)
    expect(sent.at(-1)).toContain('wrong token')
  })
})

describe('invite-only server', () => {
  const hello = (token: string, invite?: string) => JSON.stringify({ t: 'hello', v: 1, token, cursor: 0, invite })
  const peer = (sent: string[]): Peer => ({ send: (m) => sent.push(m), close: () => {}, authed: false })
  const roomFor = (book: InviteBook, account: string, store = new MemoryStore()) =>
    new Room(store, { redeem: async (code) => book.redeem(code, account) })

  it('starts an account only with an unused invite', async () => {
    const book = new InviteBook(new MemoryInviteStore())
    const { code } = book.create('for sam')
    const sent: string[] = []

    const a = roomFor(book, 'a'.repeat(32))
    const p1 = peer(sent)
    await a.message(p1, hello('t'.repeat(43)), [p1])
    expect(p1.authed).toBe(false)
    expect(sent.at(-1)).toContain('invite only')
    const p2 = peer(sent)
    await a.message(p2, hello('t'.repeat(43), 'ZZZZ-ZZZZ-ZZZZ'), [p2])
    expect(p2.authed).toBe(false)
    // Typed loosely: lower case, no dashes.
    const p3 = peer(sent)
    await a.message(p3, hello('t'.repeat(43), code.toLowerCase().replace(/-/g, '')), [p3])
    expect(p3.authed).toBe(true)

    // Spent: another account can't use it, this one can again.
    const b = roomFor(book, 'b'.repeat(32))
    const p4 = peer(sent)
    await b.message(p4, hello('u'.repeat(43), code), [p4])
    expect(p4.authed).toBe(false)
    expect(book.redeem(code, 'a'.repeat(32))).toBe(true)
    expect(book.list()[0]).toMatchObject({ code, note: 'for sam', account: 'a'.repeat(32) })
    expect(book.revoke(code)).toBe(false)
  })

  it('lets accounts that already sync on without an invite', async () => {
    const store = new MemoryStore()
    store.put('token', 'whatever')
    const book = new InviteBook(new MemoryInviteStore())
    const sent: string[] = []
    const p = peer(sent)
    await roomFor(book, 'a'.repeat(32), store).message(p, hello('t'.repeat(43)), [p])
    // Turned away for the wrong token, not for the missing invite.
    expect(sent.at(-1)).toContain('wrong token')
  })

  it('makes readable codes and takes back unused ones', () => {
    const book = new InviteBook(new MemoryInviteStore())
    const { code } = book.create()
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
    expect(normalizeInvite('abcd efgh ijkl')).toBe('ABCD-EFGH-1JK1')
    expect(book.revoke(code)).toBe(true)
    expect(book.redeem(code, 'a'.repeat(32))).toBe(false)
  })

  it("caps what an account keeps", async () => {
    const room = new Room(new MemoryStore())
    const sent: string[] = []
    const p = peer(sent)
    await room.message(p, hello('t'.repeat(43)), [p])
    const blob = 'x'.repeat(MAX_BLOB)
    for (let i = 0; i < MAX_ACCOUNT_BYTES / MAX_BLOB; i++) await room.message(p, JSON.stringify({ t: 'push', id: i, blob }), [p])
    expect(sent.at(-1)).toContain('ack')
    await room.message(p, JSON.stringify({ t: 'push', id: 999, blob: 'x' }), [p])
    expect(sent.at(-1)).toContain('full')
  })
})
