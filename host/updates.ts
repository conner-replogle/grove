// Updates from GitHub releases (scripts/release.sh makes them).
//
// The host looks for a newer release at launch and every few hours, and the
// windows offer it (WindowState.update). Only an installed copy (install.sh
// or a bundle's start script writes `.installed` into it) updates itself: a
// checkout run with `pnpm dev` just says a release is out.
//
// Mostly a release only changes Grove's app: installing downloads its
// tarball (grove-ui-<version>.tar.gz), unpacks it next to the app and swaps
// the two directories; restarting Grove then runs the new one. A release
// that pins another Chromium or Node (grove-<version>.json) is a full
// update for an installed bundle (GROVE_BUNDLE): the whole bundle for this
// platform is unpacked beside it as <bundle>.new, and the start script
// swaps it in at the next start, once nothing runs from the old one.
// Every download is checked against the release's SHA256SUMS.
//
// The repository is public, so no token is needed; GROVE_GITHUB_TOKEN or
// GITHUB_TOKEN, if set, is sent (a higher rate limit, or a private fork).
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import type { UpdateStatus } from '../shared/protocol.ts'

const run = promisify(execFile)
const HOUR = 3_600_000

export interface UpdaterOptions {
  // The directory the launcher runs from (holds package.json).
  appDir: string
  // The installed bundle the app came with (GROVE_BUNDLE), if any.
  bundleDir?: string
  // Its platform, as bundles are named: linux-x64, macos-arm64, ...
  platform?: string
  repo?: string
  api?: string
  onChange: () => void
  log?: (...a: unknown[]) => void
}

interface Release {
  tag_name: string
  name?: string
  body?: string
  html_url: string
  draft?: boolean
  prerelease?: boolean
  assets: { name: string; url: string; browser_download_url: string }[]
}

// "1.2.10" > "1.2.9"; a leading "v" and anything after "-" or "+" are ignored.
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .replace(/^v/, '')
      .split(/[-+]/)[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0)
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return Math.sign(d)
  }
  return 0
}

export const assetName = (version: string): string => `grove-ui-${version.replace(/^v/, '')}.tar.gz`
export const bundleAssetName = (version: string, platform: string): string =>
  `grove-${version.replace(/^v/, '')}-${platform}.tar.xz`
export const pinsAssetName = (version: string): string => `grove-${version.replace(/^v/, '')}.json`

// This machine, as bundles are named.
export const currentPlatform = (): string =>
  `${process.platform === 'darwin' ? 'macos' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`

// What a bundle ships: its bundle.json (scripts/bundle.mjs).
export interface BundleInfo {
  version: string
  chromium: string
  node: string
}

// Where a bundle keeps bundle.json: at its top, or in Grove.app's Resources.
const bundleInfoPath = (bundle: string): string =>
  bundle.endsWith('.app') ? join(bundle, 'Contents/Resources/bundle.json') : join(bundle, 'bundle.json')

export function readBundleInfo(bundle: string): BundleInfo | undefined {
  try {
    const b = JSON.parse(readFileSync(bundleInfoPath(bundle), 'utf8'))
    return typeof b?.chromium === 'string' && typeof b?.node === 'string' ? b : undefined
  } catch {
    return undefined
  }
}

export class Updater {
  readonly current: string
  private readonly appDir: string
  private readonly bundleDir?: string
  private readonly platform: string
  private readonly repo: string
  private readonly api: string
  private readonly installed: boolean
  private readonly onChange: () => void
  private readonly log: (...a: unknown[]) => void
  private latest?: Release
  private state: UpdateStatus
  private timer?: ReturnType<typeof setInterval>
  // The last look at GitHub: under way, when it finished, what went wrong.
  private checking = false
  private checkedAt?: number
  private checkError?: string

