#!/usr/bin/env node
// Starts a built Linux bundle the way an installed copy starts, in a home
// of its own, and waits for its app to say it came up (the launcher writes
// .healthy once a window's UI is up and the host has Chrome's tabs). The
// Release workflow runs it before publishing, under Xvfb:
//
//   node scripts/smoke.mjs release/grove-<version>-linux-x64.tar.xz
//
// Exits 0 once it's up, 1 (with the log) if it isn't within the time.
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TIMEOUT_MS = 120_000
const tarball = process.argv[2]
if (!tarball) {
  console.error('usage: node scripts/smoke.mjs <grove-<version>-linux-*.tar.xz>')
  process.exit(1)
}

const home = mkdtempSync(join(tmpdir(), 'grove-smoke-'))
execFileSync('tar', ['-xJf', tarball, '-C', home])
const env = { ...process.env, HOME: home }
for (const k of ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'GROVE_PROFILE', 'GROVE_CHROME', 'GROVE_BUNDLE']) delete env[k]
const healthy = join(home, '.local/share/grove/app/.healthy')
const log = join(home, '.cache/grove/grove.log')

// Its own process group, to stop Chrome and all with it.
const child = spawn(join(home, 'grove/grove'), ['about:blank'], { env, detached: true, stdio: 'ignore' })
const stop = () => {
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {}
}

const started = Date.now()
let ok = false
while (Date.now() - started < TIMEOUT_MS) {
  if (existsSync(healthy)) {
    ok = true
    break
  }
  if (child.exitCode !== null && child.exitCode !== 0) break
  await new Promise((r) => setTimeout(r, 500))
}
stop()
await new Promise((r) => setTimeout(r, 2000))
try {
  process.kill(-child.pid, 'SIGKILL')
} catch {}

if (ok) console.log(`smoke: Grove came up in ${((Date.now() - started) / 1000).toFixed(1)} s`)
else {
  console.error(`smoke: Grove didn't come up within ${TIMEOUT_MS / 1000} s`)
  try {
    console.error(readFileSync(log, 'utf8').slice(-8000))
  } catch {
    console.error('(no log)')
  }
}
rmSync(home, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
