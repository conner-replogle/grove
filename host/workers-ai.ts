// The user's own Workers AI key, which Organize runs on (organize-ai.ts):
// a Cloudflare account id and an API token with Workers AI access, kept in
// <profile>/grove-workers-ai.json (readable only by the user). It stays on
// this device; the windows only learn whether there is one, and the
// account id.
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkersAiStatus } from '../shared/protocol.ts'
import type { AiRunner } from './organize-ai.ts'

export interface WorkersAiKey {
  accountId: string
  token: string
}

const API = 'https://api.cloudflare.com/client/v4'

export const keyPath = (profile: string): string => join(profile, 'grove-workers-ai.json')

export function readWorkersAiKey(profile: string): WorkersAiKey | undefined {
  try {
    const k = JSON.parse(readFileSync(keyPath(profile), 'utf8'))
    return typeof k?.accountId === 'string' && typeof k?.token === 'string' ? { accountId: k.accountId, token: k.token } : undefined
  } catch {
    return undefined
  }
}

export function writeWorkersAiKey(profile: string, key: WorkersAiKey): void {
  writeFileSync(keyPath(profile), JSON.stringify(key, null, 1) + '\n', { mode: 0o600 })
  chmodSync(keyPath(profile), 0o600)
}

export function removeWorkersAiKey(profile: string): void {
  rmSync(keyPath(profile), { force: true })
}

// What a key looks like when it's typed in: an account id is 32 hex digits.
export function checkKey(accountId: string, token: string): WorkersAiKey {
  const key = { accountId: accountId.trim().toLowerCase(), token: token.trim() }
  if (!/^[0-9a-f]{32}$/.test(key.accountId)) throw new Error('A Cloudflare account id is 32 letters and digits (0-9, a-f).')
  if (!/^\S{20,}$/.test(key.token)) throw new Error('That doesn’t look like a Cloudflare API token.')
  return key
}

interface CfResponse<T> {
  success?: boolean
  result?: T
  errors?: { code?: number; message?: string }[]
}

async function call<T>(key: WorkersAiKey, path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key.token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs)
  })
  const body = (await res.json().catch(() => ({}))) as CfResponse<T>
  if (!res.ok || body.success === false) {
    const why = body.errors?.map((e) => e.message).filter(Boolean).join('; ')
    throw new Error(`Cloudflare: ${res.status}${why ? ` ${why}` : ''}`)
  }
  return body.result as T
}

// Whether Cloudflare takes the token: account tokens and user tokens are
// checked in different places.
export async function verifyKey(key: WorkersAiKey): Promise<void> {
  try {
    await call(key, `/accounts/${key.accountId}/tokens/verify`, {}, 10_000)
  } catch {
    await call(key, '/user/tokens/verify', {}, 10_000).catch(() => {
      throw new Error('Cloudflare doesn’t take that API token for this account.')
    })
  }
}

// Workers AI's REST API, as organize-ai.ts runs models.
export function workersAi(key: WorkersAiKey): AiRunner {
  return {
    run: (model, input) => call(key, `/accounts/${key.accountId}/ai/run/${model}`, { method: 'POST', body: JSON.stringify(input) })
  }
}

// The key as the settings page drives it: set (checked with Cloudflare
// first), removed, and what the windows may know.
export class WorkersAiKeys {
  private key?: WorkersAiKey
  private busy = false
  private error?: string
  private readonly profile: string
  private readonly changed: () => void

  constructor(profile: string, changed: () => void) {
    this.profile = profile
    this.changed = changed
    this.key = readWorkersAiKey(profile)
  }

  status(): WorkersAiStatus {
    return { accountId: this.key?.accountId, busy: this.busy || undefined, error: this.error }
  }

  runner(): AiRunner | undefined {
    return this.key && workersAi(this.key)
  }

  async set(accountId: string, token: string): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.error = undefined
    this.changed()
    try {
      const key = checkKey(accountId, token)
      await verifyKey(key)
      writeWorkersAiKey(this.profile, key)
      this.key = key
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
    } finally {
      this.busy = false
      this.changed()
    }
  }

  clear(): void {
    removeWorkersAiKey(this.profile)
    this.key = undefined
    this.error = undefined
    this.changed()
  }
}
