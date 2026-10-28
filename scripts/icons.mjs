#!/usr/bin/env node
// Renders Grove's icons from branding/grove.svg (needs rsvg-convert):
//   branding/png/grove-<size>.png   the Linux icon theme sizes
//   branding/grove.icns             the macOS app icon
//   branding/grove.ico              the Windows icon (Grove.exe, chrome.exe)
// The results are committed, so building a release doesn't need this.
//
//   node scripts/icons.mjs
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('../branding/', import.meta.url))
const svg = `${dir}grove.svg`
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]

mkdirSync(`${dir}png`, { recursive: true })
const png = (size) => {
  const out = `${dir}png/grove-${size}.png`
  execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), svg, '-o', out])
  return readFileSync(out)
}
const pngs = new Map(SIZES.map((s) => [s, png(s)]))

// An .icns is 'icns' + its length, then chunks of type + length + PNG.
const CHUNKS = [
  ['icp4', 16],
  ['icp5', 32],
  ['ic11', 32], // 16@2x
  ['icp6', 64],
  ['ic12', 64], // 32@2x
  ['ic07', 128],
  ['ic08', 256],
  ['ic13', 256], // 128@2x
  ['ic09', 512],
  ['ic14', 512], // 256@2x
  ['ic10', 1024] // 512@2x
]
const chunks = CHUNKS.map(([type, size]) => {
  const data = pngs.get(size)
  const head = Buffer.alloc(8)
  head.write(type, 0, 'ascii')
  head.writeUInt32BE(data.length + 8, 4)
  return Buffer.concat([head, data])
})
const body = Buffer.concat(chunks)
const head = Buffer.alloc(8)
head.write('icns', 0, 'ascii')
head.writeUInt32BE(body.length + 8, 4)
writeFileSync(`${dir}grove.icns`, Buffer.concat([head, body]))

// An .ico: a header, a 16-byte entry per image (256 is written as 0), then
// the images, here PNGs.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const ico = Buffer.alloc(6 + 16 * ICO_SIZES.length)
ico.writeUInt16LE(1, 2)
ico.writeUInt16LE(ICO_SIZES.length, 4)
let offset = ico.length
ICO_SIZES.forEach((size, i) => {
  const e = 6 + 16 * i
  ico.writeUInt8(size % 256, e)
  ico.writeUInt8(size % 256, e + 1)
  ico.writeUInt16LE(1, e + 4)
  ico.writeUInt16LE(32, e + 6)
  ico.writeUInt32LE(pngs.get(size).length, e + 8)
  ico.writeUInt32LE(offset, e + 12)
  offset += pngs.get(size).length
})
writeFileSync(`${dir}grove.ico`, Buffer.concat([ico, ...ICO_SIZES.map((s) => pngs.get(s))]))
console.log(`icons: ${SIZES.length} PNGs, grove.icns and grove.ico in branding/`)
