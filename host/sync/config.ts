// Where a profile keeps its sync settings: grove-sync-config.json (the
// server and the account's secret, readable only by the user) and
// grove-sync.json (the synced records; see client.ts).
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SyncConfig } from './client.ts'

export const configPath = (profile: string): string => join(profile, 'grove-sync-config.json')
export const statePath = (profile: string): string => join(profile, 'grove-sync.json')

export function readSyncConfig(profile: string): SyncConfig | undefined {
  try {
    const c = JSON.parse(readFileSync(configPath(profile), 'utf8'))
    return typeof c?.url === 'string' && typeof c?.secret === 'string' ? { url: c.url, secret: c.secret } : undefined
  } catch {
    return undefined
  }
}

// A new account (or joining one) starts this device's sync over.
export function writeSyncConfig(profile: string, config: SyncConfig): void {
  writeFileSync(configPath(profile), JSON.stringify(config, null, 1) + '\n', { mode: 0o600 })
  chmodSync(configPath(profile), 0o600)
  rmSync(statePath(profile), { force: true })
}

export function removeSyncConfig(profile: string): void {
  rmSync(configPath(profile), { force: true })
  rmSync(statePath(profile), { force: true })
}
