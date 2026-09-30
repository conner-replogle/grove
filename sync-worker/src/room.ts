// One account's sync log, as the server keeps it: sealed change batches
// numbered in order, and at most one sealed snapshot standing in for the
// log up to its number. The server can't read any of it; it only checks
// the account's token, numbers what comes in and hands it on.
// Kept apart from the Durable Object so tests can run it in memory.
import { MAX_BLOB, SYNC_PROTOCOL, type ClientMessage, type ServerMessage } from '../../shared/sync-protocol.ts'

export interface RoomStore {
  get(key: string): string | undefined
  put(key: string, value: string): void
  // Adds a change and returns its number, one past the last ever given.
  append(blob: string): number
  since(seq: number): { seq: number; blob: string }[]
  dropThrough(seq: number): void
  count(): number
}

export interface Peer {
  send(message: string): void
  close(code: number, reason: string): void
  authed: boolean
}

async function sha256(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export class Room {
  private readonly store: RoomStore

  constructor(store: RoomStore) {
    this.store = store
  }

  private head(): number {
    return Number(this.store.get('head') ?? 0)
  }

  async message(peer: Peer, data: string, peers: Iterable<Peer>): Promise<void> {
    const send = (m: ServerMessage) => peer.send(JSON.stringify(m))
    const fail = (message: string) => {
      send({ t: 'error', message })
      peer.close(1008, message.slice(0, 120))
    }
    let msg: ClientMessage
    try {
      msg = JSON.parse(data)
    } catch {
      return fail('not JSON')
    }
    if (msg.t === 'hello') {
      if (msg.v !== SYNC_PROTOCOL) return fail(`unsupported protocol ${msg.v}`)
      if (typeof msg.token !== 'string' || msg.token.length < 20) return fail('bad token')
      // The first device to connect sets the account's token.
      const hash = await sha256(msg.token)
      const known = this.store.get('token')
      if (!known) this.store.put('token', hash)
      else if (known !== hash) return fail('wrong token for this account')
      peer.authed = true
      const head = this.head()
      let cursor = Number.isInteger(msg.cursor) && msg.cursor >= 0 && msg.cursor <= head ? msg.cursor : 0
      const snapSeq = Number(this.store.get('snapshotSeq') ?? 0)
      if (cursor < snapSeq) {
        send({ t: 'snapshot', seq: snapSeq, blob: this.store.get('snapshot')! })
        cursor = snapSeq
      }
      for (const { seq, blob } of this.store.since(cursor)) send({ t: 'change', seq, blob })
      send({ t: 'ready', seq: head, backlog: this.store.count() })
      return
    }
    if (!peer.authed) return fail('say hello first')
    if (msg.t === 'push') {
      if (typeof msg.blob !== 'string' || msg.blob.length > MAX_BLOB) return fail('bad blob')
      const seq = this.store.append(msg.blob)
      this.store.put('head', String(seq))
      send({ t: 'ack', id: msg.id, seq })
      const change = JSON.stringify({ t: 'change', seq, blob: msg.blob } satisfies ServerMessage)
      for (const other of peers) if (other !== peer && other.authed) other.send(change)
      return
    }
    if (msg.t === 'compact') {
      const snapSeq = Number(this.store.get('snapshotSeq') ?? 0)
      if (typeof msg.blob !== 'string' || msg.blob.length > MAX_BLOB) return fail('bad blob')
      if (!Number.isInteger(msg.seq) || msg.seq <= snapSeq || msg.seq > this.head()) return
      this.store.put('snapshot', msg.blob)
      this.store.put('snapshotSeq', String(msg.seq))
      this.store.dropThrough(msg.seq)
      return
    }
    fail('unknown message')
  }
}

// A store in memory, for tests.
export class MemoryStore implements RoomStore {
  private readonly meta = new Map<string, string>()
  private log: { seq: number; blob: string }[] = []
  private last = 0
  get(key: string) {
    return this.meta.get(key)
  }
  put(key: string, value: string) {
    this.meta.set(key, value)
  }
  append(blob: string) {
    this.log.push({ seq: ++this.last, blob })
    return this.last
  }
  since(seq: number) {
    return this.log.filter((e) => e.seq > seq)
  }
  dropThrough(seq: number) {
    this.log = this.log.filter((e) => e.seq > seq)
  }
  count() {
    return this.log.length
  }
}
