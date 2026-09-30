#!/usr/bin/env node
// The Grove launcher and host. Starts Grove (Chromium with its WebUI
// browser, "Webium") and:
//   - injects Grove's UI into every browser window before the window's own
//     scripts run;
//   - loads the Grove bridge extension and drives Chrome's cross-window tab
//     APIs through it;
//   - runs the Grove host (host/host.ts), the one workspace model every
//     window shares.
//
//   node launcher/grove.mjs [--dev] [url...]
//
// --dev rebuilds src/ on save, reloads the windows' UI and logs to stdout.
//
//   GROVE_CHROME   the browser binary     (default: the system chromium; any
//                  Chromium 152+ with Webium works, e.g. ungoogled-chromium.
//                  Not the Grove Chromium fork: its own C++ workspace service
//                  restores and mirrors tabs itself and fights this host)
//   GROVE_PROFILE  the profile directory  (default ~/.config/grove-webium)
import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GroveHost } from '../host/host.ts'
import { Store } from '../host/store.ts'
import { UI_BINDING, UI_RECEIVER } from '../shared/protocol.ts'
import { PipeCDP } from './cdp.mjs'

const home = homedir()
const CHROME = process.env.GROVE_CHROME ?? '/usr/bin/chromium'
const PROFILE = process.env.GROVE_PROFILE ?? `${home}/.config/grove-webium`
const FEATURES = 'Webium,SurfaceEmbed,ExtensionsMenuAccessControl'
const BUNDLE = fileURLToPath(new URL('../dist/grove-ui.js', import.meta.url))
const EXTENSION = fileURLToPath(new URL('../extension', import.meta.url))
const UI_URL = 'chrome://webui-browser'
const BRIDGE_SCRIPT = '/grove-bridge.js'

const dev = process.argv.includes('--dev')
const urls = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const log = (...a) => dev && console.log('[grove]', ...a)

// Grove's host restores the workspaces, so Chrome must not also restore its
// own last session (every restart would duplicate the tabs): drop Chrome's
// session files, start each session on a fresh window, and don't offer
// crash restore.
function prepareProfile() {
  const dir = join(PROFILE, 'Default')
  rmSync(join(dir, 'Sessions'), { recursive: true, force: true })
  let names = []
  try {
    names = readdirSync(dir)
  } catch {}
  for (const name of names) {
    if (/^(Session_|Tabs_|Current Session|Current Tabs|Last Session|Last Tabs)/.test(name)) {
      rmSync(join(dir, name), { force: true })
    }
  }
  const file = join(dir, 'Preferences')
  let prefs = {}
  try {
    prefs = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    mkdirSync(dir, { recursive: true })
  }
  prefs.session = { ...prefs.session, restore_on_startup: 5 }
  prefs.profile = { ...prefs.profile, exit_type: 'Normal', exited_cleanly: true }
  writeFileSync(file, JSON.stringify(prefs))
}
prepareProfile()

const chrome = spawn(
  CHROME,
  [
    `--user-data-dir=${PROFILE}`,
    `--enable-features=${FEATURES}`,
    `--load-extension=${EXTENSION}`,
    '--remote-debugging-pipe',
    '--ozone-platform-hint=auto',
    '--no-first-run',
    '--no-default-browser-check',
    ...urls
  ],
  { stdio: ['ignore', 'ignore', dev ? 'inherit' : 'ignore', 'pipe', 'pipe'] }
)
chrome.on('exit', (code) => {
  host.flush()
  process.exit(code ?? 0)
})
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => chrome.kill('SIGTERM'))

const cdp = new PipeCDP(chrome.stdio[3], chrome.stdio[4])
let bundle = readFileSync(BUNDLE, 'utf8')

// ---- The host and the windows' UI ----

// UI session id -> { windowId, script: new-document script id }
const uiSessions = new Map()
const sessionOfWindow = (windowId) => [...uiSessions].find(([, s]) => s.windowId === windowId)?.[0]

const host = new GroveHost(
  new Store(join(PROFILE, 'grove-workspaces.json')),
  {
    push(windowId, state) {
      const sessionId = sessionOfWindow(windowId)
      if (!sessionId) return
      const expression = `window.${UI_RECEIVER}?.update(${JSON.stringify(state)})`
      cdp.send('Runtime.evaluate', { expression }, sessionId).catch(() => {})
    }
  },
  log
)

