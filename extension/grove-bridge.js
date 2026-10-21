// Grove bridge: the Grove host (launcher) drives Chrome's cross-window tab
// APIs through this service worker over DevTools, and hears about tab and
// window changes through the `groveEmit` binding it installs here.

const queue = [] // events that happened before the host connected
function emit(event) {
  if (typeof globalThis.groveEmit === 'function') globalThis.groveEmit(JSON.stringify(event))
  else queue.push(event)
}

// Tabs the host asked for, per window, oldest first: the next onCreated in
// that window is the host's, and carries its request id.
const pending = new Map()

const tabInfo = (t) => ({
  id: t.id,
  windowId: t.windowId,
  index: t.index,
  active: t.active,
  url: t.url || t.pendingUrl || '',
  title: t.title || '',
  favIconUrl: t.favIconUrl || '',
  status: t.status || '',
  audible: !!t.audible,
  openerTabId: t.openerTabId
})

// Popup and app windows (Grove's own device and screen-share pickers among
// them) aren't Grove windows: their tabs stay out of the workspaces.
const otherWindows = new Set()
const inOther = (windowId) => otherWindows.has(windowId)

// ---- Unloading ----
// An unloaded tab is closed, and Chrome keeps it among its recently closed
// tabs (back/forward list, scroll position, form state), so restoring it
// brings all that back. Chrome keeps the last 25; older ones come back
// from their URL alone.

// Sessions of tabs Grove unloaded: session id -> the URL the tab was on.
const unloaded = new Map()
// While Grove restores a session, new tabs wait: the restored one is known
// only once restore() answers, and its onCreated comes first. Restored tab
// id -> the host's request id.
let restoring = 0
let held = []
const restoredRequests = new Map()

const recentlyClosed = () => chrome.sessions.getRecentlyClosed({ maxResults: chrome.sessions.MAX_SESSION_RESULTS }).catch(() => [])
const sessionIdOf = (s) => (s.tab ?? s.window)?.sessionId

// A tab nobody asked for that is one of Grove's unloaded tabs: the user
// reopened a closed tab (Ctrl+Shift+T), and Chrome took Grove's newest
// unloaded tab for it. That tab goes back to its entry, and the tab the
// user meant, the newest one they closed themselves, opens too.
async function restoredSession(tab) {
  const url = tab.url || tab.pendingUrl
  const candidates = [...unloaded].filter(([, u]) => u === url)
  if (!candidates.length) return undefined
  const alive = new Set((await recentlyClosed()).map(sessionIdOf))
  const gone = candidates.find(([id]) => !alive.has(id))
  if (!gone) return undefined
  unloaded.delete(gone[0])
  const users = (await recentlyClosed()).find((s) => !unloaded.has(sessionIdOf(s)))
  if (users) chrome.sessions.restore(sessionIdOf(users)).catch(() => {})
  return gone[0]
}

async function emitCreated(tab) {
  const q = pending.get(tab.windowId)
  let requestId = restoredRequests.get(tab.id)
  restoredRequests.delete(tab.id)
  if (!requestId && q && q.length) requestId = q.shift()
  const session = requestId || !unloaded.size ? undefined : await restoredSession(tab)
  emit({ type: 'tabCreated', tab: tabInfo(tab), requestId, restoredSession: session })
}

chrome.tabs.onCreated.addListener((tab) => {
  if (inOther(tab.windowId)) return
  if (restoring) held.push(tab)
  else void emitCreated(tab)
})
chrome.tabs.onRemoved.addListener((tabId, info) => {
  if (inOther(info.windowId)) return
  emit({ type: 'tabRemoved', tabId, windowId: info.windowId, windowClosing: info.isWindowClosing })
})
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (inOther(tab.windowId)) return
  if ('url' in change || 'title' in change || 'favIconUrl' in change || 'status' in change || 'audible' in change) {
    emit({ type: 'tabUpdated', tab: tabInfo(tab) })
  }
})
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (!inOther(windowId)) emit({ type: 'tabActivated', tabId, windowId })
})
chrome.tabs.onAttached.addListener((tabId, { newWindowId }) => {
  if (!inOther(newWindowId)) emit({ type: 'tabAttached', tabId, windowId: newWindowId })
})
chrome.tabs.onMoved.addListener((tabId, { windowId }) => {
  if (!inOther(windowId)) emit({ type: 'tabMoved', tabId, windowId })
})
chrome.windows.onCreated.addListener((w) => {
  if (w.type !== 'normal') otherWindows.add(w.id)
  else emit({ type: 'windowCreated', windowId: w.id })
})
chrome.windows.onRemoved.addListener((windowId) => {
  if (!otherWindows.delete(windowId)) emit({ type: 'windowRemoved', windowId })
})
// The computer going idle (no input for a couple of minutes) or locked:
// the host organizes tabs then (host/organize.ts).
chrome.idle.setDetectionInterval(120)
chrome.idle.onStateChanged.addListener((state) => emit({ type: 'idle', state }))
// A worker that restarted learns which windows aren't Grove's again.
chrome.windows.getAll({ windowTypes: ['popup', 'app', 'devtools'] }).then((ws) => ws.forEach((w) => otherWindows.add(w.id)))

