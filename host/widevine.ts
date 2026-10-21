// Widevine, the DRM module video and music sites (Netflix, Spotify, Disney+)
// need. Chrome downloads it from Google's component updater; ungoogled-
// chromium doesn't, and its licence keeps Grove from shipping it. So Grove
// fetches it on each computer as Chrome does: it asks Google's component
// update service for the current Widevine, checks the download (the hash
// the service gives, and the CRX's signature by Widevine's key), unpacks
// it into <profile>/WidevineCdm/<version> and points Chromium's hint file
// at it. Chromium reads the hint at start-up, so a new Widevine is used
// from the next start on, as with Chrome's own updater.
//
// Linux only: on macOS Chromium looks for it inside its own app bundle.
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compareVersions } from './updates.ts'
import { readCrx, unzip } from './webstore.ts'

export const WIDEVINE_ID = 'oimompecagnajdejgnnjijobebaeigek'
const SERVICE = 'https://update.googleapis.com/service/update2/json'
const DAY = 86_400_000

export interface WidevineOptions {
  profile: string
  chromeVersion: () => string
  arch?: string
  log?: (...a: unknown[]) => void
  fetch?: typeof fetch
}

const baseDir = (profile: string): string => join(profile, 'WidevineCdm')
const hintPath = (profile: string): string => join(baseDir(profile), 'latest-component-updated-widevine-cdm')

// The version the hint points at, if its files are there.
export function installedWidevine(profile: string): string | undefined {
  try {
    const dir = (JSON.parse(readFileSync(hintPath(profile), 'utf8')) as { Path?: string }).Path
    if (!dir) return undefined
    return (JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { version?: string }).version
  } catch {
    return undefined
  }
}

// The service's answer (after its ")]}'" guard): the CRX to fetch, if newer.
export function parseComponentUpdate(text: string): { version: string; url: string; sha256: string } | undefined {
  const json = JSON.parse(text.replace(/^\)\]\}'\s*/, '')) as {
    response?: { app?: { updatecheck?: { status?: string; urls?: { url?: { codebase: string }[] }; manifest?: { version?: string; packages?: { package?: { name: string; hash_sha256: string }[] } } } }[] }
  }
  const check = json.response?.app?.[0]?.updatecheck
  if (check?.status !== 'ok') return undefined
  const base = check.urls?.url?.map((u) => u.codebase).find((c) => c.startsWith('https://'))
  const pkg = check.manifest?.packages?.package?.[0]
  if (!base || !pkg || !check.manifest?.version) return undefined
  return { version: check.manifest.version, url: base + pkg.name, sha256: pkg.hash_sha256 }
}

export class Widevine {
  private readonly o: WidevineOptions
  private readonly fetch: typeof fetch
  private readonly log: (...a: unknown[]) => void
  private timer?: ReturnType<typeof setInterval>

  constructor(o: WidevineOptions) {
    this.o = o
    this.fetch = o.fetch ?? fetch
    this.log = o.log ?? (() => {})
  }

  // Looks a minute after launch, then once a day.
  start(): void {
    setTimeout(() => void this.update(), 60_000)
    this.timer = setInterval(() => void this.update(), DAY)
  }

  stop(): void {
    clearInterval(this.timer)
  }

  async update(): Promise<void> {
    const have = installedWidevine(this.o.profile)
    try {
      const offer = await this.check(have ?? '0.0.0.0')
      if (!offer || (have && compareVersions(offer.version, have) <= 0)) return
      const res = await this.fetch(offer.url, { signal: AbortSignal.timeout(120_000) })
      if (!res.ok) throw new Error(`download: HTTP ${res.status}`)
      const raw = Buffer.from(await res.arrayBuffer())
      if (createHash('sha256').update(raw).digest('hex') !== offer.sha256) throw new Error("the download doesn't match its hash")
      const crx = readCrx(raw)
      if (crx.id !== WIDEVINE_ID) throw new Error(`the download is ${crx.id}, not Widevine`)
      const dir = join(baseDir(this.o.profile), offer.version)
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      for (const file of unzip(crx.zip, dir)) if (file.endsWith('.so')) chmodSync(join(dir, file), 0o755)
      rmSync(join(dir, '_metadata'), { recursive: true, force: true })
      writeFileSync(hintPath(this.o.profile), JSON.stringify({ Path: dir }))
      // Older versions go.
      for (const name of readdirSync(baseDir(this.o.profile))) {
        if (/^\d+\.\d+\.\d+\.\d+$/.test(name) && name !== offer.version) {
          rmSync(join(baseDir(this.o.profile), name), { recursive: true, force: true })
        }
      }
      this.log(`Widevine ${offer.version} installed; used from the next start`)
    } catch (e) {
      this.log('Widevine:', (e as Error).message)
    }
  }

  private async check(version: string) {
    const arch = this.o.arch ?? (process.arch === 'arm64' ? 'arm64' : 'x64')
    const body = {
      request: {
        '@os': 'linux',
        '@updater': 'chromium',
        acceptformat: 'crx3',
        app: [{ appid: WIDEVINE_ID, version, updatecheck: {} }],
        arch,
        os: { arch: arch === 'arm64' ? 'aarch64' : 'x86_64', platform: 'Linux', version: '6.0' },
        prodversion: this.o.chromeVersion(),
        protocol: '3.1',
        requestid: `{${randomUUID()}}`,
        sessionid: `{${randomUUID()}}`,
        updaterversion: this.o.chromeVersion()
      }
    }
    const res = await this.fetch(SERVICE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000)
    })
    if (!res.ok) throw new Error(`update check: HTTP ${res.status}`)
    return parseComponentUpdate(await res.text())
  }
}

export const widevineReady = (profile: string): boolean => existsSync(hintPath(profile)) && !!installedWidevine(profile)
