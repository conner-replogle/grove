// Patches the Chromium a bundle ships (scripts/bundle.mjs) so a new window
// never shows Webium's own UI before Grove's.
//
// Grove's UI goes into a window over DevTools, and Chrome draws the window
// before the launcher can reach it (it doesn't hold browser UI pages for a
// debugger), so Webium's tab strip and toolbar would show for a moment.
// Instead, Webium's page (chrome://webui-browser, in resources.pak) starts
// with its app hidden, and Grove shows it once its own UI is in (main.ts
// puts the `grove` class on <html>). Should Grove never come, the app shows
// anyway after a few seconds.
import { readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync, gzipSync } from 'node:zlib'

const HOLD = `
    /* Grove: Webium's own UI stays hidden until Grove's has taken over. */
    :root { color-scheme: light dark; background: light-dark(#e2e2e2, #101010); }
    webui-browser-app { opacity: 0; animation: grove-reveal 0s 4s forwards; }
    :root.grove webui-browser-app { opacity: 1; animation: none; }
    @keyframes grove-reveal { to { opacity: 1; } }
  </style>`

// A .pak (version 5): a header, a table of (id, offset) with one entry past
// the last, aliases (id, entry index), then the resources' data.
function readPak(buf) {
  const version = buf.readUInt32LE(0)
  if (version !== 5) throw new Error(`resources.pak version ${version}; this knows version 5`)
  const count = buf.readUInt16LE(8)
  const aliasCount = buf.readUInt16LE(10)
  const table = 12
  const entries = []
  for (let i = 0; i <= count; i++) entries.push({ id: buf.readUInt16LE(table + i * 6), offset: buf.readUInt32LE(table + i * 6 + 2) })
  const aliasStart = table + (count + 1) * 6
  const aliases = buf.subarray(aliasStart, aliasStart + aliasCount * 4)
  const resources = entries.slice(0, count).map((e, i) => ({ id: e.id, data: buf.subarray(e.offset, entries[i + 1].offset) }))
  return { header: buf.subarray(0, table), aliases, resources }
}

function writePak({ header, aliases, resources }) {
  const tableSize = (resources.length + 1) * 6
  let offset = header.length + tableSize + aliases.length
  const table = Buffer.alloc(tableSize)
  resources.forEach((r, i) => {
    table.writeUInt16LE(r.id, i * 6)
    table.writeUInt32LE(offset, i * 6 + 2)
    offset += r.data.length
  })
  table.writeUInt16LE(0, resources.length * 6)
  table.writeUInt32LE(offset, resources.length * 6 + 2)
  return Buffer.concat([header, table, aliases, ...resources.map((r) => r.data)])
}

const gzipped = (d) => d[0] === 0x1f && d[1] === 0x8b

// Patches the resources.pak at `path` in place; false if it's patched already.
export function holdWebiumUi(path) {
  const pak = readPak(readFileSync(path))
  const page = pak.resources.find((r) => {
    const html = (gzipped(r.data) ? gunzipSync(r.data) : r.data).toString('utf8')
    return html.includes('<webui-browser-app') && html.includes('webui_browser.js')
  })
  if (!page) throw new Error(`no Webium page in ${path}`)
  const html = (gzipped(page.data) ? gunzipSync(page.data) : page.data).toString('utf8')
  if (html.includes('grove-reveal')) return false // already patched
  if (!html.includes('</style>')) throw new Error("Webium's page has no <style> to add to")
  const patched = Buffer.from(html.replace('</style>', HOLD), 'utf8')
  page.data = gzipped(page.data) ? gzipSync(patched, { level: 9 }) : patched
  writeFileSync(path, writePak(pak))
  return true
}

// node scripts/webium-pak.mjs <resources.pak>
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(holdWebiumUi(process.argv[2]) ? 'patched' : 'already patched')
}
