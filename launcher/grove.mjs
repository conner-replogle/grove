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
//   GROVE_CHROME   the browser binary     (an installed bundle's own; else
//                  the system chromium. Any Chromium 152+ with Webium works,
//                  e.g. ungoogled-chromium. Not the Grove Chromium fork: its
//                  own C++ workspace service restores and mirrors tabs
//                  itself and fights this host)
//   GROVE_PROFILE  the profile directory  (default ~/.config/grove-webium,
//                  on macOS ~/Library/Application Support/Grove/Profile, on
//                  Windows %LOCALAPPDATA%\Grove\User Data)
//
// An installed bundle's start script (packaging/) also sets GROVE_BUNDLE,
// the bundle the updater may replace, and GROVE_RELAUNCH, what restarts it.
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, watch, writeFileSync } from 'node:fs'
import { arch, homedir, hostname, release } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatWithOptions } from 'node:util'
import { DebugRecorder, redact, reveal } from '../host/debug.ts'
import { GroveHost } from '../host/host.ts'
import { SitePermissions } from '../host/site-permissions.ts'
import { Store } from '../host/store.ts'
import { Settings } from '../host/settings.ts'
import { SyncManager } from '../host/sync/manager.ts'
import { Updater } from '../host/updates.ts'
import { WorkersAiKeys } from '../host/workers-ai.ts'
import { StoreExtensions } from '../host/extensions.ts'
import { Widevine } from '../host/widevine.ts'
import { fetchDictionaries } from '../host/dictionaries.ts'
import { UI_BINDING, UI_RECEIVER } from '../shared/protocol.ts'
import { PipeCDP } from './cdp.mjs'

const home = homedir()
const mac = process.platform === 'darwin'
const win = process.platform === 'win32'
// Grove's own folder in %LOCALAPPDATA% on Windows (packaging/windows).
const winData = join(process.env.LOCALAPPDATA ?? join(home, 'AppData/Local'), 'Grove')
const CHROME =
  process.env.GROVE_CHROME ??
  (mac
    ? '/Applications/Chromium.app/Contents/MacOS/Chromium'
    : win
      ? join(process.env.LOCALAPPDATA ?? '', 'Chromium/Application/chrome.exe')
      : '/usr/bin/chromium')
const PROFILE =
  process.env.GROVE_PROFILE ??
  (mac ? `${home}/Library/Application Support/Grove/Profile` : win ? join(winData, 'User Data') : `${home}/.config/grove-webium`)
const FEATURES = 'Webium,SurfaceEmbed,ExtensionsMenuAccessControl'
const BUNDLE = fileURLToPath(new URL('../dist/grove-ui.js', import.meta.url))
const EXTENSION_SOURCE = fileURLToPath(new URL('../extension', import.meta.url))
const UI_URL = 'chrome://webui-browser'
const BRIDGE_SCRIPT = /\/grove-bridge\.[0-9a-f]+\.js$/

const dev = process.argv.includes('--dev')
// URLs and Chrome flags (--new-window, ...) go on to Chrome.
const passArgs = process.argv.slice(2).filter((a) => a !== '--dev')
// The last 30 seconds of Grove, for Debug mode's packets (host/debug.ts):
// everything Grove logs goes into it, printed or not.
const debug = new DebugRecorder()
const format = (a) => formatWithOptions({ depth: 4, breakLength: Infinity }, ...a)
const print = console.log.bind(console)
for (const level of ['log', 'warn', 'error']) {
  const write = console[level].bind(console)
  console[level] = (...a) => {
    debug.record(level === 'log' ? 'host' : `host ${level}`, format(a))
    write(...a)
  }
}
const log = (...a) => (dev ? console.log('[grove]', ...a) : debug.record('host', format(['[grove]', ...a])))

