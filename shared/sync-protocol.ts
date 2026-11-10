// The sync server's WebSocket protocol (sync-worker/). The server keeps one
// log per account of sealed change batches it can't read, numbered in
// order, plus at most one sealed snapshot that stands in for the log up to
// its number. Devices do all merging themselves.
//
// Connect to <server>/v1/<account> and say hello. The server replies with
// the snapshot if the device is behind it, every later change, then ready.
// After that, changes pushed by other devices arrive as they come.
//
// The first hello for an account sets its token. A server that's invite
// only (the public one) wants an invite code in that hello, and only then.

export const SYNC_PROTOCOL = 1
// The biggest sealed blob the server takes.
export const MAX_BLOB = 1 << 20
// The most an account may keep on the server, snapshot and log together.
export const MAX_ACCOUNT_BYTES = 64 << 20

// The public sync server, invite only.
export const DEFAULT_SYNC_SERVER = 'https://grove-ui-sync.connerreplogle.workers.dev'

export type ClientMessage =
  | { t: 'hello'; v: number; token: string; cursor: number; invite?: string }
  | { t: 'push'; id: number; blob: string }
  // The device's whole state, sealed, as of change `seq`: the log up to
  // there can go.
  | { t: 'compact'; seq: number; blob: string }

export type ServerMessage =
  | { t: 'snapshot'; seq: number; blob: string }
  | { t: 'change'; seq: number; blob: string }
  // Caught up: `seq` is the latest change, `backlog` how many the log holds.
  | { t: 'ready'; seq: number; backlog: number }
  // `backlog`: how many changes the log holds now (servers deployed
  // before November 2026 leave it out).
  | { t: 'ack'; id: number; seq: number; backlog?: number }
  // `code` says what went wrong, for devices to act on. (Servers deployed
  // before November 2026 send only the message, and close the connection
  // after every error.)
  //   auth       the token or invite is wrong: the connection closes
  //   full       the account has no room for that push (`id`): compact,
  //              then push again
  //   too_big    that push (`id`) is bigger than MAX_BLOB
  //   protocol   anything else: the connection closes
  | { t: 'error'; message: string; code?: SyncErrorCode; id?: number }

export type SyncErrorCode = 'auth' | 'full' | 'too_big' | 'protocol'