// DevTools can't say which window a chrome://webui-browser page belongs to
// (Browser.getWindowForTarget: "Browser window not found"), but the page's
// own Tab Strip API can: its snapshot is rooted at the window's node, whose
// id carries the window's session id, the same id chrome.windows uses.
async function windowOfUi(sessionId) {
  const expression = `(async () => {
    const m = await import('/tab_strip_api/tab_strip_api.mojom-webui.js')
    const s = await m.TabStripService.getRemote().getTabs()
    return s.tabStrip.data.window.id
  })()`
  for (let i = 0; i < 100; i++) {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
    if (r.result?.value) return r.result.value
    await new Promise((res) => setTimeout(res, 50))
  }
  throw new Error('could not find the window of a browser UI page')
}

// A command that gets no reply in time. A window's UI page sometimes drops
// DevTools commands while it is still settling right after start-up.
function timed(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: no reply in ${ms}ms`)), ms))
  ])
}

async function attachUi(sessionId, targetInfo, waiting) {
  const send = (method, params = {}) => timed(cdp.send(method, params, sessionId), 3000, method)
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Runtime.addBinding', { name: UI_BINDING })
  // runImmediately only applies to a page paused at start; on a running
  // page the call never returns.
  const { identifier } = await send(
    'Page.addScriptToEvaluateOnNewDocument',
    waiting ? { source: bundle, runImmediately: true } : { source: bundle }
  )
  if (waiting) await send('Runtime.runIfWaitingForDebugger')
  else await send('Runtime.evaluate', { expression: bundle })
  const nodeId = await timed(windowOfUi(sessionId), 8000, 'window lookup')
  log('window node', nodeId)
  const windowId = Number(String(nodeId).split(':')[0])
  uiSessions.set(sessionId, { windowId, script: identifier })
  // The UI's own hello may have come before its window was known; this one
  // tells the host the window's UI is up.
  await host.command(windowId, { type: 'hello' })
}

// ---- The bridge extension ----

let bridgeSession
let hostAttached = false
const bridge = {
  async call(fn, arg) {
    if (!bridgeSession) throw new Error('bridge not connected')
    const expression = `globalThis.grove.${fn}(${arg === undefined ? '' : JSON.stringify(arg)})`
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, bridgeSession)
    if (r.exceptionDetails) {
      throw new Error(`${fn}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
    }
    return r.result.value
  }
}

async function attachBridge(sessionId, waiting) {
  await cdp.send('Runtime.enable', {}, sessionId)
  await cdp.send('Runtime.addBinding', { name: 'groveEmit' }, sessionId)
  if (waiting) await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId)
  bridgeSession = sessionId
  // Wait for the worker's script to define globalThis.grove.
  for (let i = 0; i < 100; i++) {
    const r = await cdp.send('Runtime.evaluate', { expression: 'typeof globalThis.grove', returnByValue: true }, sessionId)
    if (r.result.value === 'object') break
    await new Promise((res) => setTimeout(res, 50))
  }
  log('bridge connected')
  if (!hostAttached) {
    hostAttached = true
    await host.attach(bridge)
  }
  await bridge.call('ready')
}

// ---- DevTools events ----

// Browser UI targets already being set up, so a page reached both by
// auto-attach and by the discovery fallback is only set up once.
const uiTargets = new Set()

cdp.on('Target.attachedToTarget', async ({ sessionId, targetInfo, waitingForDebugger }) => {
  try {
    if (targetInfo.type === 'browser_ui' && targetInfo.url.startsWith(UI_URL)) {
      if (uiTargets.has(targetInfo.targetId)) {
        if (waitingForDebugger) await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId)
        await cdp.send('Target.detachFromTarget', { sessionId })
        return
      }
      uiTargets.add(targetInfo.targetId)
      try {
        await attachUi(sessionId, targetInfo, waitingForDebugger)
      } catch (e) {
        // Start over on a fresh session a moment later.
        log('ui attach stalled, retrying:', e.message)
        await timed(cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId), 1000, 'resume').catch(() => {})
        uiTargets.delete(targetInfo.targetId)
        uiSessions.delete(sessionId)
        await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {})
        setTimeout(() => {
          if (uiTargets.has(targetInfo.targetId)) return
          cdp.send('Target.attachToTarget', { targetId: targetInfo.targetId, flatten: true }).catch(() => {})
        }, 1000)
      }
    } else if (targetInfo.type === 'service_worker' && targetInfo.url.endsWith(BRIDGE_SCRIPT)) {
      await attachBridge(sessionId, waitingForDebugger)
    } else if (waitingForDebugger) {
      await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId)
    }
  } catch (e) {
    log('attach failed', targetInfo.type, e.message)
  }
})

cdp.on('Target.detachedFromTarget', ({ sessionId, targetId }) => {
  if (uiSessions.has(sessionId)) uiTargets.delete(targetId)
  uiSessions.delete(sessionId)
  if (sessionId === bridgeSession) bridgeSession = undefined
})

