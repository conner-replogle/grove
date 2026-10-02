// Sync as Grove's settings see it: turns it on (a new account, or joining
// one with a sync code), off, and reports how it's doing, all while Grove
// runs.
import type { SyncStatus } from '../../shared/protocol.ts'
import { probe, SyncClient, type SyncConfig, type SyncHost } from './client.ts'
import { readSyncConfig, removeSyncConfig, statePath, writeSyncConfig } from './config.ts'
import { newSecret } from './crypto.ts'
import type { Scope } from './records.ts'

// A sync code: the server and the account's secret, '<server>#<secret>'.
export const syncCode = (c: SyncConfig): string => `${c.url}#${c.secret}`

export function parseSyncCode(code: string): SyncConfig {
  const m = /^\s*(https?:\/\/\S+?)\/?(?:#|\s+)([A-Za-z0-9_-]{43})\s*$/.exec(code)
  if (!m) throw new Error('That isn’t a sync code. It looks like https://…#…')
  return { url: m[1], secret: m[2] }
}

export function checkServer(url: string): string {
  const u = url.trim().replace(/\/+$/, '')
  if (!/^https?:\/\/[^\s/]+/.test(u)) throw new Error('Give the sync server as a URL, like https://grove-ui-sync.you.workers.dev')
  return u
}

export class SyncManager {
  private client?: SyncClient
  private config?: SyncConfig
  private busy?: SyncStatus['busy']
  private error?: string

  private readonly profile: string
  private readonly host: SyncHost
  private readonly scope: () => Scope
  private readonly changed: () => void
  private readonly log: (...a: unknown[]) => void

  constructor(opts: {
    profile: string
    host: SyncHost
    scope: () => Scope
    // Told when the status changes.
    changed: () => void
    log: (...a: unknown[]) => void
  }) {
    this.profile = opts.profile
    this.host = opts.host
    this.scope = opts.scope
    this.changed = opts.changed
    this.log = opts.log
  }

  // Starts syncing if it's set up.
  async start(): Promise<void> {
    const config = readSyncConfig(this.profile)
    if (config) await this.run(config)
  }

  status(): SyncStatus {
    const base = { busy: this.busy, error: this.error }
    if (!this.client || !this.config) return { state: 'off', pending: 0, ...base }
    const s = this.client.status()
    return {
      ...base,
      state: s.state,
      server: this.config.url,
      counts: s.counts,
      pending: s.pending,
      lastSync: s.lastSync,
      code: syncCode(this.config),
      error: this.error ?? s.error
    }
  }

  localChanged(): void {
    this.client?.localChanged()
  }

  flush(): void {
    this.client?.flush()
  }

  setScope(scope: Scope): void {
    void this.client?.setScope(scope)
  }

  // A new sync account on `server`, with this device's workspaces in it.
  setup(server: string): Promise<void> {
    return this.attempt('setup', async () => {
      const config = { url: checkServer(server), secret: newSecret() }
      await probe(config.url, config.secret)
      return config
    })
  }

  // Joins the account a sync code is for.
  join(code: string): Promise<void> {
    return this.attempt('join', async () => {
      const config = parseSyncCode(code)
      await probe(config.url, config.secret)
      return config
    })
  }

  // Stops syncing here. The workspaces stay as they are; other devices
  // keep syncing.
  off(): void {
    this.stopClient()
    removeSyncConfig(this.profile)
    this.error = undefined
    this.changed()
  }

  private async attempt(kind: 'setup' | 'join', get: () => Promise<SyncConfig>): Promise<void> {
    if (this.busy) return
    this.busy = kind
    this.error = undefined
    this.changed()
    try {
      const config = await get()
      this.stopClient()
      writeSyncConfig(this.profile, config)
      await this.run(config)
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
    } finally {
      this.busy = undefined
      this.changed()
    }
  }

  private async run(config: SyncConfig): Promise<void> {
    this.config = config
    this.client = new SyncClient({
      statePath: statePath(this.profile),
      config,
      host: this.host,
      scope: this.scope(),
      onStatus: this.changed,
      log: this.log
    })
    await this.client.start()
    this.changed()
  }

  private stopClient(): void {
    this.client?.flush()
    this.client?.stop()
    this.client = undefined
    this.config = undefined
  }
}