// If Grove is already running on this profile, Chrome hands this launch
// (a new window, a URL) to it and exits. Leave that instance's profile and
// workspaces alone: no host here, just the handoff.
function runningPid() {
  // Chrome on Windows holds the profile's lockfile open, unshared: it
  // can't be deleted while Chrome runs (and a stale one may as well go).
  if (win) {
    try {
      rmSync(join(PROFILE, 'lockfile'), { force: true })
      return undefined
    } catch {
      return -1
    }
  }
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
const BRIDGE_DIR = join(PROFILE, 'Grove Bridge')

// The id Chrome gives an unpacked extension: from its folder's path (on
// Windows the UTF-16 path, drive letter in capitals).
const unpackedId = (dir) =>
  [
    ...createHash('sha256')
      .update(win ? Buffer.from(dir.replace(/^[a-z]:/, (d) => d.toUpperCase()), 'utf16le') : dir)
      .digest('hex')
      .slice(0, 32)
  ]
    .map((h) => String.fromCharCode(97 + parseInt(h, 16)))
    .join('')

function prepareBridge() {
  const dir = BRIDGE_DIR
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
// session files and don't offer crash restore. Startup is still "continue
// where you left off" (1), with nothing left to restore: any other setting
// makes Chrome delete session cookies at launch, signing out of sites that
// keep their login in one (Microsoft's, for one).
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
  prefs.session = { ...prefs.session, restore_on_startup: 1 }
  prefs.profile = { ...prefs.profile, exit_type: 'Normal', exited_cleanly: true }
  // Google searches what's typed in the URL bar until the user picks
  // another engine (Chrome then keeps their choice here). ungoogled-chromium
  // starts with none, and its own Google entry points at dead addresses.
  if (!prefs.default_search_provider_data?.template_url_data) {
    prefs.default_search_provider_data = { ...prefs.default_search_provider_data, template_url_data: GOOGLE_SEARCH() }
  }
  // Spell check is on until the user turns it off, as in Chrome
  // (ungoogled-chromium starts with it off; host/dictionaries.ts fetches
  // the words).
  if (prefs.browser?.enable_spellchecking === undefined) {
    prefs.browser = { ...prefs.browser, enable_spellchecking: true }
  }
  // Zen's keys for a new blank window and a private one, Ctrl/Cmd+Shift+N
  // and +P, for the bridge's commands (Chrome won't give an extension a key
  // of its own, incognito's here, from the manifest's suggestion), unless
  // the user put something else on them.
  const commands = (prefs.extensions = { ...prefs.extensions, commands: { ...prefs.extensions?.commands } }).commands
  for (const [letter, command_name] of [['N', 'new-blank-window'], ['P', 'new-private-window']]) {
    const key = mac ? `mac:Command+Shift+${letter}` : `${win ? 'windows' : 'linux'}:Ctrl+Shift+${letter}`
    if (!commands[key]) commands[key] = { command_name, extension: unpackedId(BRIDGE_DIR), global: false }
  }
  writeFileSync(file, JSON.stringify(prefs))
}

const GOOGLE_SEARCH = () => ({
  short_name: 'Google',
  keyword: 'google.com',
  url: 'https://www.google.com/search?q={searchTerms}&ie={inputEncoding}',
  suggestions_url: 'https://www.google.com/complete/search?client=chrome&q={searchTerms}',
  favicon_url: 'https://www.google.com/favicon.ico',
  input_encodings: ['UTF-8'],
  safe_for_autoreplace: false,
  prepopulate_id: 0,
  synced_guid: randomUUID()
})
prepareProfile()
const EXTENSION = prepareBridge()

// The user's own Chrome flags, one or more to a line (# comments), from
// $XDG_CONFIG_HOME/grove-flags.conf (on Windows %LOCALAPPDATA%\Grove\),
// as Arch's chromium reads chromium-flags.conf: --password-store=
// gnome-libsecret, say, where Chrome can't tell which keyring the desktop
// has.
function userFlags() {
  try {
    const file = join(win ? winData : process.env.XDG_CONFIG_HOME || join(home, '.config'), 'grove-flags.conf')
    return readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.replace(/#.*/, '').trim())
      .flatMap((l) => (l ? l.split(/\s+/) : []))
  } catch {
    return []
  }
}

// Chrome keeps only the last of a repeated switch; these lists are merged
// instead, so the user's features and extensions join Grove's.
function mergeFlags(flags) {
  const lists = new Map([['--enable-features', []], ['--disable-features', []], ['--load-extension', []]])
  const rest = []
  for (const f of flags) {
    const [name, value] = f.split(/=(.*)/s)
    if (lists.has(name) && value) lists.get(name).push(...value.split(','))
    else rest.push(f)
  }
  for (const [name, values] of lists) if (values.length) rest.push(`${name}=${[...new Set(values)].join(',')}`)
  return rest
}

const chromeArgs = mergeFlags([
    ...userFlags(),
    `--user-data-dir=${PROFILE}`,
    `--enable-features=${FEATURES}`,
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
  ])
const chrome = spawn(CHROME, chromeArgs, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] })
// Chrome's own output: printed in --dev, and kept for a debug packet.
let stderrRest = ''
chrome.stdio[2].setEncoding('utf8')
chrome.stdio[2].on('data', (chunk) => {
  if (dev) process.stderr.write(chunk)
  const lines = (stderrRest + chunk).split('\n')
  stderrRest = lines.pop()
  for (const l of lines) if (l.trim()) debug.record('chrome', l)
})
// Set when Grove quits to restart (into an update): the launcher starts a
// new Grove once Chrome has gone (and released the profile).
let relaunch = false
chrome.on('exit', (code) => {
  host.flush()
  sync.flush()
  if (relaunch) {
    const bin = process.env.GROVE_RELAUNCH ?? join(home, '.local/bin/grove')
    const [cmd, args] = existsSync(bin) ? [bin, []] : [process.execPath, [fileURLToPath(import.meta.url)]]
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
  }
  process.exit(code ?? 0)
})
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => chrome.kill('SIGTERM'))

