// Debug mode's side in the window (the host keeps the 30 seconds:
// host/debug.ts). While it is on, the clicks, keys and focus moves in the
// window's UI go to the console, which the launcher keeps; the sidebar
// shows a bug button that saves the packet; and a note says where it went.
import bugSvg from 'lucide-static/icons/bug.svg'
import type { WindowState } from '../shared/protocol.ts'
import { send, subscribe } from './host-client'
import { svg } from './svg'

export function debugButton(s: WindowState): HTMLButtonElement | undefined {
  if (!s.debug) return undefined
  const b = document.createElement('button')
  b.className = 'tbtn debug-button'
  b.title = s.debug.saving ? 'Saving…' : 'Save the last 30 seconds for a bug report'
  b.disabled = s.debug.saving
  b.append(svg(bugSvg))
  b.addEventListener('click', () => send({ type: 'debugSave' }))
  return b
}

export function recordDebugInput(): void {
  let on = false
  let listening = false
  let shownAt: number | undefined
  let note: HTMLElement | undefined

  subscribe((s) => {
    on = !!s.debug
    if (on && !listening) listen()
    const d = s.debug
    if (!d) return note?.remove()
    if (d.error && !d.saving) showNote(`Couldn't save the debug packet: ${d.error}`)
    else if (d.saved && d.saved.at !== shownAt) {
      // The first state only says what an earlier save left.
      if (shownAt !== undefined || Date.now() - d.saved.at < 5000) showNote(`Saved ${d.saved.path.split('/').pop()}`, true)
      shownAt = d.saved.at
    }
  })

  function listen(): void {
    listening = true
    const opts = { capture: true, passive: true }
    addEventListener('pointerdown', (e) => on && input(`${e.type} ${e.button} at ${Math.round(e.clientX)},${Math.round(e.clientY)}`, e), opts)
    addEventListener('contextmenu', (e) => on && input(`contextmenu at ${Math.round(e.clientX)},${Math.round(e.clientY)}`, e), opts)
    addEventListener('keydown', (e) => on && input(`keydown ${keyName(e)}`, e), opts)
    addEventListener('focusin', (e) => on && input('focus', e), opts)
    addEventListener('blur', (e) => on && e.target === window && console.debug('[input] window blurred'), opts)
    addEventListener('focus', (e) => on && e.target === window && console.debug('[input] window focused'), opts)
  }

  function showNote(text: string, reveal = false): void {
    note?.remove()
    const root = document.querySelector('webui-browser-app')?.shadowRoot
    if (!root) return
    const n = document.createElement('div')
    n.className = 'grove-debug-note'
    n.append(text)
    if (reveal) {
      const show = document.createElement('button')
      show.textContent = 'Show'
      show.addEventListener('click', () => {
        send({ type: 'debugReveal' })
        n.remove()
      })
      n.append(show)
    }
    root.append(n)
    note = n
    setTimeout(() => n.remove(), 8000)
  }
}

function input(what: string, e: Event): void {
  console.debug(`[input] ${what} on ${describe(e.composedPath()[0])}`)
}

// The key, with its modifiers. Letters typed into Grove's settings (sync
// codes, API tokens) are kept out.
function keyName(e: KeyboardEvent): string {
  const field = e.composedPath()[0]
  const secret = field instanceof Element && !!field.closest('.grove-settings, [type=password]')
  const key = secret && e.key.length === 1 ? '•' : e.key
  return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && e.key.length > 1 && 'Shift', e.metaKey && 'Meta', key]
    .filter(Boolean)
    .join('+')
}

// An element as a short path: the element and the two above it, each as
// tag#id.class, with the element's label or text.
function describe(target: EventTarget | undefined): string {
  if (!(target instanceof Element)) return String(target?.constructor?.name ?? 'nothing')
  const parts: string[] = []
  let el: Element | null = target
  for (let i = 0; el && i < 3; i++) {
    const cls = [...el.classList].slice(0, 3).map((c) => `.${c}`).join('')
    parts.unshift(`${el.localName}${el.id ? `#${el.id}` : ''}${cls}`)
    el = el.parentElement ?? ((el.getRootNode() as ShadowRoot).host || null)
  }
  const label = target.getAttribute('aria-label') ?? target.getAttribute('title') ?? target.textContent?.trim()
  return parts.join(' > ') + (label ? ` "${label.slice(0, 40)}"` : '')
}
