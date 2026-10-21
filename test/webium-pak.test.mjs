import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { holdWebiumUi } from '../scripts/webium-pak.mjs'

// A version 5 .pak with these resources and one alias (id 9 -> entry 0).
function pak(resources) {
  const header = Buffer.alloc(12)
  header.writeUInt32LE(5, 0)
  header.writeUInt8(1, 4)
  header.writeUInt16LE(resources.length, 8)
  header.writeUInt16LE(1, 10)
  const alias = Buffer.alloc(4)
  alias.writeUInt16LE(9, 0)
  alias.writeUInt16LE(0, 2)
  const table = Buffer.alloc((resources.length + 1) * 6)
  let offset = 12 + table.length + alias.length
  resources.forEach(([id, data], i) => {
    table.writeUInt16LE(id, i * 6)
    table.writeUInt32LE(offset, i * 6 + 2)
    offset += data.length
  })
  table.writeUInt32LE(offset, resources.length * 6 + 2)
  return Buffer.concat([header, table, alias, ...resources.map(([, d]) => d)])
}

function entries(buf) {
  const n = buf.readUInt16LE(8)
  const at = (i) => buf.readUInt32LE(12 + i * 6 + 2)
  return new Map(Array.from({ length: n }, (_, i) => [buf.readUInt16LE(12 + i * 6), buf.subarray(at(i), at(i + 1))]))
}

describe('holdWebiumUi', () => {
  const page = '<html><style>html { margin: 0 }</style><webui-browser-app></webui-browser-app><script src="webui_browser.js"></script></html>'

  it("hides Webium's app until Grove's UI is in, and leaves the rest alone", () => {
    const file = join(mkdtempSync(join(tmpdir(), 'grove-pak-')), 'resources.pak')
    const other = Buffer.from('some other resource')
    const original = pak([
      [1, other],
      [2, gzipSync(page)],
      [3, Buffer.from('last')]
    ])
    writeFileSync(file, original)
    expect(holdWebiumUi(file)).toBe(true)
    const out = readFileSync(file)
    const e = entries(out)
    expect(e.get(1)).toEqual(other)
    expect(e.get(3)).toEqual(Buffer.from('last'))
    const html = gunzipSync(e.get(2)).toString()
    expect(html).toContain(':root.grove webui-browser-app')
    expect(html).toContain('<webui-browser-app>')
    // The alias table is kept.
    expect(out.subarray(12 + 4 * 6, 12 + 4 * 6 + 4)).toEqual(original.subarray(12 + 4 * 6, 12 + 4 * 6 + 4))
    // Patching again changes nothing.
    expect(holdWebiumUi(file)).toBe(false)
    expect(readFileSync(file)).toEqual(out)
  })

  it('refuses a pak without Webium', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'grove-pak-')), 'resources.pak')
    writeFileSync(file, pak([[1, Buffer.from('nothing here')]]))
    expect(() => holdWebiumUi(file)).toThrow(/no Webium page/)
  })
})
