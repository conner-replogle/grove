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

const reply = (id, decision) =>
  document.dispatchEvent(new CustomEvent(ANSWER, { detail: JSON.stringify({ id, decision }) }))

document.addEventListener(REQUEST, (e) => {
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
  reply(id, 'ack')
  chrome.runtime.sendMessage({ grovePermission: { origin, frameOrigin: location.origin, kinds } }).then(
    (decision) => reply(id, decision ?? 'dismiss'),
    () => reply(id, 'dismiss')
  )
})

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
