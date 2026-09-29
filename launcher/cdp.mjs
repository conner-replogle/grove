// A minimal Chrome DevTools Protocol client over --remote-debugging-pipe:
// Chrome reads commands on fd 3 and writes replies on fd 4, each message
// a JSON object followed by a NUL byte.
import { EventEmitter } from 'node:events'

export class PipeCDP extends EventEmitter {
  #nextId = 1
  #pending = new Map()
  #buffer = ''

  constructor(writable, readable) {
    super()
    this.writable = writable
    readable.setEncoding('utf8')
    readable.on('data', (chunk) => this.#onData(chunk))
  }

  #onData(chunk) {
    this.#buffer += chunk
    let end
    while ((end = this.#buffer.indexOf('\0')) >= 0) {
      const raw = this.#buffer.slice(0, end)
      this.#buffer = this.#buffer.slice(end + 1)
      const msg = JSON.parse(raw)
      if (msg.id !== undefined) {
        const waiter = this.#pending.get(msg.id)
        this.#pending.delete(msg.id)
        if (!waiter) continue
        if (msg.error) waiter.reject(new Error(`${waiter.method}: ${msg.error.message}`))
        else waiter.resolve(msg.result)
      } else {
        this.emit(msg.method, msg.params, msg.sessionId)
        this.emit('event', msg)
      }
    }
  }

  send(method, params = {}, sessionId) {
    const id = this.#nextId++
    const msg = { id, method, params }
    if (sessionId) msg.sessionId = sessionId
    this.writable.write(JSON.stringify(msg) + '\0')
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject, method }))
  }
}
