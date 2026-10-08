// Grove's sync server: a Worker in front of one Durable Object per account,
// which keeps the account's sealed sync log in its SQLite storage (see
// room.ts) and talks to devices over hibernatable WebSockets. It also
// sorts tabs into folders with Workers AI (organize.ts).
import { DurableObject } from 'cloudflare:workers'
import { BadRequest, checkRequest, organize, type AiRunner } from './organize.ts'
import { Room, type Peer, type RoomStore } from './room.ts'

export interface Env {
  SYNC: DurableObjectNamespace<SyncRoom>
  // Optional: comma-separated account ids allowed to use this server.
  ACCOUNTS?: string
  AI: Ai
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url)
    const m = /^\/v1\/([0-9a-f]{32})(\/organize)?$/.exec(pathname)
    if (!m) return new Response('Grove sync\n', { status: pathname === '/' ? 200 : 404 })
    const allowed = env.ACCOUNTS?.split(',').map((a) => a.trim()).filter(Boolean)
    if (allowed?.length && !allowed.includes(m[1])) return new Response('unknown account\n', { status: 403 })
    const room = env.SYNC.get(env.SYNC.idFromName(m[1]))
    if (m[2]) return organizeRoute(req, env, room)
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a WebSocket\n', { status: 426 })
    }
    return room.fetch(req)
  }
} satisfies ExportedHandler<Env>

async function organizeRoute(req: Request, env: Env, room: DurableObjectStub<SyncRoom>): Promise<Response> {
  if (req.method !== 'POST') return new Response('expected POST\n', { status: 405 })
  const token = /^Bearer (\S+)$/.exec(req.headers.get('Authorization') ?? '')?.[1]
  const verdict = await room.allowOrganize(token)
  if (verdict !== 'ok') return new Response(`${verdict}\n`, { status: verdict === 'busy' ? 429 : 401 })
  let body
  try {
    body = checkRequest(await req.json())
  } catch (e) {
    return new Response(`${e instanceof BadRequest ? e.message : 'not JSON'}\n`, { status: 400 })
  }
  try {
    return Response.json(await organize(env.AI as unknown as AiRunner, body))
  } catch (e) {
    console.error('organize', e)
    return new Response('Workers AI failed\n', { status: 502 })
  }
}

export class SyncRoom extends DurableObject<Env> {
  private readonly room: Room

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
      count: () => sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM log').one().n
    }
    this.room = new Room(store)
  }

  async fetch(): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ authed: false })
    return new Response(null, { status: 101, webSocket: client })
  }

  // Checks an organize request's token and counts it against the hour's.
  async allowOrganize(token: string | undefined): Promise<'ok' | 'wrong token' | 'busy'> {
    if (!(await this.room.authorize(token))) return 'wrong token'
    return this.room.takeOrganize() ? 'ok' : 'busy'
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
