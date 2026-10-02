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

chrome.tabs.onCreated.addListener((tab) => {
  if (inOther(tab.windowId)) return
  const q = pending.get(tab.windowId)
  const requestId = q && q.length ? q.shift() : undefined
  emit({ type: 'tabCreated', tab: tabInfo(tab), requestId })
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
chrome.windows.onCreated.addListener((w) => {
  if (w.type !== 'normal') otherWindows.add(w.id)
  else emit({ type: 'windowCreated', windowId: w.id })
})
chrome.windows.onRemoved.addListener((windowId) => {
  if (!otherWindows.delete(windowId)) emit({ type: 'windowRemoved', windowId })
})
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
  async activate(tabId) {
    const tab = await chrome.tabs.update(tabId, { active: true })
    return tabInfo(tab)
  },
  async move({ tabId, windowId }) {
    await chrome.tabs.move(tabId, { windowId, index: -1 })
    const tab = await chrome.tabs.update(tabId, { active: true })
    return tabInfo(tab)
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
