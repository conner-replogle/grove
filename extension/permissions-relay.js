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
