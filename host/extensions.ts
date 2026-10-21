// Web Store extensions Grove installs and keeps up to date (webstore.ts
// reads and checks their CRXs).
//
// Chrome installs them itself, as it would from the Web Store: Grove keeps
// each one's CRX in <profile>/Grove Extensions/<id>.crx and lists it in
// <profile>/External Extensions/<id>.json, which Chrome reads at start-up
// (a per-user "external extensions" source; Chromium on Linux installs
// those without asking). That install is a real one: it keeps its settings
// and hears onInstalled only once. Chrome reads the list only at start-up,
// so on Add the extension also runs at once from an unpacked copy loaded
// over DevTools (Extensions.loadUnpacked), which Chrome forgets at its next
// start, when the real install takes its place.
//
// Updating replaces the CRX and raises the listed version: Chrome installs
// it at its next start. Removing takes it off the list and turns it off
// now; Chrome uninstalls a listed extension that's no longer listed.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StoreOffer } from '../shared/protocol.ts'
import { compareVersions } from './updates.ts'
import { crxUrl, readCrx, unpackCrx } from './webstore.ts'

const HOUR = 3_600_000

interface Installed {
  name: string
  version: string
}

export interface ExtensionsOptions {
  profile: string
  // Chrome's version, which the update server wants.
  chromeVersion: () => string
  // Loads an unpacked extension for this session (CDP Extensions.loadUnpacked); its id.
  load: (dir: string) => Promise<string>
  // Takes it off: an unpacked one (CDP Extensions.uninstall), else turns it off.
  unload: (id: string) => Promise<void>
  // Chrome's warnings for a manifest (bridge: management API).
  warnings: (manifest: string) => Promise<string[]>
  // Whether Chrome has the extension installed some other way.
  installedElsewhere: (id: string) => Promise<boolean>
  onChange: () => void
  log?: (...a: unknown[]) => void
  fetch?: typeof fetch
}

const listPath = (profile: string): string => join(profile, 'grove-extensions.json')
const storeDir = (profile: string): string => join(profile, 'Grove Extensions')
const crxPath = (profile: string, id: string): string => join(storeDir(profile), `${id}.crx`)
// The unpacked copy an extension runs from in the session it was added.
const sessionDir = (profile: string, id: string): string => join(storeDir(profile), id)
const externalPath = (profile: string, id: string): string => join(profile, 'External Extensions', `${id}.json`)

function readList(profile: string): Record<string, Installed> {
  try {
    return JSON.parse(readFileSync(listPath(profile), 'utf8')) as Record<string, Installed>
  } catch {
    return {}
  }
}

// An extension's name as shown: __MSG_x__ comes from its default locale.
export function displayName(manifest: Record<string, unknown>, dir: string): string {
  const name = String(manifest.name ?? '')
  const m = /^__MSG_(.+)__$/.exec(name)
  if (!m) return name
  try {
    const locale = String(manifest.default_locale ?? 'en')
    const messages = JSON.parse(readFileSync(join(dir, '_locales', locale, 'messages.json'), 'utf8')) as Record<
      string,
      { message?: string }
    >
    const key = Object.keys(messages).find((k) => k.toLowerCase() === m[1].toLowerCase())
    return (key && messages[key].message) || name
  } catch {
    return name
  }
}

// The manifest's biggest icon, as a data: URL the windows can show.
function iconOf(manifest: Record<string, unknown>, dir: string): string | undefined {
  const icons = (manifest.icons ?? {}) as Record<string, string>
  const best = Object.keys(icons).sort((a, b) => Number(b) - Number(a))[0]
  const file = best && icons[best]
  if (!file || !/\.png$/i.test(file)) return undefined
  try {
    return `data:image/png;base64,${readFileSync(join(dir, file)).toString('base64')}`
  } catch {
    return undefined
  }
}

