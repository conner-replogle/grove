import { generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { parseUpdates, StoreExtensions } from '../host/extensions.ts'
import { extensionIdOf, readCrx, storeExtensionId, unpackCrx } from '../host/webstore.ts'

// A zip of these files (deflated), as a CRX holds.
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(text))
    const n = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(text.length, 22)
    local.writeUInt16LE(n.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(text.length, 24)
    central.writeUInt16LE(n.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, n, data)
    centrals.push(central, n)
    offset += local.length + n.length + data.length
  }
  const dir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}

// Protobuf: a length-delimited field.
const field = (n: number, data: Buffer): Buffer => {
  const varint = (v: number): Buffer => {
    const out: number[] = []
    while (v >= 0x80) {
      out.push((v & 0x7f) | 0x80)
      v = Math.floor(v / 128)
    }
    out.push(v)
    return Buffer.from(out)
  }
  return Buffer.concat([varint(n * 8 + 2), varint(data.length), data])
}

// A CRX3 signed by a fresh key, as the Web Store serves them.
function makeCrx(manifest: Record<string, unknown>) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const der = publicKey.export({ type: 'spki', format: 'der' })
  const id = extensionIdOf(der)
  const crxId = Buffer.from(id.split('').map((c, i, a) => (i % 2 ? -1 : ((c.charCodeAt(0) - 97) << 4) | (a[i + 1].charCodeAt(0) - 97))).filter((b) => b >= 0))
  const signedData = field(1, crxId)
  const body = zip({ 'manifest.json': JSON.stringify(manifest), 'icon.png': 'png' })
  const size = Buffer.alloc(4)
  size.writeUInt32LE(signedData.length)
  const signature = sign('sha256', Buffer.concat([Buffer.from('CRX3 SignedData\0'), size, signedData, body]), privateKey)
  const header = Buffer.concat([field(2, Buffer.concat([field(1, der), field(2, signature)])), field(10000, signedData)])
  const head = Buffer.alloc(12)
  head.write('Cr24', 0, 'latin1')
  head.writeUInt32LE(3, 4)
  head.writeUInt32LE(header.length, 8)
  return { id, der, crx: Buffer.concat([head, header, body]) }
}

describe('Web Store CRXs', () => {
  it('finds the extension a store page is about', () => {
    expect(storeExtensionId('https://chromewebstore.google.com/detail/dark-reader/eimadpbcbfnmbkopoojfekhnkhdbieeh')).toBe(
      'eimadpbcbfnmbkopoojfekhnkhdbieeh'
    )
    expect(storeExtensionId('https://chromewebstore.google.com/detail/eimadpbcbfnmbkopoojfekhnkhdbieeh?hl=en')).toBe(
      'eimadpbcbfnmbkopoojfekhnkhdbieeh'
    )
    expect(storeExtensionId('https://chromewebstore.google.com/category/extensions')).toBeUndefined()
    expect(storeExtensionId('https://example.com/detail/x/eimadpbcbfnmbkopoojfekhnkhdbieeh')).toBeUndefined()
  })

  it('reads a signed CRX, refuses a changed one, and unpacks it with its key', () => {
    const { id, der, crx } = makeCrx({ manifest_version: 3, name: 'Test', version: '1.2.3' })
    const read = readCrx(crx)
    expect(read.id).toBe(id)
    const bad = Buffer.from(crx)
    bad[bad.length - 30] ^= 1
    expect(() => readCrx(bad)).toThrow()
    const dir = join(mkdtempSync(join(tmpdir(), 'grove-crx-')), 'x')
    const manifest = unpackCrx(read, dir)
    expect(manifest).toMatchObject({ name: 'Test', version: '1.2.3', key: der.toString('base64') })
    expect(readFileSync(join(dir, 'icon.png'), 'utf8')).toBe('png')
  })

  it('reads the update server’s answer', () => {
    const xml = `<?xml version="1.0"?><gupdate><app appid="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" status="ok"><updatecheck status="ok" version="2.0" codebase="https://x/a.crx?a=1&amp;b=2"/></app><app appid="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" status="ok"><updatecheck status="noupdate"/></app></gupdate>`
    expect(parseUpdates(xml)).toEqual([['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '2.0', 'https://x/a.crx?a=1&b=2']])
  })
})

describe('StoreExtensions', () => {
  it('asks, installs for Chrome to keep, runs it now, updates it and removes it', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'grove-ext-'))
    const v1 = makeCrx({ manifest_version: 3, name: 'Test', version: '1.0', permissions: ['tabs'] })
    let served = v1.crx
    const loaded: string[] = []
    const unloaded: string[] = []
    const ext = new StoreExtensions({
      profile,
      chromeVersion: () => '155.0.0.0',
      load: async (dir) => {
        loaded.push(dir)
        return v1.id
      },
      unload: async (id) => void unloaded.push(id),
      warnings: async (m) => (JSON.parse(m).permissions?.includes('tabs') ? ['Read your browsing history'] : []),
      installedElsewhere: async () => false,
      onChange: () => {},
      fetch: (async (url: string) => {
        if (String(url).includes('response=updatecheck')) {
          return new Response(
            `<gupdate><app appid="${v1.id}"><updatecheck status="ok" version="1.1" codebase="https://x/new.crx"/></app></gupdate>`
          )
        }
        return new Response(served)
      }) as unknown as typeof fetch
    })
    expect(ext.status(v1.id).state).toBe('available')
    await ext.inspect(v1.id)
    expect(ext.status(v1.id)).toMatchObject({ state: 'confirm', name: 'Test', version: '1.0', warnings: ['Read your browsing history'] })
    await ext.install(v1.id)
    expect(ext.status(v1.id)).toMatchObject({ state: 'installed', managed: true, version: '1.0' })
    const entry = JSON.parse(readFileSync(join(profile, 'External Extensions', `${v1.id}.json`), 'utf8'))
    expect(entry).toEqual({ external_crx: join(profile, 'Grove Extensions', `${v1.id}.crx`), external_version: '1.0' })
    expect(readFileSync(entry.external_crx)).toEqual(v1.crx)
    expect(loaded).toEqual([join(profile, 'Grove Extensions', v1.id)])

    // An update from the same developer (same key would be the real case;
    // here a CRX of another id is refused, the right one listed).
    served = makeCrx({ manifest_version: 3, name: 'Other', version: '1.1' }).crx
    await ext.update()
    expect(ext.status(v1.id).version).toBe('1.0')
    served = v1.crx
    await ext.update()
    expect(ext.status(v1.id).version).toBe('1.1')
    expect(JSON.parse(readFileSync(join(profile, 'External Extensions', `${v1.id}.json`), 'utf8')).external_version).toBe('1.1')

    await ext.remove(v1.id)
    expect(unloaded).toEqual([v1.id])
    expect(existsSync(join(profile, 'External Extensions', `${v1.id}.json`))).toBe(false)
    expect(ext.status(v1.id).state).toBe('removed')
  })
})
