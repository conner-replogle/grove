import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryStore, Room, type Peer } from '../sync-worker/src/room.ts'
import * as M from '../host/model.ts'
import { SyncClient } from '../host/sync/client.ts'
import { deriveKeys, newSecret, seal, unseal } from '../host/sync/crypto.ts'
import { Clock } from '../host/sync/hlc.ts'
import { assignKeys, keyBetween } from '../host/sync/order.ts'
import { adopt, commit, materialize, merge, parseRecords, serializeRecords, type Records } from '../host/sync/records.ts'
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
      commitDelayMs: 0
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
