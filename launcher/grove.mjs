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
//   node launcher/grove.mjs sync ...
//
// sets up syncing with other devices (see sync-cli.mjs).
//
//   GROVE_CHROME   the browser binary     (default: the system chromium; any
//                  Chromium 152+ with Webium works, e.g. ungoogled-chromium.
//                  Not the Grove Chromium fork: its own C++ workspace service
//                  restores and mirrors tabs itself and fights this host)
//   GROVE_PROFILE  the profile directory  (default ~/.config/grove-webium)
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GroveHost } from '../host/host.ts'
import { SitePermissions } from '../host/site-permissions.ts'
import { Store } from '../host/store.ts'
import { Settings } from '../host/settings.ts'
import { SyncManager } from '../host/sync/manager.ts'
import { UI_BINDING, UI_RECEIVER } from '../shared/protocol.ts'
import { PipeCDP } from './cdp.mjs'

const home = homedir()
const CHROME = process.env.GROVE_CHROME ?? '/usr/bin/chromium'
const PROFILE = process.env.GROVE_PROFILE ?? `${home}/.config/grove-webium`
const FEATURES = 'Webium,SurfaceEmbed,ExtensionsMenuAccessControl'
const BUNDLE = fileURLToPath(new URL('../dist/grove-ui.js', import.meta.url))
const EXTENSION_SOURCE = fileURLToPath(new URL('../extension', import.meta.url))
const UI_URL = 'chrome://webui-browser'
const BRIDGE_SCRIPT = /\/grove-bridge\.[0-9a-f]+\.js$/

const dev = process.argv.includes('--dev')
// URLs and Chrome flags (--new-window, ...) go on to Chrome.
const passArgs = process.argv.slice(2).filter((a) => a !== '--dev')
const log = (...a) => dev && console.log('[grove]', ...a)

// If Grove is already running on this profile, Chrome hands this launch
// (a new window, a URL) to it and exits. Leave that instance's profile and
// workspaces alone: no host here, just the handoff.
function runningPid() {
  try {
    const [host, pid] = readlinkSync(join(PROFILE, 'SingletonLock')).split(/-(?=\d+$)/)
    if (host !== hostname()) return undefined
    process.kill(Number(pid), 0)
    return Number(pid)
  } catch {
    return undefined
  }
}
if (process.argv[2] === 'sync') {
  const { syncCli } = await import('./sync-cli.mjs')
  try {
    await syncCli(PROFILE, process.argv.slice(3), !!runningPid())
  } catch (e) {
    console.error(`grove sync: ${e.message}`)
    process.exit(1)
  }
  process.exit(0)
}
if (runningPid()) {
  const handoff = spawn(CHROME, [`--user-data-dir=${PROFILE}`, ...passArgs], { stdio: 'ignore' })
  await new Promise((done) => handoff.on('exit', done))
  process.exit(0)
}

// The bridge extension, written into the profile with its service worker
// named after its contents and a version to match. Chrome registers an
// extension's worker again only when the extension's version changes, and
// otherwise keeps running the script it registered before, even once the
// file changes. The folder stays put, so the extension keeps its id.
function prepareBridge() {
  const dir = join(PROFILE, 'Grove Bridge')
  const files = readdirSync(EXTENSION_SOURCE).filter((f) => f.endsWith('.js')).sort()
  const sources = new Map(files.map((f) => [f, readFileSync(join(EXTENSION_SOURCE, f))]))
  const digest = createHash('sha256')
  for (const [f, source] of sources) digest.update(f).update(source)
  const hash = digest.digest()
  const name = `grove-bridge.${hash.toString('hex').slice(0, 12)}.js`
  const manifest = JSON.parse(readFileSync(join(EXTENSION_SOURCE, 'manifest.json'), 'utf8'))
  manifest.version = `${manifest.version}.${hash.readUInt16BE(0)}`
  manifest.background.service_worker = name
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  for (const [f, source] of sources) writeFileSync(join(dir, f === 'grove-bridge.js' ? name : f), source)
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return dir
}

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
const EXTENSION = prepareBridge()

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
    '--class=grove',
    // --remote-debugging-pipe marks the browser as automated
    // (navigator.webdriver = true), and bot walls like Akamai's then block
    // it. Grove is a person's browser, not automation.
    '--disable-blink-features=AutomationControlled',
    ...passArgs
  ],
  { stdio: ['ignore', 'ignore', dev ? 'inherit' : 'ignore', 'pipe', 'pipe'] }
)
chrome.on('exit', (code) => {
  host.flush()
  sync.flush()
  process.exit(code ?? 0)
})
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => chrome.kill('SIGTERM'))