// Permission requests from pages (permissions-relay.js), waiting for the
// host's answer: id -> { respond, origin, kinds }.
// The kinds kept as Chrome's site settings, by their contentSettings name;
// the host keeps the others (host/site-permissions.ts).
const PERMISSION_SETTINGS = {
  notifications: 'notifications',
  geolocation: 'location',
  camera: 'camera',
  microphone: 'microphone',
  clipboard: 'clipboard'
}
const KINDS = new Set([
  ...Object.keys(PERMISSION_SETTINGS),
  'cameraPanTiltZoom',
  'midi',
  'midiSysex',
  'idleDetection',
  'windowManagement',
  'localFonts',
  'storageAccess',
  'localNetwork'
])
const permissionRequests = new Map()
let nextPermission = 1
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const request = message?.grovePermission
  if (!request || !sender.tab) return
  const kinds = request.kinds.filter((k) => KINDS.has(k))
  if (!kinds.length) {
    respond('fallback')
    return
  }
  // Storage access is asked by an embedded site, about its cookies on the
  // page it's in; everything else by the page's own site.
  const storage = kinds.includes('storageAccess')
  const origin = storage ? request.frameOrigin : request.origin
  const topOrigin = storage ? request.origin : undefined
  const id = `p${nextPermission++}`
  permissionRequests.set(id, { respond, origin, kinds })
  emit({ type: 'permissionRequest', id, tabId: sender.tab.id, origin, topOrigin, kinds })
  return true
})

// Chrome asks before a site downloads several files in a row, and Grove
// can't see that request coming, so let sites download (each download
// still shows up as usual).
chrome.contentSettings.automaticDownloads.set({ primaryPattern: '<all_urls>', setting: 'allow' }).catch(() => {})

// ---- Downloads ----

// The system's icon for each download's file, once there is a file.
const downloadIcons = new Map()
const nameFromUrl = (url) => {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || url
  } catch {
    return url
  }
}
const downloadInfo = async (d) => {
  let icon = downloadIcons.get(d.id)
  if (!icon && d.filename && d.state === 'complete') {
    icon = await chrome.downloads.getFileIcon(d.id, { size: 32 }).catch(() => undefined)
    if (icon) downloadIcons.set(d.id, icon)
  }
  return {
    id: d.id,
    name: d.filename ? d.filename.split(/[\\/]/).pop() : nameFromUrl(d.finalUrl || d.url),
    url: d.finalUrl || d.url,
    state: d.state,
    paused: d.paused,
    canResume: d.canResume,
    received: d.bytesReceived,
    total: d.totalBytes > 0 ? d.totalBytes : 0,
    exists: d.exists,
    error: d.error,
    startTime: d.startTime,
    icon
  }
}
const emitDownload = async (id) => {
  const [d] = await chrome.downloads.search({ id })
  if (d) emit({ type: 'download', download: await downloadInfo(d) })
}
// Chrome says nothing as bytes arrive, so while anything is downloading,
// look now and then.
let downloadPoll
const watchProgress = () => {
  if (downloadPoll) return
  downloadPoll = setInterval(async () => {
    const running = await chrome.downloads.search({ state: 'in_progress' })
    for (const d of running) emit({ type: 'download', download: await downloadInfo(d) })
    if (!running.length || running.every((d) => d.paused)) {
      clearInterval(downloadPoll)
      downloadPoll = undefined
    }
  }, 700)
}
chrome.downloads.onCreated.addListener(async (d) => {
  emit({ type: 'download', download: await downloadInfo(d), created: true })
  watchProgress()
})
chrome.downloads.onChanged.addListener(async ({ id }) => {
  await emitDownload(id)
  watchProgress()
})
chrome.downloads.onErased.addListener((id) => {
  downloadIcons.delete(id)
  emit({ type: 'downloadErased', id })
})

// ---- History, for Grove's URL bar suggestions (host/history-index.ts) ----

const historyItem = (h) => ({
  url: h.url,
  title: h.title || '',
  visitCount: h.visitCount || 0,
  typedCount: h.typedCount || 0,
  lastVisitTime: h.lastVisitTime || 0
})
chrome.history.onVisited.addListener((h) => emit({ type: 'historyVisited', item: historyItem(h) }))

