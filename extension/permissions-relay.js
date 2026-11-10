// Grove's permission prompts, relay: carries permissions-main.js's requests
// from the page's world to the bridge, and the answers back. The origin
// asked about is taken from here, not from the page: the top-level site,
// which is what Chrome keys a frame's permissions on.
const REQUEST = 'grove:permission-request'
const ANSWER = 'grove:permission-answer'

const topOrigin = () => {
  const ancestors = location.ancestorOrigins
  return ancestors && ancestors.length ? ancestors[ancestors.length - 1] : location.origin
}

// permissions-main.js and this script talk over a private channel: a node
// in no document, handed over before any of the page's scripts run, so
// neither the page nor another frame can send requests or answers, or
// read them. (Events on the document could be sent by anyone there.)
const HELLO_MAIN = 'grove:hello-main'
const HELLO_RELAY = 'grove:hello-relay'
const PAIRED = 'grove:paired'
const HELPER_ANSWER = 'grove:helper'
const channel = document.createElement('grove-channel')
let paired = false
const announce = () => {
  if (!paired) document.dispatchEvent(new MouseEvent(HELLO_RELAY, { relatedTarget: channel }))
}
document.addEventListener(HELLO_MAIN, announce, true)
channel.addEventListener(PAIRED, () => {
  paired = true
  document.removeEventListener(HELLO_MAIN, announce, true)
})
announce()

const reply = (id, decision) =>
  channel.dispatchEvent(new CustomEvent(ANSWER, { detail: JSON.stringify({ id, decision }) }))

channel.addEventListener(REQUEST, (e) => {
  let request
  try {
    request = JSON.parse(e.detail)
  } catch {
    return
  }
  const { id, kinds } = request
  const origin = topOrigin()
  if (!/^https?:\/\//.test(origin) || !Array.isArray(kinds)) {
    reply(id, 'fallback')
    return
  }
  let asked
  try {
    asked = chrome.runtime.sendMessage({ grovePermission: { origin, frameOrigin: location.origin, kinds } })
  } catch {
    // The extension went away (reloaded): nothing will answer.
    reply(id, 'dismiss')
    return
  }
  reply(id, 'ack')
  asked.then(
    (decision) => reply(id, decision ?? 'dismiss'),
    () => reply(id, 'dismiss')
  )
})

// A window named as one of Grove's picker popups: the bridge says whether
// it really is a popup window (a page can name its own window anything).
if (window.name.startsWith('grove-helper:')) {
  const answer = (ok) => channel.dispatchEvent(new CustomEvent(HELPER_ANSWER, { detail: ok ? '1' : '' }))
  try {
    chrome.runtime.sendMessage({ groveHelperWindow: true }).then(answer, () => answer(false))
  } catch {
    answer(false)
  }
}

// ---- Unsaved input ----
// Grove unloads tabs left alone for a while, but not one whose page holds
// text the user typed and hasn't sent: a field they typed into that still
// has something in it (a message box that's been sent and emptied doesn't
// count). Only frames with such text answer.
const typedInto = new Set()
const TEXT_INPUTS = /^(text|search|email|url|tel|password|number|)$/
// Fields left the page are forgotten (strong references: a WeakRef to a
// DOM node's wrapper can come back empty while the node is still there).
const forgetDetached = () => {
  for (const el of typedInto) if (!el.isConnected) typedInto.delete(el)
}
document.addEventListener(
  'input',
  (e) => {
    const target = e.composedPath()[0]
    if (!e.isTrusted || !(target instanceof Element)) return
    forgetDetached()
    typedInto.add(target)
  },
  true
)
// (Not "differs from its default": React keeps a field's default in step
// with its value.)
const holdsText = (el) => {
  if (el instanceof HTMLTextAreaElement) return !!el.value.trim()
  if (el instanceof HTMLInputElement) return TEXT_INPUTS.test(el.type) && !!el.value.trim()
  return el.isContentEditable && !!el.textContent.trim()
}
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (!message?.groveEdited) return
  forgetDetached()
  if ([...typedInto].some(holdsText)) respond(true)
})

// ---- First paint ----
// Until a new tab's page draws, Webium shows nothing where it goes, and the
// desktop shows through the window. Grove covers it until the page has
// drawn: say so once, on its first paint, or on load for a page that
// painted nothing a paint entry records (a blank page).
if (window === window.top) {
  let told = false
  const tell = () => {
    if (told) return
    told = true
    chrome.runtime.sendMessage({ grovePainted: true }).catch(() => {})
  }
  try {
    new PerformanceObserver((list, observer) => {
      if (!list.getEntries().length) return
      observer.disconnect()
      tell()
    }).observe({ type: 'paint', buffered: true })
  } catch {}
  addEventListener('load', () => requestAnimationFrame(() => requestAnimationFrame(tell)), { once: true })
}