const cdp = new PipeCDP(chrome.stdio[3], chrome.stdio[4])

// The site permissions Grove keeps itself, applied before any page asks.
const sitePermissions = new SitePermissions(join(PROFILE, 'grove-permissions.json'), (permission, setting, origin) =>
  cdp.send('Browser.setPermission', { permission, setting, origin })
)
await sitePermissions.applyAll()
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
    },
    focusUrlBar(windowId) {
      const sessionId = sessionOfWindow(windowId)
      if (!sessionId) return
      cdp.send('Runtime.evaluate', { expression: `window.${UI_RECEIVER}?.focusUrlBar()` }, sessionId).catch(() => {})
    },
    openNewTabSearch(windowId) {
      const sessionId = sessionOfWindow(windowId)
      if (!sessionId) return
      cdp.send('Runtime.evaluate', { expression: `window.${UI_RECEIVER}?.openNewTabSearch()` }, sessionId).catch(() => {})
    }
  },
  log,
  sitePermissions
)

// Grove's settings, and sync with Grove on other devices (set up in the
// settings, or with grove sync). Sync starts once the host has Chrome's
// windows.
const settings = new Settings(join(PROFILE, 'grove-settings.json'))
const sync = new SyncManager({
  profile: PROFILE,
  host: {
    model: () => host.current,
    isLive: (id) => host.isLive(id),
    apply: (model, remap) => host.applySynced(model, remap),
    resume: (workspaceId, entryId) => host.resume(workspaceId, entryId)
  },
  scope: () => ({ unpinnedTabs: settings.get().syncTabs === 'all' }),
  changed: () => host.refresh(),
  log: (...a) => console.log('[grove]', ...a)
})
host.settings = settings
host.sync = sync
host.onModelChange = () => sync.localChanged()

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
    sync.start().catch((e) => console.log('[grove] sync:', e.message))
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
    } else if (targetInfo.type === 'service_worker' && BRIDGE_SCRIPT.test(targetInfo.url)) {
      await attachBridge(sessionId, waitingForDebugger)
    } else {
      if (waitingForDebugger) await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId)
      // A website's service worker: leave it alone.
      if (targetInfo.type === 'service_worker') await cdp.send('Target.detachFromTarget', { sessionId })
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

// With browser-level auto-attach on (below), Chrome holds a page that a
// site opens with window.open until a debugger lets it run, even though
// pages are filtered out of auto-attach and nothing asked to wait. Nothing
// would, so the popup and the page that opened it (they share a renderer)
// stay frozen. Let each one go.
cdp.on('Target.targetCreated', async ({ targetInfo }) => {
  if (targetInfo.type !== 'page' || !targetInfo.openerId) return
  try {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: targetInfo.targetId, flatten: true })
    await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId)
    await cdp.send('Target.detachFromTarget', { sessionId })
  } catch {}
})
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
  // or send one raw CDP command at /cdp.
  const { createServer } = await import('node:http')
  const { rmSync } = await import('node:fs')
  const socket = `${process.env.XDG_RUNTIME_DIR ?? '/tmp'}/grove-ui-dev.sock`
  rmSync(socket, { force: true })
  createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    // /cdp takes {method, params, sessionId?} and sends it as is;
    // sessionId "ui" means the first window's UI, "ui2" the second, and so on.
    if (req.url?.includes('cdp')) {
      const { method, params, sessionId: given } = JSON.parse(body)
      const nth = /^ui(\d*)$/.exec(given ?? '')
      const sessionId = nth ? [...uiSessions.keys()][Number(nth[1] || 1) - 1] : given
      const r = await cdp.send(method, params ?? {}, sessionId).catch((e) => ({ error: e.message }))
      res.end(JSON.stringify(r, null, 1) + '\n')
      return
    }
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
