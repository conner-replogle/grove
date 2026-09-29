#!/usr/bin/env node
// Starts Grove (Chromium with its WebUI browser, "Webium") and injects
// Grove's UI into every browser window, before the window's own scripts run.
//
//   node launcher/grove.mjs [--dev] [url...]
//
// --dev rebuilds src/ on save and reloads the windows' UI.
//
//   GROVE_CHROME   the browser binary     (default ~/.local/opt/grove/chrome)
//   GROVE_PROFILE  the profile directory  (default ~/.config/grove-webium)
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { PipeCDP } from './cdp.mjs'

const home = homedir()
const CHROME = process.env.GROVE_CHROME ?? `${home}/.local/opt/grove/chrome`
const PROFILE = process.env.GROVE_PROFILE ?? `${home}/.config/grove-webium`
const FEATURES = 'Webium,SurfaceEmbed,ExtensionsMenuAccessControl'
const BUNDLE = fileURLToPath(new URL('../dist/grove-ui.js', import.meta.url))
const UI_URL = 'chrome://webui-browser'

const dev = process.argv.includes('--dev')
const urls = process.argv.slice(2).filter((a) => !a.startsWith('--'))

const chrome = spawn(
  CHROME,
  [
    `--user-data-dir=${PROFILE}`,
    `--enable-features=${FEATURES}`,
    '--remote-debugging-pipe',
    '--ozone-platform-hint=auto',
    '--no-first-run',
    '--no-default-browser-check',
    ...urls
  ],
  { stdio: ['ignore', 'ignore', dev ? 'inherit' : 'ignore', 'pipe', 'pipe'] }
)
chrome.on('exit', (code) => process.exit(code ?? 0))
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => chrome.kill('SIGTERM'))

const cdp = new PipeCDP(chrome.stdio[3], chrome.stdio[4])
const log = (...a) => dev && console.log('[grove]', ...a)

let bundle = readFileSync(BUNDLE, 'utf8')
// sessionId -> identifier of the injected new-document script
const sessions = new Map()

async function inject(sessionId, { waiting }) {
  await cdp.send('Page.enable', {}, sessionId)
  if (dev) await cdp.send('Runtime.enable', {}, sessionId)
  const { identifier } = await cdp.send(
    'Page.addScriptToEvaluateOnNewDocument',
    { source: bundle, runImmediately: true },
    sessionId
  )
  sessions.set(sessionId, identifier)
  if (waiting) await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId)
  else await cdp.send('Runtime.evaluate', { expression: bundle }, sessionId)
}

// New windows pause until Grove's script is in place, so Google's UI never
// shows first.
cdp.on('Target.attachedToTarget', async ({ sessionId, targetInfo, waitingForDebugger }) => {
  if (targetInfo.type === 'browser_ui' && targetInfo.url.startsWith(UI_URL)) {
    log('window', targetInfo.targetId)
    await inject(sessionId, { waiting: waitingForDebugger }).catch((e) => log('inject failed', e.message))
  } else if (waitingForDebugger) {
    await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {})
  }
})
// In --dev, the UI's console output and uncaught errors land in this log.
cdp.on('Runtime.consoleAPICalled', ({ type, args }, sessionId) => {
  if (!sessions.has(sessionId)) return
  const text = args.map((a) => a.value ?? a.description ?? a.type).join(' ')
  if (text.startsWith('[grove]') || type === 'error' || type === 'debug') console.log('[ui]', type, text)
})
cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: d }, sessionId) => {
  if (sessions.has(sessionId)) console.log('[ui] exception', d.exception?.description ?? d.text)
})
cdp.on('Target.detachedFromTarget', ({ sessionId }) => sessions.delete(sessionId))

await cdp.send('Target.setAutoAttach', {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
  filter: [{ type: 'browser_ui' }, { exclude: true }]
})

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
  if (!result.value) {
    log('new-document script did not run; injecting directly')
    await cdp.send('Runtime.evaluate', { expression: bundle }, sessionId)
  }
}

if (dev) {
  // Dev-only: evaluate JS in the windows' UI from a shell, over a socket
  // only this user can open:
  //   curl --unix-socket $XDG_RUNTIME_DIR/grove-ui-dev.sock -d '<js>' http://ui/eval
  const { createServer } = await import('node:http')
  const { rmSync } = await import('node:fs')
  const socket = `${process.env.XDG_RUNTIME_DIR ?? '/tmp'}/grove-ui-dev.sock`
  rmSync(socket, { force: true })
  createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const out = []
    for (const sessionId of sessions.keys()) {
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
            for (const [sessionId, identifier] of sessions) {
              await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, sessionId)
              const { identifier: next } = await cdp.send(
                'Page.addScriptToEvaluateOnNewDocument',
                { source: bundle },
                sessionId
              )
              sessions.set(sessionId, next)
              await reload(sessionId)
            }
            log('reloaded', sessions.size, 'window(s)')
          })
        }
      }
    ]
  })
  await ctx.watch()
  log('watching src/')
}
