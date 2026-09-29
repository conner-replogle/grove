// Bundles src/ into dist/grove-ui.js: one classic script, injected into
// chrome://webui-browser before its own scripts run. Chrome's modules
// (//resources/..., /tab_strip_api/...) stay external and are loaded at
// runtime with import() from the binary itself.
import * as esbuild from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

export const options = {
  entryPoints: [`${root}src/main.ts`],
  outfile: `${root}dist/grove-ui.js`,
  bundle: true,
  format: 'iife',
  target: 'chrome150',
  sourcemap: 'inline',
  loader: { '.css': 'text', '.svg': 'text' },
  external: ['//resources/*', '/tab_strip_api/*', 'chrome://*'],
  logLevel: 'warning'
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await esbuild.build(options)
  console.log('built dist/grove-ui.js')
}
