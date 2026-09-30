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

chrome.tabs.onCreated.addListener((tab) => {
  const q = pending.get(tab.windowId)
  const requestId = q && q.length ? q.shift() : undefined
  emit({ type: 'tabCreated', tab: tabInfo(tab), requestId })
})
chrome.tabs.onRemoved.addListener((tabId, info) =>
  emit({ type: 'tabRemoved', tabId, windowId: info.windowId, windowClosing: info.isWindowClosing })
)
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if ('url' in change || 'title' in change || 'favIconUrl' in change || 'status' in change || 'audible' in change) {
    emit({ type: 'tabUpdated', tab: tabInfo(tab) })
  }
})
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => emit({ type: 'tabActivated', tabId, windowId }))
chrome.tabs.onAttached.addListener((tabId, { newWindowId }) => emit({ type: 'tabAttached', tabId, windowId: newWindowId }))
chrome.windows.onCreated.addListener((w) => emit({ type: 'windowCreated', windowId: w.id }))
chrome.windows.onRemoved.addListener((windowId) => emit({ type: 'windowRemoved', windowId }))

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
  async remove(tabIds) {
    await chrome.tabs.remove(tabIds)
  },
  async focusWindow(windowId) {
    await chrome.windows.update(windowId, { focused: true })
  }
}
