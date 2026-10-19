// Grove's sync server: a Worker in front of one Durable Object per account,
// which keeps the account's sealed sync log in its SQLite storage (see
// room.ts) and talks to devices over hibernatable WebSockets.
//
// It's invite only unless OPEN_SIGNUP is "true": a new account needs an
// invite code, which the admin makes with `grove sync invite` (the
// ADMIN_TOKEN secret; see invites.ts). Accounts that already sync go on
// without one.
import { DurableObject } from 'cloudflare:workers'
import { InviteBook, type Invite, type InviteStore } from './invites.ts'
import { Room, type Peer, type RoomStore } from './room.ts'

export interface Env {
  SYNC: DurableObjectNamespace<SyncRoom>
  INVITES: DurableObjectNamespace<Invites>
  // A secret (wrangler secret put ADMIN_TOKEN): makes and lists invites.
  ADMIN_TOKEN?: string
  // "true": anyone may start an account, no invite needed.
  OPEN_SIGNUP?: string
}

const ACCOUNT_PATH = /^\/v1\/([0-9a-f]{32})$/

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url)
    if (pathname === '/') return new Response('Grove sync\n')
    if (pathname === '/admin/invites' || pathname.startsWith('/admin/invites/')) return admin(req, env, pathname)
    const m = ACCOUNT_PATH.exec(pathname)
    if (!m) return new Response('not found\n', { status: 404 })
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a WebSocket\n', { status: 426 })
    }
    return env.SYNC.get(env.SYNC.idFromName(m[1])).fetch(req)
  }
} satisfies ExportedHandler<Env>

const invites = (env: Env) => env.INVITES.get(env.INVITES.idFromName('invites'))

//   GET    /admin/invites          every invite, newest first
//   POST   /admin/invites          a new one; body {"note": "..."} (optional)
//   DELETE /admin/invites/<code>   takes back an unused one
// all with `Authorization: Bearer <ADMIN_TOKEN>`.
async function admin(req: Request, env: Env, pathname: string): Promise<Response> {
  const token = /^Bearer (\S+)$/.exec(req.headers.get('Authorization') ?? '')?.[1]
  if (!env.ADMIN_TOKEN || !token || !(await sameSecret(token, env.ADMIN_TOKEN))) {
    return new Response('wrong admin token\n', { status: 401 })
  }
  const code = pathname.slice('/admin/invites/'.length)
  if (pathname === '/admin/invites') {
    if (req.method === 'GET') return Response.json(await invites(env).list())
    if (req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { note?: unknown }
      return Response.json(await invites(env).create(typeof body?.note === 'string' ? body.note : ''))
    }
  } else if (req.method === 'DELETE' && code) {
    return (await invites(env).revoke(decodeURIComponent(code)))
      ? new Response(null, { status: 204 })
      : new Response('no unused invite with that code\n', { status: 404 })
  }
  return new Response('method not allowed\n', { status: 405 })
}

async function sameSecret(a: string, b: string): Promise<boolean> {
  const hash = async (s: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return crypto.subtle.timingSafeEqual(await hash(a), await hash(b))
}

export class SyncRoom extends DurableObject<Env> {
  private readonly room: Room
  private readonly store: RoomStore

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const sql = ctx.storage.sql
    sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)')
    sql.exec('CREATE TABLE IF NOT EXISTS log (seq INTEGER PRIMARY KEY AUTOINCREMENT, blob TEXT NOT NULL)')
    const store: RoomStore = {
      get: (k) => sql.exec<{ v: string }>('SELECT v FROM meta WHERE k = ?', k).toArray()[0]?.v,
      put: (k, v) => void sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', k, v),
      append: (blob) => sql.exec<{ seq: number }>('INSERT INTO log (blob) VALUES (?) RETURNING seq', blob).one().seq,
      since: (seq) => sql.exec<{ seq: number; blob: string }>('SELECT seq, blob FROM log WHERE seq > ? ORDER BY seq', seq).toArray(),
      dropThrough: (seq) => void sql.exec('DELETE FROM log WHERE seq <= ?', seq),
      count: () => sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM log').one().n,
      bytes: () => sql.exec<{ n: number | null }>('SELECT SUM(LENGTH(blob)) AS n FROM log').one().n ?? 0
    }
    this.store = store
    const open = env.OPEN_SIGNUP === 'true'
    this.room = new Room(store, {
      redeem: open ? undefined : async (code) => invites(env).redeem(code, store.get('account') ?? '')
    })
  }

  async fetch(req: Request): Promise<Response> {
    // Which account this object is: invites are tied to it.
    const account = ACCOUNT_PATH.exec(new URL(req.url).pathname)?.[1]
    if (account && !this.store.get('account')) this.store.put('account', account)
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ authed: false })
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
    await this.room.message(peer(ws), text, this.ctx.getWebSockets().map(peer))
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code, 'closing')
    } catch {}
  }
}

// The server's one invite book.
export class Invites extends DurableObject<Env> {
  private readonly book: InviteBook

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const sql = ctx.storage.sql
    sql.exec(`CREATE TABLE IF NOT EXISTS invites (
      code TEXT PRIMARY KEY, note TEXT NOT NULL, created INTEGER NOT NULL, account TEXT, used INTEGER)`)
    const row = (r: Record<string, unknown>): Invite => ({
      code: r.code as string,
      note: r.note as string,
      created: r.created as number,
      ...(r.account ? { account: r.account as string, used: r.used as number } : {})
    })
    const store: InviteStore = {
      get: (code) => sql.exec('SELECT * FROM invites WHERE code = ?', code).toArray().map(row)[0],
      put: (i) =>
        void sql.exec(
          'INSERT OR REPLACE INTO invites (code, note, created, account, used) VALUES (?, ?, ?, ?, ?)',
          i.code,
          i.note,
          i.created,
          i.account ?? null,
          i.used ?? null
        ),
      delete: (code) => void sql.exec('DELETE FROM invites WHERE code = ?', code),
      list: () => sql.exec('SELECT * FROM invites').toArray().map(row)
    }
    this.book = new InviteBook(store)
  }

  async redeem(code: string, account: string): Promise<boolean> {
    return !!account && this.book.redeem(code, account)
  }
  async create(note: string): Promise<Invite> {
    return this.book.create(note)
  }
  async list(): Promise<Invite[]> {
    return this.book.list()
  }
  async revoke(code: string): Promise<boolean> {
    return this.book.revoke(code)
  }
}

function peer(ws: WebSocket): Peer {
  return {
    send: (m) => ws.send(m),
    close: (code, reason) => ws.close(code, reason),
    get authed() {
      return (ws.deserializeAttachment() as { authed?: boolean } | null)?.authed === true
    },
    set authed(v: boolean) {
      ws.serializeAttachment({ authed: v })
    }
  }
}
