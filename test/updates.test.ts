import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assetName, compareVersions, Updater } from '../host/updates.ts'

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
      if (req.url === '/asset' && req.headers.accept === 'application/octet-stream') return res.writeHead(200).end(tarball)
      res.writeHead(404).end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    api = `http://127.0.0.1:${port}`
    release = {
      tag_name: 'v0.2.0',
      body: 'notes',
      html_url: 'https://example/r',
      assets: [{ name: assetName('0.2.0'), url: `${api}/asset`, browser_download_url: '' }]
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
})
