// Updates from GitHub releases (scripts/release.sh makes them).
//
// The host looks for a newer release at launch and every few hours, and the
// windows offer it (WindowState.update). Installing downloads the release's
// prebuilt tarball, unpacks it next to the installed copy and swaps the two
// directories; restarting Grove then runs the new one. Only the installed
// copy (install.sh writes `.installed` into it) updates itself: a checkout
// run with `pnpm dev` just says a release is out.
//
// The repository is private, so the GitHub API needs a token:
// GROVE_GITHUB_TOKEN or GITHUB_TOKEN, else the GitHub CLI's (`gh auth token`).
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { UpdateStatus } from '../shared/protocol.ts'

const run = promisify(execFile)
const HOUR = 3_600_000

export interface UpdaterOptions {
  // The directory the launcher runs from (holds package.json).
  appDir: string
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

export class Updater {
  readonly current: string
  private readonly appDir: string
  private readonly repo: string
  private readonly api: string
  private readonly installed: boolean
  private readonly onChange: () => void
  private readonly log: (...a: unknown[]) => void
  private latest?: Release
  private state: UpdateStatus
  private timer?: ReturnType<typeof setInterval>

  constructor(o: UpdaterOptions) {
    this.appDir = o.appDir
    this.repo = process.env.GROVE_UPDATE_REPO ?? o.repo ?? 'conner-replogle/grove'
    this.api = (process.env.GROVE_UPDATE_API ?? o.api ?? 'https://api.github.com').replace(/\/$/, '')
    this.onChange = o.onChange
    this.log = o.log ?? (() => {})
    this.current = readVersion(this.appDir)
    this.installed = existsSync(join(this.appDir, '.installed'))
    this.state = { state: 'none', current: this.current, installed: this.installed }
  }

  status(): UpdateStatus {
    return this.state
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
    if (this.state.state === 'downloading' || this.state.state === 'ready') return
    try {
      const release = await this.fetchLatest()
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
      // No network or no token: try again next time, quietly.
      this.log('update check:', (e as Error).message)
    }
  }

  // Downloads and unpacks the latest release over the installed copy. The
  // running launcher keeps its loaded code; the next start runs the new one.
  async install(): Promise<void> {
    const release = this.latest
    if (!release || !this.installed || this.state.state === 'downloading') return
    const version = release.tag_name.replace(/^v/, '')
    const asset = release.assets.find((a) => a.name === assetName(version))
    if (!asset) return this.fail(`release ${version} has no ${assetName(version)}`)
    this.set({ state: 'downloading' })
    const work = join(tmpdir(), `grove-update-${process.pid}-${Date.now()}`)
    const staged = `${this.appDir}.new`
    try {
      mkdirSync(work, { recursive: true })
      const res = await fetch(asset.url, { headers: { ...(await this.headers()), Accept: 'application/octet-stream' } })
      if (!res.ok) throw new Error(`download: HTTP ${res.status}`)
      const file = join(work, asset.name)
      writeFileSync(file, Buffer.from(await res.arrayBuffer()))
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
      this.set({ state: 'ready' })
    } catch (e) {
      rmSync(staged, { recursive: true, force: true })
      this.fail((e as Error).message)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
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

let cachedToken: string | undefined
async function githubToken(): Promise<string | undefined> {
  const env = process.env.GROVE_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN
  if (env) return env
  if (cachedToken) return cachedToken
  try {
    const { stdout } = await run('gh', ['auth', 'token'], { timeout: 5000 })
    cachedToken = stdout.trim() || undefined
  } catch {
    cachedToken = undefined
  }
  return cachedToken
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