const cdp = new PipeCDP(chrome.stdio[3], chrome.stdio[4])

// The bridge, loaded over DevTools rather than with --load-extension: only
// this way can it be allowed in incognito, where it runs private windows'
// tabs too (as one extension "spanning" both).
await cdp
  .send('Extensions.loadUnpacked', { path: EXTENSION, enableInIncognito: true })
  .catch((e) => console.error('[grove] the bridge extension failed to load:', e.message))

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
// The state last pushed to each window, for a debug packet.
const lastStates = new Map()
const lastPushed = new Map()

// ---- Debug mode ----

// While it is on, each window's UI page (which has the window's pages in
// it) sends a frame whenever it changes, five a second at most: the
// recording in a debug packet. Chrome's own bubbles and menus aren't in it.
let debugOn = false
function setDebugMode(on) {
  if (on === debugOn) return
  debugOn = on
  log('debug mode', on ? 'on' : 'off')
  for (const sessionId of uiSessions.keys()) {
    if (on) startFrames(sessionId)
    else cdp.send('Page.stopScreencast', {}, sessionId).catch(() => {})
  }
  if (!on) debug.dropFrames()
}
const startFrames = (sessionId) =>
  cdp
    .send('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: 1440, maxHeight: 1440 }, sessionId)
    .catch((e) => log('screencast:', e.message))
cdp.on('Page.screencastFrame', ({ data, sessionId: frame }, sessionId) => {
  const s = uiSessions.get(sessionId)
  if (debugOn && s) debug.frame(s.windowId, data)
  // Chrome sends the next frame once this one is acknowledged.
  setTimeout(() => cdp.send('Page.screencastFrameAck', { sessionId: frame }, sessionId).catch(() => {}), 200)
})

// A line for the timeline: what a pushed state shows.
function describeState(s) {
  const active = [...s.essentials, ...s.workspace.entries].find((e) => e.id === s.activeEntryId)
  const extra = ['paused', 'split', 'store', 'translate', 'site', 'update'].filter((k) => s[k])
  return (
    `workspace "${s.workspace.name}", ${s.workspace.entries.length} entries, active ` +
    (active ? `"${active.title}" ${active.url}` : 'none') +
    (extra.length ? `; ${extra.join(', ')}` : '')
  )
}

// The windows' UI, its open shadow roots included, without long data: URLs.
const DOM_SNAPSHOT = `(() => {
  const roots = []
  const walk = (node) => {
    for (const e of node.querySelectorAll('*')) if (e.shadowRoot) roots.push(e.shadowRoot), walk(e.shadowRoot)
  }
  walk(document)
  return document.documentElement.getHTML({ shadowRoots: roots }).replace(/data:[^"'\\s)]{200,}/g, (m) => m.slice(0, 48) + '…')
})()`

const host = new GroveHost(
  new Store(join(PROFILE, 'grove-workspaces.json')),
  {
    push(windowId, state) {
      lastStates.set(windowId, state)
      setDebugMode(!!state.settings.debug)
      const line = describeState(state)
      if (lastPushed.get(windowId) !== line) debug.record(`push w${windowId}`, line)
      lastPushed.set(windowId, line)
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
    },
    suggestions(windowId, input, list) {
      const sessionId = sessionOfWindow(windowId)
      if (!sessionId) return
      const expression = `window.${UI_RECEIVER}?.suggestions(${JSON.stringify(input)}, ${JSON.stringify(list)})`
      cdp.send('Runtime.evaluate', { expression }, sessionId).catch(() => {})
    },
    // A click from DevTools goes through Chrome's input handling like a real
    // one, which is what gives the window's UI the keyboard back from a page.
    async click(windowId, x, y) {
      const sessionId = sessionOfWindow(windowId)
      if (!sessionId) return
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, sessionId).catch(() => {})
      }
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
// Organize's Workers AI key, given in the settings.
host.workersAi = new WorkersAiKeys(PROFILE, () => host.refresh())

// Web Store extensions: Grove installs them itself (host/extensions.ts).
let chromeVersion = '155.0.0.0'
cdp
  .send('Browser.getVersion')
  .then(({ product }) => {
    chromeVersion = product.split('/')[1] ?? chromeVersion
    host.refresh()
  })
  .catch(() => {})
const extensions = new StoreExtensions({
  profile: PROFILE,
  chromeVersion: () => chromeVersion,
  load: async (dir) => (await cdp.send('Extensions.loadUnpacked', { path: dir })).id,
  // The copy loaded this session goes at once; an installed one is off
  // until Chrome uninstalls it at its next start.
  unload: (id) => cdp.send('Extensions.uninstall', { id }).catch(() => bridge.call('disableExtension', id)),
  warnings: (manifest) => bridge.call('permissionWarnings', manifest),
  installedElsewhere: async (id) => {
    const e = await bridge.call('extension', id)
    return !!e && e.installType !== 'development'
  },
  onChange: () => host.refresh(),
  log: (...a) => console.log('[grove]', ...a)
})
host.extensions = extensions
host.chromeVersion = () => chromeVersion
extensions.start()

// Spell check dictionaries, which ungoogled-chromium won't download
// (host/dictionaries.ts).
setTimeout(() => void fetchDictionaries(PROFILE, (...a) => console.log('[grove]', ...a)), 30_000)

// Widevine for DRM video and music, fetched as Chrome would (host/widevine.ts).
if (process.platform === 'linux' || win) {
  new Widevine({ profile: PROFILE, chromeVersion: () => chromeVersion, log: (...a) => console.log('[grove]', ...a) }).start()
}

// Newer releases (host/updates.ts), offered in the windows.
const updater = new Updater({
  appDir: fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, ''),
  bundleDir: process.env.GROVE_BUNDLE,
  onChange: () => host.refresh(),
  log: (...a) => console.log('[grove]', ...a)
})
host.updates = updater
// Debug mode's packet: the recorder's 30 seconds, and each window as it is
// now.
host.debug = {
  reveal,
  async save() {
    const files = []
    const windows = {}
    for (const [sessionId, { windowId }] of uiSessions) {
      const send = (method, params) => timed(cdp.send(method, params, sessionId), 5000, method).catch((e) => ({ error: e.message }))
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      if (shot.data) files.push({ name: `windows/w${windowId}.png`, data: Buffer.from(shot.data, 'base64') })
      const dom = await send('Runtime.evaluate', { expression: DOM_SNAPSHOT, returnByValue: true })
      if (typeof dom.result?.value === 'string') files.push({ name: `windows/w${windowId}.html`, data: dom.result.value })
      windows[windowId] = { state: redact(lastStates.get(windowId)), screenshot: shot.error, dom: dom.error }
    }
    const targets = await cdp
      .send('Target.getTargets')
      .then((r) => r.targetInfos.map(({ type, url, title, attached }) => ({ type, url, title, attached })))
      .catch((e) => e.message)
    const extensionList = await bridge.call('extensionList').catch((e) => e.message)
    return debug.save(
      {
        grove: updater.current,
        chrome: chromeVersion,
        platform: `${process.platform} ${release()} ${arch()}`,
        node: process.version,
        dev,
        uptimeSeconds: Math.round((Date.now() - debug.startedAt) / 1000),
        chromeBinary: CHROME,
        chromeArgs,
        profile: PROFILE,
        settings: settings.get(),
        bridgeConnected: !!bridgeSession,
        windows,
        targets,
        extensions: extensionList,
        model: redact(host.current)
      },
      files
    )
  }
}
host.restart = () => {
  relaunch = true
  cdp.send('Browser.close').catch(() => chrome.kill('SIGTERM'))
}
updater.start()
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
  if (debugOn) startFrames(sessionId)
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
  if (uiSessions.has(sessionId)) debug.record('chrome', `window ${uiSessions.get(sessionId).windowId}'s UI detached`)
  if (sessionId === bridgeSession) debug.record('chrome', 'bridge detached')
  if (uiSessions.has(sessionId)) uiTargets.delete(targetId)
  uiSessions.delete(sessionId)
  if (sessionId === bridgeSession) bridgeSession = undefined
})