// Translate (translate.js): a page's text, a batch at a time, through
// Google Translate (as Google's own page translator calls it), and how the
// page's translation is going.
async function translateBatch({ texts, source, target }) {
  const body = new URLSearchParams()
  for (const t of texts) body.append('q', t)
  const sl = encodeURIComponent(source || 'auto')
  const tl = encodeURIComponent(target)
  const res = await fetch(`https://translate.googleapis.com/translate_a/t?client=gtx&sl=${sl}&tl=${tl}&format=text`, {
    method: 'POST',
    body
  })
  if (!res.ok) throw new Error(`Google Translate: HTTP ${res.status}`)
  const json = await res.json()
  // [[text, detected language], ...] when asked to detect; [text, ...] otherwise.
  const rows = Array.isArray(json) ? json : [json]
  const translations = rows.map((r) => (Array.isArray(r) ? r[0] : r))
  const langs = rows.map((r) => (Array.isArray(r) ? r[1] : undefined)).filter(Boolean)
  // The language most of the batch was in.
  const count = new Map()
  for (const l of langs) count.set(l, (count.get(l) ?? 0) + 1)
  const detected = [...count].sort((a, b) => b[1] - a[1])[0]?.[0]
  return { translations, source: detected }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.groveTranslateBatch) {
    translateBatch(message.groveTranslateBatch).then(respond, () => respond(null))
    return true
  }
  if (message?.groveTranslateState && sender.tab && !inOther(sender.tab.windowId)) {
    emit({ type: 'translateState', tabId: sender.tab.id, ...message.groveTranslateState })
  }
})

// An extension removed (chrome://extensions): Grove stops loading it if it
// installed it from the Web Store.
chrome.management.onUninstalled.addListener((id) => emit({ type: 'extensionUninstalled', id }))
chrome.history.onVisitRemoved.addListener(({ allHistory, urls }) =>
  emit({ type: 'historyRemoved', all: allHistory, urls: urls || [] })
)

// A page's first paint (permissions-relay.js), or its load where nothing
// painted that the page could see.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message?.grovePainted || !sender.tab || sender.frameId !== 0 || inOther(sender.tab.windowId)) return
  emit({ type: 'tabPainted', tabId: sender.tab.id })
})