  constructor(o: UpdaterOptions) {
    this.appDir = o.appDir
    this.bundleDir = o.bundleDir && readBundleInfo(o.bundleDir) ? o.bundleDir : undefined
    this.platform = o.platform ?? currentPlatform()
    this.repo = process.env.GROVE_UPDATE_REPO ?? o.repo ?? 'conner-replogle/grove'
    this.api = (process.env.GROVE_UPDATE_API ?? o.api ?? 'https://api.github.com').replace(/\/$/, '')
    this.onChange = o.onChange
    this.log = o.log ?? (() => {})
    this.current = readVersion(this.appDir)
    this.installed = existsSync(join(this.appDir, '.installed'))
    this.state = { state: 'none', current: this.current, installed: this.installed }
  }

  status(): UpdateStatus {
    return { ...this.state, checking: this.checking || undefined, checkedAt: this.checkedAt, checkError: this.checkError }
  }

  // Checks a minute after launch, then every six hours.
  start(): void {
    setTimeout(() => void this.check(), 60_000)
    this.timer = setInterval(() => void this.check(), 6 * HOUR)
  }

  stop(): void {
    clearInterval(this.timer)
  }

  async check(): Promise<void> {
    if (this.checking || this.state.state === 'downloading' || this.state.state === 'ready') return
    this.checking = true
    this.onChange()
    try {
      const release = await this.fetchLatest()
      this.checkError = undefined
      if (!release || compareVersions(release.tag_name, this.current) <= 0) {
        if (this.state.state !== 'none') this.set({ state: 'none' })
        return
      }
      this.latest = release
      this.set({
        state: 'available',
        version: release.tag_name.replace(/^v/, ''),
        notes: release.body?.slice(0, 2000),
        url: release.html_url
      })
    } catch (e) {
      // No network: try again next time, quietly (the settings say so).
      this.checkError = (e as Error).message
      this.log('update check:', this.checkError)
    } finally {
      this.checking = false
      this.checkedAt = Date.now()
      this.onChange()
    }
  }