export class StoreExtensions {
  private readonly o: ExtensionsOptions
  private readonly fetch: typeof fetch
  private readonly log: (...a: unknown[]) => void
  private list: Record<string, Installed>
  // Offers being shown, by id: checking, waiting for the user, installing,
  // or what went wrong; with the CRX a confirmed one installs from.
  private readonly offers = new Map<string, StoreOffer>()
  private readonly staged = new Map<string, Buffer>()
  // Extensions Chrome has some other way, by id.
  private readonly elsewhere = new Map<string, boolean>()
  // Removed this session: off, and gone once Chrome restarts.
  private readonly removed = new Set<string>()
  private timer?: ReturnType<typeof setInterval>

  constructor(o: ExtensionsOptions) {
    this.o = o
    this.fetch = o.fetch ?? fetch
    this.log = o.log ?? (() => {})
    this.list = readList(o.profile)
    this.dropSessionCopies()
  }

  // Checks for updates a few minutes after launch, then twice a day.
  start(): void {
    setTimeout(() => void this.update(), 5 * 60_000)
    this.timer = setInterval(() => void this.update(), 12 * HOUR)
  }

  stop(): void {
    clearInterval(this.timer)
  }

  // What a window on this extension's Web Store page offers.
  status(id: string): StoreOffer {
    const offer = this.offers.get(id)
    if (offer) return offer
    const mine = this.list[id]
    if (mine) return { id, state: 'installed', name: mine.name, version: mine.version, managed: true }
    if (this.removed.has(id)) return { id, state: 'removed' }
    if (!this.elsewhere.has(id)) {
      this.elsewhere.set(id, false)
      void this.o
        .installedElsewhere(id)
        .then((yes) => {
          this.elsewhere.set(id, yes)
          if (yes) this.o.onChange()
        })
        .catch(() => {})
    }
    return this.elsewhere.get(id) ? { id, state: 'installed', managed: false } : { id, state: 'available' }
  }

  // Downloads and checks the extension, and asks the user (state 'confirm').
  async inspect(id: string): Promise<void> {
    if (this.offers.get(id)?.state === 'checking') return
    this.set({ id, state: 'checking' })
    try {
      const raw = await this.get(crxUrl(id, this.o.chromeVersion()))
      const crx = readCrx(raw)
      if (crx.id !== id) throw new Error(`Google sent ${crx.id}, not ${id}`)
      const dir = sessionDir(this.o.profile, id)
      const manifest = unpackCrx(crx, dir)
      const { key: _key, ...shown } = manifest
      const warnings = await this.o.warnings(JSON.stringify(shown)).catch(() => [])
      this.staged.set(id, raw)
      this.set({
        id,
        state: 'confirm',
        name: displayName(manifest, dir),
        version: String(manifest.version ?? ''),
        warnings,
        icon: iconOf(manifest, dir)
      })
    } catch (e) {
      this.fail(id, e)
    }
  }

  // Installs what inspect() staged: listed for Chrome to install at its next
  // start, and running from the unpacked copy until then.
  async install(id: string): Promise<void> {
    const offer = this.offers.get(id)
    const raw = this.staged.get(id)
    if (offer?.state !== 'confirm' || !raw) return
    this.set({ ...offer, state: 'installing' })
    try {
      this.list[id] = { name: offer.name ?? id, version: offer.version ?? '' }
      this.writeExternal(id, raw, this.list[id].version)
      this.save()
      const loaded = await this.o.load(sessionDir(this.o.profile, id))
      if (loaded !== id) throw new Error(`Chrome loaded it as ${loaded}, not ${id}`)
      this.staged.delete(id)
      this.offers.delete(id)
      this.log(`installed extension ${offer.name} ${offer.version}`)
      this.o.onChange()
    } catch (e) {
      this.fail(id, e)
    }
  }

  cancel(id: string): void {
    this.staged.delete(id)
    if (!this.list[id]) rmSync(sessionDir(this.o.profile, id), { recursive: true, force: true })
    this.offers.delete(id)
    this.o.onChange()
  }

  async remove(id: string): Promise<void> {
    if (!this.list[id]) return
    this.removed.add(id)
    this.forget(id)
    await this.o.unload(id).catch((e: unknown) => this.log('unload', e))
  }