cdp.on('Runtime.bindingCalled', ({ name, payload }, sessionId) => {
  if (name === 'groveEmit' && sessionId === bridgeSession) {
    const event = JSON.parse(payload)
    debug.record('bridge', `event ${JSON.stringify(redact(event))}`)
    host.onBridgeEvent(event)
  } else if (name === UI_BINDING && uiSessions.has(sessionId)) {
    const { windowId } = uiSessions.get(sessionId)
    const command = JSON.parse(payload)
    debug.record(`ui w${windowId}`, `command ${JSON.stringify(redact(command))}`)
    host.command(windowId, command).catch((e) => log('command failed', e.message))
  }
})

// The UI's and the bridge's console output and errors: kept for a debug
// packet, and in --dev printed here.
const sourceOf = (sessionId) =>
  uiSessions.has(sessionId) ? `ui w${uiSessions.get(sessionId).windowId}` : sessionId === bridgeSession ? 'bridge' : undefined
cdp.on('Runtime.consoleAPICalled', ({ type, args }, sessionId) => {
  const source = sourceOf(sessionId)
  if (!source) return
  const text = args
    .map((a) => (a.value === undefined ? (a.description ?? a.type) : typeof a.value === 'string' ? a.value : JSON.stringify(a.value)))
    .join(' ')
  debug.record(source, type === 'log' || type === 'debug' ? text : `console.${type} ${text}`)
  if (dev && (text.startsWith('[grove]') || type === 'error')) print('[ui]', type, text)
})
cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: d }, sessionId) => {
  const source = sourceOf(sessionId)
  if (!source) return
  const text = d.exception?.description ?? d.text
  debug.record(source, `exception ${text}`)
  if (dev) print('[ui] exception', text)
})
cdp.on('Target.targetCrashed', ({ targetId, status, errorCode }) => {
  debug.record('chrome', `renderer crashed: target ${targetId}, ${status} (${errorCode})`)
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

// ---- Hot reload ----

// Puts the current UI bundle in every window: the next document gets it,
// and each window's UI reloads now (its tabs stay as they are).
async function reloadUi() {
  bundle = readFileSync(BUNDLE, 'utf8')
  for (const [sessionId, s] of uiSessions) {
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: s.script }, sessionId)
    const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: bundle }, sessionId)
    s.script = identifier
    await reload(sessionId)
  }
  log('reloaded', uiSessions.size, 'window(s)')
}

