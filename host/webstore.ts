// Extensions from the Chrome Web Store, installed by Grove itself.
//
// ungoogled-chromium can't install from the Web Store (its "Add to Chrome"
// is disabled), and in Webium Chrome's install dialog never shows, so the
// install would hang anyway. Grove downloads the extension's CRX from
// Google's update server, checks it (the signature, and that it is the
// extension asked for), unpacks it into the profile and loads it as an
// unpacked extension. Its manifest gets the CRX's public key, so it keeps
// its Web Store id (and with it its data, and what talks to it by id).
// Grove also keeps them up to date (extensions.ts).
import { createHash, createPublicKey, verify } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'

// The Web Store page of an extension: chromewebstore.google.com/detail/<slug>/<id>
// (or the old chrome.google.com/webstore/detail/...).
export function storeExtensionId(url: string): string | undefined {
  const m =
    /^https:\/\/chromewebstore\.google\.com\/detail\/(?:[^/?#]+\/)?([a-p]{32})(?:[/?#]|$)/.exec(url) ??
    /^https:\/\/chrome\.google\.com\/webstore\/detail\/(?:[^/?#]+\/)?([a-p]{32})(?:[/?#]|$)/.exec(url)
  return m?.[1]
}

// Where Google's update server hands out an extension's latest CRX.
export function crxUrl(id: string, chromeVersion: string): string {
  const x = encodeURIComponent(`id=${id}&installsource=ondemand&uc`)
  return `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${chromeVersion}&acceptformat=crx3&x=${x}`
}

// An extension id is the first 16 bytes of its public key's SHA-256, each
// nibble written as a letter a-p.
export function extensionIdOf(publicKey: Buffer): string {
  const hash = createHash('sha256').update(publicKey).digest()
  return [...hash.subarray(0, 16)].map((b) => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join('')
}

export interface Crx {
  id: string
  // The developer's public key (DER, SubjectPublicKeyInfo).
  publicKey: Buffer
  zip: Buffer
}

// Reads a CRX3 and checks it: its signed id must be the developer key's
// id, and that key's signature must hold over the header and the zip.
export function readCrx(buf: Buffer): Crx {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'Cr24') throw new Error('not a CRX file')
  const version = buf.readUInt32LE(4)
  if (version !== 3) throw new Error(`CRX version ${version}; Grove reads version 3`)
  const headerSize = buf.readUInt32LE(8)
  const header = buf.subarray(12, 12 + headerSize)
  const zip = buf.subarray(12 + headerSize)

  const proofs: { publicKey: Buffer; signature: Buffer }[] = []
  let signedData: Buffer | undefined
  for (const [field, value] of protoFields(header)) {
    if (field === 2) {
      // AsymmetricKeyProof { 1: public_key, 2: signature } (sha256_with_rsa)
      const p = new Map(protoFields(value))
      if (p.get(1) && p.get(2)) proofs.push({ publicKey: p.get(1)!, signature: p.get(2)! })
    } else if (field === 10000) {
      signedData = value
    }
  }
  if (!signedData) throw new Error('the CRX has no signed id')
  const crxId = new Map(protoFields(signedData)).get(1)
  if (!crxId || crxId.length !== 16) throw new Error('the CRX has no signed id')
  const id = [...crxId].map((b) => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join('')

  const developer = proofs.find((p) => extensionIdOf(p.publicKey) === id)
  if (!developer) throw new Error("the CRX isn't signed by its own key")
  const size = Buffer.alloc(4)
  size.writeUInt32LE(signedData.length)
  const message = Buffer.concat([Buffer.from('CRX3 SignedData\0', 'latin1'), size, signedData, zip])
  const key = createPublicKey({ key: developer.publicKey, format: 'der', type: 'spki' })
  if (!verify('sha256', message, key, developer.signature)) throw new Error("the CRX's signature doesn't hold")
  return { id, publicKey: developer.publicKey, zip }
}

// The length-delimited fields of a protobuf message (all a CRX header has).
function* protoFields(buf: Buffer): Generator<[number, Buffer]> {
  let at = 0
  const varint = (): number => {
    let n = 0
    let shift = 0
    for (;;) {
      const b = buf[at++]
      if (b === undefined) throw new Error('bad CRX header')
      n += (b & 0x7f) * 2 ** shift
      if (!(b & 0x80)) return n
      shift += 7
    }
  }
  while (at < buf.length) {
    const key = varint()
    const field = Math.floor(key / 8)
    const wire = key & 7
    if (wire === 2) {
      const len = varint()
      yield [field, buf.subarray(at, at + len)]
      at += len
    } else if (wire === 0) varint()
    else if (wire === 5) at += 4
    else if (wire === 1) at += 8
    else throw new Error('bad CRX header')
  }
}

// Unpacks a zip (stored and deflated entries, as CRXs have) into `dir`.
export function unzip(zip: Buffer, dir: string): string[] {
  // The end of central directory record, searched from the end.
  let end = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i
      break
    }
  }
  if (end < 0) throw new Error('not a zip')
  const count = zip.readUInt16LE(end + 10)
  let at = zip.readUInt32LE(end + 16)
  const root = normalize(dir) + sep
  const files: string[] = []
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('bad zip directory')
    const method = zip.readUInt16LE(at + 10)
    const compressed = zip.readUInt32LE(at + 20)
    const nameLen = zip.readUInt16LE(at + 28)
    const extraLen = zip.readUInt16LE(at + 30)
    const commentLen = zip.readUInt16LE(at + 32)
    const local = zip.readUInt32LE(at + 42)
    const name = zip.toString('utf8', at + 46, at + 46 + nameLen)
    at += 46 + nameLen + extraLen + commentLen

    const target = normalize(join(dir, name))
    if (!target.startsWith(root)) throw new Error(`the zip has a path outside it: ${name}`)
    if (name.endsWith('/')) {
      mkdirSync(target, { recursive: true })
      continue
    }
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error('bad zip entry')
    const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const raw = zip.subarray(dataAt, dataAt + compressed)
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : undefined
    if (!data) throw new Error(`the zip uses compression ${method}`)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data)
    files.push(name)
  }
  return files
}

// Unpacks a checked CRX into `dir` (replacing what's there), with the key
// in its manifest so it loads under its Web Store id. Returns the manifest.
export function unpackCrx(crx: Crx, dir: string): Record<string, unknown> {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  unzip(crx.zip, dir)
  // Chrome's own records for a packed install; an unpacked one has none.
  rmSync(join(dir, '_metadata'), { recursive: true, force: true })
  const path = join(dir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>
  manifest.key = crx.publicKey.toString('base64')
  writeFileSync(path, JSON.stringify(manifest, null, 2))
  return manifest
}