globalThis.grove = {
  // Called once the host has installed groveEmit.
  ready() {
    const events = queue.splice(0)
    for (const e of events) emit(e)
    return events.length
  },
  async snapshot() {
    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] })
    return windows.map((w) => ({ id: w.id, focused: w.focused, tabs: w.tabs.map(tabInfo) }))
  },
  async create({ windowId, url, active = true, requestId }) {
    if (requestId) {
      if (!pending.has(windowId)) pending.set(windowId, [])
      pending.get(windowId).push(requestId)
    }
    const tab = await chrome.tabs.create({ windowId, url, active })
    return tabInfo(tab)
  },
  // Every page in history, for the host's index.
  async history() {
    const items = await chrome.history.search({ text: '', startTime: 0, maxResults: 100000 })
    return items.map(historyItem)
  },
  async forgetUrl(url) {
    await chrome.history.deleteUrl({ url })
  },
  // What Chrome would warn an extension with this manifest can do.
  async permissionWarnings(manifest) {
    return chrome.management.getPermissionWarningsByManifest(manifest)
  },
  // Translate: start (to a language) or stop translating a tab's page, the
  // page's language as Chrome tells it, and the user's.
  async translate({ tabId, to }) {
    await chrome.tabs.sendMessage(tabId, { groveTranslate: to ?? null }).catch(() => {})
  },
  async detectLanguage(tabId) {
    return chrome.tabs.detectLanguage(tabId).catch(() => 'und')
  },
  uiLanguage() {
    return chrome.i18n.getUILanguage()
  },
  // Turns an extension off (Grove removing one it installed: Chrome drops
  // it for good at its next start).
  async disableExtension(id) {
    await chrome.management.setEnabled(id, false)
  },
  // Whether an extension is installed (by Grove or otherwise), and how.
  async extension(id) {
    const e = await chrome.management.get(id).catch(() => undefined)
    return e ? { installType: e.installType, version: e.version, enabled: e.enabled } : null
  },
  async navigate({ tabId, url }) {
    return tabInfo(await chrome.tabs.update(tabId, { url, active: true }))
  },
  async activate(tabId) {
    const tab = await chrome.tabs.update(tabId, { active: true })
    return tabInfo(tab)
  },
  async move({ tabId, windowId, active = true }) {
    const [moved] = [await chrome.tabs.move(tabId, { windowId, index: -1 })].flat()
    return tabInfo(active ? await chrome.tabs.update(tabId, { active: true }) : moved)
  },
  // Each normal window's tab ids in Chrome's order (split view finds a
  // pane's page by its place in its window).
  async order() {
    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] })
    return Object.fromEntries(windows.map((w) => [w.id, w.tabs.map((t) => t.id)]))
  },
  // A small JPEG of what a window shows now, or null where Chrome won't
  // capture (its own pages).
  async capture(windowId) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 45 })
    } catch {
      return null
    }
  },
  // A tab as Chrome has it now, or null once it's gone.
  async get(tabId) {
    try {
      return tabInfo(await chrome.tabs.get(tabId))
    } catch {
      return null
    }
  },
  async remove(tabIds) {
    await chrome.tabs.remove(tabIds)
  },
  // Closes tabs, one at a time so each is its own recently closed entry
  // (oldest first: Chrome forgets the oldest), and says which session
  // each became: tab id -> session id.
  async unload(tabIds) {
    const sessions = {}
    for (const id of tabIds) {
      const tab = await chrome.tabs.get(id).catch(() => undefined)
      if (!tab) continue
      const url = tab.url || tab.pendingUrl
      const before = new Set((await recentlyClosed()).map(sessionIdOf))
      await chrome.tabs.remove(id).catch(() => {})
      for (let i = 0; i < 20 && !sessions[id]; i++) {
        const s = (await recentlyClosed()).find((c) => c.tab && !before.has(c.tab.sessionId) && c.tab.url === url)
        if (s) sessions[id] = s.tab.sessionId
        else await new Promise((r) => setTimeout(r, 50))
      }
      if (sessions[id]) unloaded.set(sessions[id], url)
    }
    // Forget sessions Chrome has dropped.
    const alive = new Set((await recentlyClosed()).map(sessionIdOf))
    for (const id of unloaded.keys()) if (!alive.has(id)) unloaded.delete(id)
    return sessions
  },
  // Reopens an unloaded tab in a window, active. Null if Chrome no longer
  // has its session.
  async restore({ sessionId, windowId, requestId }) {
    unloaded.delete(sessionId)
    restoring++
    let tab
    try {
      tab = (await chrome.sessions.restore(sessionId))?.tab
      if (tab) restoredRequests.set(tab.id, requestId)
    } catch {
      // Gone.
    } finally {
      restoring--
    }
    if (!restoring) {
      // As they are now (they may have loaded meanwhile); a tab already
      // closed again is left out.
      const waiting = held.splice(0)
      for (const t of waiting) {
        const now = await chrome.tabs.get(t.id).catch(() => undefined)
        if (now) await emitCreated(now)
        else restoredRequests.delete(t.id)
      }
    }
    if (!tab) return null
    if (tab.windowId !== windowId) {
      await chrome.tabs.move(tab.id, { windowId, index: -1 })
      tab = await chrome.tabs.update(tab.id, { active: true })
    }
    return tabInfo(tab)
  },
  // Whether the user has typed into the tab's page something it would lose.
  async edited(tabId) {
    return (await chrome.tabs.sendMessage(tabId, { groveEdited: true }).catch(() => false)) === true
  },
  async downloads() {
    const list = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 50 })
    if (list.some((d) => d.state === 'in_progress')) watchProgress()
    return Promise.all(list.map(downloadInfo))
  },
  async downloadAction({ id, action }) {
    const act = {
      open: () => chrome.downloads.open(id),
      show: () => chrome.downloads.show(id),
      pause: () => chrome.downloads.pause(id),
      resume: () => chrome.downloads.resume(id),
      cancel: () => chrome.downloads.cancel(id),
      remove: () => chrome.downloads.erase({ id }),
      retry: async () => {
        const [d] = await chrome.downloads.search({ id })
        if (d) await chrome.downloads.download({ url: d.url })
      }
    }[action]
    await act?.()
    if (action !== 'remove') await emitDownload(id)
  },
  async clearDownloads() {
    for (const state of ['complete', 'interrupted']) await chrome.downloads.erase({ state })
  },
  async focusWindow(windowId) {
    await chrome.windows.update(windowId, { focused: true })
  },
  // The person's answer to a permission request: 'allow' and 'block' are
  // kept as Chrome's site settings (which then answer the page's call);
  // 'dismiss' decides nothing.
  async answerPermission({ id, decision }) {
    const request = permissionRequests.get(id)
    if (!request) return
    permissionRequests.delete(id)
    if (decision === 'allow' || decision === 'block') {
      for (const kind of request.kinds.filter((k) => k in PERMISSION_SETTINGS)) {
        await chrome.contentSettings[PERMISSION_SETTINGS[kind]]
          .set({ primaryPattern: `${request.origin}/*`, setting: decision })
          .catch(() => {})
      }
    }
    request.respond(decision)
  }
}