// An installed Grove picks up a new UI bundle (install.sh) without a
// restart. The host, launcher and extension still need one. (install.sh
// replaces the file, so the directory is watched.)
if (!dev) {
  let timer
  watch(dirname(BUNDLE), (_event, name) => {
    if (name !== basename(BUNDLE)) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      let next
      try {
        next = readFileSync(BUNDLE, 'utf8')
      } catch {
        return
      }
      if (next !== bundle) reloadUi().catch((e) => log('hot reload failed:', e.message))
    }, 300)
  })
}

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
  if (debugOn) await cdp.send('Page.stopScreencast', {}, sessionId).then(() => startFrames(sessionId), () => {})
  const { result } = await cdp.send('Runtime.evaluate', { expression: '!!window.__grove', returnByValue: true }, sessionId)
  if (!result.value) await cdp.send('Runtime.evaluate', { expression: bundle }, sessionId)
}

if (dev) {
  // Evaluate JS in the windows' UI (or, at /bridge, in the bridge extension)
  // from a shell, over a socket only this user can open:
  //   curl --unix-socket $XDG_RUNTIME_DIR/grove-ui-dev.sock -d '<js>' http://ui/eval
  // (on Windows the named pipe \\.\pipe\grove-ui-dev), or send one raw CDP
  // command at /cdp.
  const { createServer } = await import('node:http')
  const socket = win ? '\\\\.\\pipe\\grove-ui-dev' : `${process.env.XDG_RUNTIME_DIR ?? '/tmp'}/grove-ui-dev.sock`
  if (!win) rmSync(socket, { force: true })
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
}

// Rebuilding needs the checkout's src/ (an installed app has only dist/).
if (dev && existsSync(fileURLToPath(new URL('../src', import.meta.url)))) {
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
            await reloadUi()
          })
        }
      }
    ]
  })
  await ctx.watch()
  log('watching src/')
}
