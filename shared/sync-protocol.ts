// The sync server's WebSocket protocol (sync-worker/). The server keeps one
// log per account of sealed change batches it can't read, numbered in
// order, plus at most one sealed snapshot that stands in for the log up to
// its number. Devices do all merging themselves.
//
// Connect to <server>/v1/<account> and say hello. The server replies with
// the snapshot if the device is behind it, every later change, then ready.
// After that, changes pushed by other devices arrive as they come.

export const SYNC_PROTOCOL = 1
// The biggest sealed blob the server takes.
export const MAX_BLOB = 1 << 20

export type ClientMessage =
  | { t: 'hello'; v: number; token: string; cursor: number }
  | { t: 'push'; id: number; blob: string }
  // The device's whole state, sealed, as of change `seq`: the log up to
  // there can go.
  | { t: 'compact'; seq: number; blob: string }

export type ServerMessage =
  | { t: 'snapshot'; seq: number; blob: string }
  | { t: 'change'; seq: number; blob: string }
  // Caught up: `seq` is the latest change, `backlog` how many the log holds.
  | { t: 'ready'; seq: number; backlog: number }
  | { t: 'ack'; id: number; seq: number }
  | { t: 'error'; message: string }
