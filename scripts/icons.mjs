#!/usr/bin/env node
// Renders Grove's icons from branding/grove.svg (needs rsvg-convert):
//   branding/png/grove-<size>.png   the Linux icon theme sizes
//   branding/grove.icns             the macOS app icon
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
console.log(`icons: ${SIZES.length} PNGs and grove.icns in branding/`)