  // Stops listing an extension (removed here, or in chrome://extensions).
  forget(id: string): void {
    this.elsewhere.delete(id)
    if (!this.list[id]) return
    delete this.list[id]
    this.save()
    rmSync(externalPath(this.o.profile, id), { force: true })
    rmSync(crxPath(this.o.profile, id), { force: true })
    this.o.onChange()
  }

  // Asks Google's update server about every extension Grove installed; a
  // newer version is listed for Chrome to install at its next start.
  async update(): Promise<void> {
    const ids = Object.keys(this.list)
    if (!ids.length) return
    const x = ids.map((id) => `x=${encodeURIComponent(`id=${id}&v=${this.list[id].version}&uc`)}`).join('&')
    const url = `https://clients2.google.com/service/update2/crx?response=updatecheck&acceptformat=crx3&prodversion=${this.o.chromeVersion()}&${x}`
    let xml: string
    try {
      const res = await this.fetch(url, { signal: AbortSignal.timeout(30_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      xml = await res.text()
    } catch (e) {
      return this.log('extension update check:', (e as Error).message)
    }
    for (const [id, version, codebase] of parseUpdates(xml)) {
      if (!this.list[id] || compareVersions(version, this.list[id].version) <= 0) continue
      try {
        const raw = await this.get(codebase)
        const crx = readCrx(raw)
        if (crx.id !== id) throw new Error(`the update is ${crx.id}, not ${id}`)
        this.writeExternal(id, raw, version)
        this.list[id] = { ...this.list[id], version }
        this.save()
        this.log(`extension ${this.list[id].name} ${version} installs at the next start`)
      } catch (e) {
        this.log(`extension update ${id}:`, (e as Error).message)
      }
    }
  }

  private writeExternal(id: string, crx: Buffer, version: string): void {
    mkdirSync(storeDir(this.o.profile), { recursive: true })
    writeFileSync(crxPath(this.o.profile, id), crx)
    mkdirSync(join(this.o.profile, 'External Extensions'), { recursive: true })
    const entry = { external_crx: crxPath(this.o.profile, id), external_version: version }
    writeFileSync(externalPath(this.o.profile, id), JSON.stringify(entry, null, 1) + '\n')
  }

  // Chrome forgets the unpacked copies DevTools loaded once it restarts.
  private dropSessionCopies(): void {
    const dir = storeDir(this.o.profile)
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      if (/^[a-p]{32}$/.test(name)) rmSync(join(dir, name), { recursive: true, force: true })
    }
  }

  private async get(url: string): Promise<Buffer> {
    const res = await this.fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) })
    if (res.status === 204) throw new Error("the Web Store doesn't offer this extension for this browser")
    if (!res.ok) throw new Error(`download: HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }

  private set(offer: StoreOffer): void {
    this.offers.set(offer.id, offer)
    this.o.onChange()
  }

  private fail(id: string, e: unknown): void {
    this.staged.delete(id)
    const error = e instanceof Error ? e.message : String(e)
    this.log(`extension ${id}:`, error)
    this.set({ id, state: 'error', error })
  }

  private save(): void {
    writeFileSync(listPath(this.o.profile), JSON.stringify(this.list, null, 1) + '\n')
  }
}

// The update server's answer: [id, version, CRX url] for each update.
export function parseUpdates(xml: string): [string, string, string][] {
  const out: [string, string, string][] = []
  for (const m of xml.matchAll(/<app\b[^>]*\bappid="([a-p]{32})"[^>]*>([\s\S]*?)<\/app>/g)) {
    const check = /<updatecheck\b([^>]*)>/.exec(m[2])?.[1] ?? ''
    const version = /\bversion="([^"]+)"/.exec(check)?.[1]
    const codebase = /\bcodebase="([^"]+)"/.exec(check)?.[1]
    if (version && codebase && /\bstatus="ok"/.test(check)) out.push([m[1], version, codebase.replace(/&amp;/g, '&')])
  }
  return out
}