cdp.on('Runtime.bindingCalled', ({ name, payload }, sessionId) => {
  if (name === 'groveEmit' && sessionId === bridgeSession) {
    host.onBridgeEvent(JSON.parse(payload))
  } else if (name === UI_BINDING && uiSessions.has(sessionId)) {
    const { windowId } = uiSessions.get(sessionId)
    host.command(windowId, JSON.parse(payload)).catch((e) => log('command failed', e.message))
  }
})

// In --dev, the UI's and the bridge's console output and errors land here.
cdp.on('Runtime.consoleAPICalled', ({ type, args }, sessionId) => {
  if (!dev || !(uiSessions.has(sessionId) || sessionId === bridgeSession)) return
  const text = args.map((a) => a.value ?? a.description ?? a.type).join(' ')
  if (text.startsWith('[grove]') || type === 'error') console.log('[ui]', type, text)
})
cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: d }, sessionId) => {
  if (dev && (uiSessions.has(sessionId) || sessionId === bridgeSession)) {
    console.log('[ui] exception', d.exception?.description ?? d.text)
  }
})

// Auto-attach doesn't always hand over the UI of windows opened later, so
// also watch for new browser UI pages and attach to any that were missed.
// Auto-attach gets first go; the fallback only steps in if it hasn't
// after half a second.
const attachMissed = ({ targetInfo }) => {
  if (targetInfo.type !== 'browser_ui' || !targetInfo.url.startsWith(UI_URL)) return
  setTimeout(() => {
    if (uiTargets.has(targetInfo.targetId)) return
    cdp.send('Target.attachToTarget', { targetId: targetInfo.targetId, flatten: true }).catch(() => {})
  }, 500)
}
cdp.on('Target.targetCreated', attachMissed)
cdp.on('Target.targetInfoChanged', attachMissed)
await cdp.send('Target.setDiscoverTargets', { discover: true })

// Pages aren't paused on attach: a paused window UI that loses its session
// stays frozen, which costs far more than a brief flash of Webium's own UI
// before Grove's script runs.
await cdp.send('Target.setAutoAttach', {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
  filter: [{ type: 'browser_ui' }, { type: 'service_worker' }, { exclude: true }]
})

// ---- Dev mode ----

// Reloads a window's UI and makes sure Grove is in the new document.
async function reload(sessionId) {
  const loaded = new Promise((resolve) => {
    const onLoad = (_params, sid) => {
      if (sid !== sessionId) return
      cdp.off('Page.loadEventFired', onLoad)
      resolve()
    }
    cdp.on('Page.loadEventFired', onLoad)
  })
  await cdp.send('Page.reload', {}, sessionId)
  await loaded
  const { result } = await cdp.send('Runtime.evaluate', { expression: '!!window.__grove', returnByValue: true }, sessionId)
  if (!result.value) await cdp.send('Runtime.evaluate', { expression: bundle }, sessionId)
}

if (dev) {
  // Evaluate JS in the windows' UI (or, at /bridge, in the bridge extension)
  // from a shell, over a socket only this user can open:
  //   curl --unix-socket $XDG_RUNTIME_DIR/grove-ui-dev.sock -d '<js>' http://ui/eval
  const { createServer } = await import('node:http')
  const { rmSync } = await import('node:fs')
  const socket = `${process.env.XDG_RUNTIME_DIR ?? '/tmp'}/grove-ui-dev.sock`
  rmSync(socket, { force: true })
  createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const targets = req.url?.includes('bridge') ? [bridgeSession].filter(Boolean) : [...uiSessions.keys()]
    const out = []
    for (const sessionId of targets) {
      const r = await cdp
        .send('Runtime.evaluate', { expression: body, returnByValue: true, awaitPromise: true }, sessionId)
        .catch((e) => ({ error: e.message }))
      out.push(r.error ?? r.exceptionDetails?.exception?.description ?? r.result?.value ?? r.result?.description)
    }
    res.end(JSON.stringify(out, null, 1) + '\n')
  }).listen(socket)

  const esbuild = await import('esbuild')
  const { options } = await import('../build.mjs')
  const ctx = await esbuild.context({
    ...options,
    plugins: [
      {
        name: 'reload-windows',
        setup(build) {
          build.onEnd(async (result) => {
            if (result.errors.length) return
            bundle = readFileSync(BUNDLE, 'utf8')
            for (const [sessionId, s] of uiSessions) {
              await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: s.script }, sessionId)
              const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: bundle }, sessionId)
              s.script = identifier
              await reload(sessionId)
            }
            log('reloaded', uiSessions.size, 'window(s)')
          })
        }
      }
    ]
  })
  await ctx.watch()
  log('watching src/')
}
