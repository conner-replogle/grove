import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assetName, bundleAssetName, compareVersions, pinsAssetName, Updater } from '../host/updates.ts'

describe('compareVersions', () => {
  it('compares numerically, ignoring v and suffixes', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1)
    expect(compareVersions('v1.2.10', '1.2.9')).toBe(1)
    expect(compareVersions('1.0.0', 'v1.0.0')).toBe(0)
    expect(compareVersions('1.0.0-beta', '1.0.1')).toBe(-1)
  })
})

// A fake GitHub API serving one release whose asset is a real tarball.
describe('Updater', () => {
  let dir: string
  let server: Server
  let api: string
  let release: Record<string, unknown> | undefined
  let tarball: Buffer
  // What the fake server serves, by path.
  let files: Map<string, Buffer>
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
  const sums = (names: string[]) =>
    Buffer.from(names.map((n) => `${sha(files.get(`/${n}`)!)}  ${n}`).join('\n') + '\n')
  const asset = (name: string) => ({ name, url: `${api}/${name}`, browser_download_url: '' })

  const app = (version: string, installed = true): string => {
    const d = join(dir, 'grove-ui')
    for (const sub of ['launcher', 'dist', 'host', 'extension']) mkdirSync(join(d, sub), { recursive: true })
    writeFileSync(join(d, 'package.json'), JSON.stringify({ version }))
    writeFileSync(join(d, 'launcher/grove.mjs'), `// ${version}`)
    writeFileSync(join(d, 'dist/grove-ui.js'), '')
    writeFileSync(join(d, 'host/host.ts'), '')
    writeFileSync(join(d, 'extension/manifest.json'), '{}')
    if (installed) writeFileSync(join(d, '.installed'), 'test')
    return d
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'grove-updates-'))
    // The release's contents: version 0.2.0.
    const src = join(dir, 'src')
    for (const sub of ['launcher', 'dist', 'host', 'extension']) mkdirSync(join(src, sub), { recursive: true })
    writeFileSync(join(src, 'package.json'), JSON.stringify({ version: '0.2.0' }))
    writeFileSync(join(src, 'launcher/grove.mjs'), '// 0.2.0')
    writeFileSync(join(src, 'dist/grove-ui.js'), '')
    writeFileSync(join(src, 'host/host.ts'), '')
    writeFileSync(join(src, 'extension/manifest.json'), '{}')
    execFileSync('tar', ['-czf', join(dir, 'r.tgz'), '-C', src, 'launcher', 'dist', 'host', 'extension', 'package.json'])
    tarball = readFileSync(join(dir, 'r.tgz'))
    server = createServer((req, res) => {
      if (req.url === '/repos/o/r/releases/latest') {
        if (!release) return res.writeHead(404).end()
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(release))
      }
      const file = files.get(req.url ?? '')
      if (file && req.headers.accept === 'application/octet-stream') return res.writeHead(200).end(file)
      res.writeHead(404).end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    api = `http://127.0.0.1:${port}`
    files = new Map([[`/${assetName('0.2.0')}`, tarball]])
    files.set('/SHA256SUMS', sums([assetName('0.2.0')]))
    release = {
      tag_name: 'v0.2.0',
      body: 'notes',
      html_url: 'https://example/r',
      assets: [asset(assetName('0.2.0')), asset('SHA256SUMS')]
    }
    process.env.GROVE_GITHUB_TOKEN = 'test'
  })

  afterEach(() => {
    server.close()
    rmSync(dir, { recursive: true, force: true })
    delete process.env.GROVE_GITHUB_TOKEN
  })

  it('offers a newer release and installs it over the app', async () => {
    const appDir = app('0.1.0')
    const u = new Updater({ appDir, repo: 'o/r', api, onChange: () => {} })
    await u.check()
    expect(u.status()).toMatchObject({ state: 'available', version: '0.2.0', current: '0.1.0', installed: true })
    await u.install()
    expect(u.status().state).toBe('ready')
    expect(readFileSync(join(appDir, 'launcher/grove.mjs'), 'utf8')).toBe('// 0.2.0')
    expect(existsSync(join(appDir, '.installed'))).toBe(true)
    expect(readFileSync(join(`${appDir}.old`, 'launcher/grove.mjs'), 'utf8')).toBe('// 0.1.0')
  })

  it('stays quiet when up to date or there are no releases', async () => {
    const u = new Updater({ appDir: app('0.2.0'), repo: 'o/r', api, onChange: () => {} })
    await u.check()
    expect(u.status().state).toBe('none')
    release = undefined
    await u.check()
    expect(u.status().state).toBe('none')
  })

  it("doesn't install over a checkout, and reports a release without its tarball", async () => {
    const checkout = new Updater({ appDir: app('0.1.0', false), repo: 'o/r', api, onChange: () => {} })
    await checkout.check()
    await checkout.install()
    expect(checkout.status()).toMatchObject({ state: 'available', installed: false })
    rmSync(join(dir, 'grove-ui'), { recursive: true })
    release = { ...release, assets: [] }
    const u = new Updater({ appDir: app('0.1.0'), repo: 'o/r', api, onChange: () => {} })
    await u.check()
    await u.install()
    expect(u.status().state).toBe('error')
    expect(readFileSync(join(dir, 'grove-ui/launcher/grove.mjs'), 'utf8')).toBe('// 0.1.0')
  })

  it('refuses a download that differs from SHA256SUMS', async () => {
    files.set(`/${assetName('0.2.0')}`, Buffer.from('tampered'))
    const appDir = app('0.1.0')
    const u = new Updater({ appDir, repo: 'o/r', api, onChange: () => {} })
    await u.check()
    await u.install()
    expect(u.status()).toMatchObject({ state: 'error', error: expect.stringContaining('SHA256SUMS') })
    expect(readFileSync(join(appDir, 'launcher/grove.mjs'), 'utf8')).toBe('// 0.1.0')
  })

  describe('with an installed bundle', () => {
    const PLATFORM = 'linux-x64'
    const bundle = (chromium: string) => {
      const b = join(dir, 'opt/grove')
      mkdirSync(b, { recursive: true })
      writeFileSync(join(b, 'bundle.json'), JSON.stringify({ version: '0.1.0', chromium, node: '26.0.0', platform: PLATFORM }))
      return b
    }
    // Release 0.2.0 pins Chromium 155 and carries a whole bundle.
    const withPins = () => {
      const top = join(dir, 'newbundle/grove')
      mkdirSync(top, { recursive: true })
      writeFileSync(join(top, 'bundle.json'), JSON.stringify({ version: '0.2.0', chromium: '155', node: '26.0.0', platform: PLATFORM }))
      execFileSync('tar', ['-cJf', join(dir, 'b.txz'), '-C', join(dir, 'newbundle'), 'grove'])
      const names = [assetName('0.2.0'), pinsAssetName('0.2.0'), bundleAssetName('0.2.0', PLATFORM)]
      files.set(`/${names[1]}`, Buffer.from(JSON.stringify({ version: '0.2.0', chromium: '155', node: '26.0.0' })))
      files.set(`/${names[2]}`, readFileSync(join(dir, 'b.txz')))
      files.set('/SHA256SUMS', sums(names))
      release = { ...release, assets: [...names, 'SHA256SUMS'].map(asset) }
    }

    it('stages a whole new bundle when the release pins another Chromium', async () => {
      withPins()
      const appDir = app('0.1.0')
      const b = bundle('154')
      const u = new Updater({ appDir, bundleDir: b, platform: PLATFORM, repo: 'o/r', api, onChange: () => {} })
      await u.check()
      await u.install()
      expect(u.status().state).toBe('ready')
      expect(JSON.parse(readFileSync(join(`${b}.new`, 'bundle.json'), 'utf8')).chromium).toBe('155')
      // The app and the running bundle stay until the start script swaps.
      expect(readFileSync(join(appDir, 'launcher/grove.mjs'), 'utf8')).toBe('// 0.1.0')
      expect(JSON.parse(readFileSync(join(b, 'bundle.json'), 'utf8')).chromium).toBe('154')
    })

    it('updates just the app when the pins are the same', async () => {
      withPins()
      const appDir = app('0.1.0')
      const b = bundle('155')
      const u = new Updater({ appDir, bundleDir: b, platform: PLATFORM, repo: 'o/r', api, onChange: () => {} })
      await u.check()
      await u.install()
      expect(u.status().state).toBe('ready')
      expect(readFileSync(join(appDir, 'launcher/grove.mjs'), 'utf8')).toBe('// 0.2.0')
      expect(existsSync(`${b}.new`)).toBe(false)
    })
  })
})
