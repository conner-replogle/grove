// Translates a page in place, for Grove's Translate button (the bridge asks;
// host/translate.ts). Chrome's own Translate doesn't work in Grove (its
// bubble is native UI a Webium window can't show, and ungoogled-chromium
// has no translate service), so this does what Google's page translator
// does: the page's text nodes go to Google Translate in batches, through
// the bridge (no page CSP in the way), and come back translated. The page
// keeps running and stays signed in; Show original puts the text back.
// New text the page adds while translated is translated too.
;(() => {
  // Not translated: code, things typed into, and what a page marks so.
  const SKIP = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'SVG', 'MATH', 'CANVAS', 'IFRAME'
  ])
  const BATCH_NODES = 80
  const BATCH_CHARS = 4500

  let target = null
  let source = 'auto'
  // Each translated text node and the text it had, and what this script
  // wrote into it (to tell its own changes from the page's).
  let originals = new Map()
  let written = new WeakMap()
  let observer
  let pending = new Set()
  let timer

  const wanted = (node) => {
    if (!/\p{L}/u.test(node.data)) return false
    for (let el = node.parentElement; el; el = el.parentElement) {
      if (SKIP.has(el.tagName)) return false
      if (el.getAttribute('translate') === 'no' || el.classList.contains('notranslate')) return false
      if (el.isContentEditable) return false
    }
    return true
  }

  const textNodes = (root) => {
    const out = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!originals.has(n) && wanted(n)) out.push(n)
    return out
  }

  async function translateNodes(nodes) {
    let batch = []
    let chars = 0
    const flush = async () => {
      if (!batch.length) return
      const nodesNow = batch
      batch = []
      chars = 0
      const texts = nodesNow.map((n) => n.data.trim())
      const reply = await chrome.runtime.sendMessage({ groveTranslateBatch: { texts, source, target } }).catch(() => null)
      if (!reply?.translations || !target) return
      if (source === 'auto' && reply.source) source = reply.source
      nodesNow.forEach((node, i) => {
        const out = reply.translations[i]
        if (typeof out !== 'string' || !node.isConnected) return
        const was = node.data
        if (!originals.has(node)) originals.set(node, was)
        const lead = was.match(/^\s*/)[0]
        const trail = was.match(/\s*$/)[0]
        node.data = lead + out + trail
        written.set(node, node.data)
      })
    }
    for (const node of nodes) {
      batch.push(node)
      chars += node.data.length
      if (batch.length >= BATCH_NODES || chars >= BATCH_CHARS) await flush()
    }
    await flush()
  }

  // Text the page adds or changes while translated.
  const watch = () => {
    observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'characterData') {
          // This script's own writes aside, a change is new text to translate.
          if (written.get(r.target) === r.target.data) continue
          originals.delete(r.target)
          pending.add(r.target)
        } else {
          for (const n of r.addedNodes) {
            if (n.nodeType === Node.TEXT_NODE) pending.add(n)
            else if (n.nodeType === Node.ELEMENT_NODE) for (const t of textNodes(n)) pending.add(t)
          }
        }
      }
      clearTimeout(timer)
      timer = setTimeout(() => {
        const nodes = [...pending].filter((n) => n.isConnected && !originals.has(n) && wanted(n))
        pending = new Set()
        if (nodes.length && target) void translateNodes(nodes)
      }, 300)
    })
    observer.observe(document.body ?? document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      characterDataOldValue: true
    })
  }

  const report = (state) => {
    if (window === top) chrome.runtime.sendMessage({ groveTranslateState: { state, source } }).catch(() => {})
  }

  async function start(to) {
    if (target === to) return
    if (target) stop(false)
    target = to
    source = 'auto'
    report('translating')
    // Visible text first: the page reads translated sooner.
    const nodes = textNodes(document.body ?? document.documentElement)
    const visible = []
    const rest = []
    const view = window.innerHeight * 2
    for (const n of nodes) {
      const r = n.parentElement?.getBoundingClientRect()
      ;(r && r.bottom > 0 && r.top < view ? visible : rest).push(n)
    }
    await translateNodes(visible)
    if (!target) return
    report('translated')
    watch()
    await translateNodes(rest)
  }

  function stop(tell = true) {
    observer?.disconnect()
    observer = undefined
    clearTimeout(timer)
    pending = new Set()
    for (const [node, text] of originals) node.data = text
    originals = new Map()
    written = new WeakMap()
    target = null
    if (tell) report('original')
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!('groveTranslate' in (message ?? {}))) return
    if (message.groveTranslate) void start(message.groveTranslate)
    else stop()
  })
})()