  // Downloads and unpacks the latest release: over the app, or as a whole
  // new bundle when the release changes what the bundle ships. Either runs
  // at the next start.
  async install(): Promise<void> {
    const release = this.latest
    if (!release || !this.installed || this.state.state === 'downloading') return
    const version = release.tag_name.replace(/^v/, '')
    this.set({ state: 'downloading' })
    const work = join(tmpdir(), `grove-update-${process.pid}-${Date.now()}`)
    try {
      mkdirSync(work, { recursive: true })
      const sums = await this.checksums(release, work)
      if (await this.needsBundle(release, work)) await this.installBundle(release, version, sums, work)
      else await this.installApp(release, version, sums, work)
      this.set({ state: 'ready' })
    } catch (e) {
      this.fail((e as Error).message)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }

  // Whether this release pins another Chromium or Node than the installed
  // bundle has. Releases without pins, and copies without a bundle, update
  // just the app.
  private async needsBundle(release: Release, work: string): Promise<boolean> {
    const have = this.bundleDir && readBundleInfo(this.bundleDir)
    const asset = release.assets.find((a) => a.name === pinsAssetName(release.tag_name))
    if (!have || !asset) return false
    const file = await this.download(asset, work)
    const want = JSON.parse(readFileSync(file, 'utf8')) as Partial<BundleInfo>
    return want.chromium !== have.chromium || want.node !== have.node
  }

  private async installApp(release: Release, version: string, sums: Map<string, string>, work: string): Promise<void> {
    const asset = release.assets.find((a) => a.name === assetName(version))
    if (!asset) throw new Error(`release ${version} has no ${assetName(version)}`)
    const staged = `${this.appDir}.new`
    try {
      const file = await this.download(asset, work, sums)
      rmSync(staged, { recursive: true, force: true })
      mkdirSync(staged, { recursive: true })
      await run('tar', ['-xzf', file, '-C', staged])
      for (const needed of ['launcher/grove.mjs', 'dist/grove-ui.js', 'host/host.ts', 'extension/manifest.json']) {
        if (!existsSync(join(staged, needed))) throw new Error(`the release is missing ${needed}`)
      }
      if (compareVersions(readVersion(staged), version) !== 0) throw new Error('the release tarball has another version')
      writeFileSync(join(staged, '.installed'), `release ${version}\n`)
      const old = `${this.appDir}.old`
      rmSync(old, { recursive: true, force: true })
      renameSync(this.appDir, old)
      renameSync(staged, this.appDir)
      this.log(`installed Grove ${version}; it runs at the next start`)
    } catch (e) {
      rmSync(staged, { recursive: true, force: true })
      throw e
    }
  }

  // Unpacks the release's bundle for this platform as <bundle>.new, beside
  // the installed one (same filesystem, so the start script's swap is two
  // renames).
  private async installBundle(release: Release, version: string, sums: Map<string, string>, work: string): Promise<void> {
    const bundle = this.bundleDir!
    const name = bundleAssetName(version, this.platform)
    const asset = release.assets.find((a) => a.name === name)
    if (!asset) throw new Error(`release ${version} has no ${name}`)
    const unpack = `${bundle}.unpack`
    const staged = `${bundle}.new`
    try {
      const file = await this.download(asset, work, sums)
      rmSync(unpack, { recursive: true, force: true })
      mkdirSync(unpack, { recursive: true })
      await run('tar', ['-xJf', file, '-C', unpack])
      const top = join(unpack, bundle.endsWith('.app') ? 'Grove.app' : 'grove')
      if (readBundleInfo(top)?.version !== version) throw new Error(`${name} isn't a Grove ${version} bundle`)
      rmSync(staged, { recursive: true, force: true })
      renameSync(top, staged)
      this.log(`staged Grove ${version} (a new bundle); it runs at the next start`)
    } finally {
      rmSync(unpack, { recursive: true, force: true })
    }
  }

  // The release's SHA256SUMS: file name -> hash.
  private async checksums(release: Release, work: string): Promise<Map<string, string>> {
    const asset = release.assets.find((a) => a.name === 'SHA256SUMS')
    if (!asset) throw new Error(`release ${release.tag_name} has no SHA256SUMS`)
    const text = readFileSync(await this.download(asset, work), 'utf8')
    return new Map(
      text
        .split('\n')
        .map((l) => /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(l.trim()))
        .filter((m): m is RegExpExecArray => !!m)
        .map((m) => [m[2], m[1]])
    )
  }

  // Streams an asset to a file in `work`; with `sums`, it must match them.
  private async download(asset: Release['assets'][number], work: string, sums?: Map<string, string>): Promise<string> {
    const res = await fetch(asset.url, { headers: { ...(await this.headers()), Accept: 'application/octet-stream' } })
    if (!res.ok || !res.body) throw new Error(`download ${asset.name}: HTTP ${res.status}`)
    const file = join(work, asset.name)
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(file))
    if (sums) {
      const want = sums.get(asset.name)
      if (!want) throw new Error(`SHA256SUMS doesn't list ${asset.name}`)
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
      if (hash.digest('hex') !== want) throw new Error(`${asset.name} doesn't match SHA256SUMS`)
    }
    return file
  }

  private fail(error: string): void {
    this.log('update failed:', error)
    this.set({ state: 'error', error })
  }

  private set(change: Partial<UpdateStatus>): void {
    const { version, notes, url } = this.state
    this.state = { version, notes, url, ...change, current: this.current, installed: this.installed } as UpdateStatus
    this.onChange()
  }

  private async fetchLatest(): Promise<Release | undefined> {
    const res = await fetch(`${this.api}/repos/${this.repo}/releases/latest`, { headers: await this.headers() })
    if (res.status === 404) return undefined
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const release = (await res.json()) as Release
    return release.draft || release.prerelease ? undefined : release
  }

  private async headers(): Promise<Record<string, string>> {
    const token = await githubToken()
    return {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'grove-updater',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  }
}

async function githubToken(): Promise<string | undefined> {
  return process.env.GROVE_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN
}

function readVersion(dir: string): string {
  try {
    return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

// The directory above a file in the app (launcher/grove.mjs -> the app).
export const appDirOf = (file: string): string => dirname(dirname(file))
