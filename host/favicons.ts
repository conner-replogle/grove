// Favicons Grove fetched itself. The sidebar asks Chrome's favicon cache
// first, but it only holds icons of pages this profile's history still
// keeps, so a tab that hasn't loaded here lately (an unloaded pin, an
// Essential, a tab synced from another device) shows nothing. Those icons
// are downloaded once and kept as data URLs in grove-favicons.json in the
// profile.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

// Larger icons aren't kept: every state pushed to the windows carries them.
const MAX_BYTES = 32 * 1024
const TIMEOUT_MS = 8000
// The most kept; the longest unused go first.
const MAX_KEPT = 500
const TYPES: Record<string, string> = {
  ico: 'image/x-icon',
  png: 'image/png',
  svg: 'image/svg+xml',
  gif: 'image/gif',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp'
}

export class Favicons {
  private readonly saved = new Map<string, string>()
  // Icons being fetched, or that failed this launch (tried again next one).
  private readonly tried = new Set<string>()
  private saveQueued?: ReturnType<typeof setTimeout>
  private readonly path: string
  private readonly changed: () => void

  // `changed` is called once a fetched icon is in.
  constructor(path: string, changed: () => void) {
    this.path = path
    this.changed = changed
    try {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && v.startsWith('data:image/')) this.saved.set(k, v)
      }
    } catch {}
  }

  // The icon of a page (by its own icon URL, else its site's /favicon.ico)
  // as a data URL, or undefined while it's being fetched or if there's none.
  get(pageUrl: string, iconUrl: string | undefined): string | undefined {
    const url = iconUrl && /^https?:/.test(iconUrl) ? iconUrl : siteIcon(pageUrl)
    if (!url) return undefined
    const have = this.saved.get(url)
    if (have) {
      this.saved.delete(url)
      this.saved.set(url, have)
    }
    if (have || this.tried.has(url)) return have
    this.tried.add(url)
    void this.fetch(url).then((data) => {
      if (!data) return
      this.saved.set(url, data)
      for (const old of this.saved.keys()) {
        if (this.saved.size <= MAX_KEPT) break
        this.saved.delete(old)
      }
      this.queueSave()
      this.changed()
    })
    return undefined
  }

  private async fetch(url: string): Promise<string | undefined> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'image/*' } })
      if (!res.ok) return undefined
      const body = Buffer.from(await res.arrayBuffer())
      if (!body.length || body.length > MAX_BYTES) return undefined
      const given = res.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
      const type = given?.startsWith('image/') ? given : TYPES[/\.(\w+)$/.exec(new URL(url).pathname)?.[1].toLowerCase() ?? '']
      return type ? `data:${type};base64,${body.toString('base64')}` : undefined
    } catch {
      return undefined
    }
  }

  private queueSave(): void {
    this.saveQueued ??= setTimeout(() => {
      this.saveQueued = undefined
      try {
        writeFileSync(`${this.path}.tmp`, JSON.stringify(Object.fromEntries(this.saved)))
        renameSync(`${this.path}.tmp`, this.path)
      } catch {}
    }, 1000)
  }
}

function siteIcon(pageUrl: string): string | undefined {
  try {
    const u = new URL(pageUrl)
    return /^https?:$/.test(u.protocol) ? `${u.origin}/favicon.ico` : undefined
  } catch {
    return undefined
  }
}
