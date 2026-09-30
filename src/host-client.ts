// The UI's line to the Grove host (the launcher). The host pushes this
// window's state through window.__groveHost.update(); the UI sends commands
// through the groveHostCall binding the launcher installs in the page.
import { UI_BINDING, UI_RECEIVER, type HostCommand, type WindowState } from '../shared/protocol.ts'

type Listener = (state: WindowState) => void

const listeners = new Set<Listener>()
const urlBarListeners = new Set<() => void>()
const newTabSearchListeners = new Set<() => void>()

// Calls `fn` when the host asks this window to open its URL bar (a new tab).
export function onFocusUrlBar(fn: () => void): void {
  urlBarListeners.add(fn)
}

// Calls `fn` when the host asks this window to open a new tab's search
// (Ctrl+T).
export function onOpenNewTabSearch(fn: () => void): void {
  newTabSearchListeners.add(fn)
}
let last: WindowState | undefined

;(window as unknown as Record<string, unknown>)[UI_RECEIVER] = {
  update(state: WindowState) {
    last = state
    listeners.forEach((l) => l(state))
  },
  focusUrlBar() {
    urlBarListeners.forEach((l) => l())
  },
  openNewTabSearch() {
    newTabSearchListeners.forEach((l) => l())
  }
}

export function send(command: HostCommand): void {
  const call = (window as unknown as Record<string, unknown>)[UI_BINDING]
  if (typeof call === 'function') (call as (s: string) => void)(JSON.stringify(command))
  else console.error('[grove] host binding missing; is the launcher running?')
}

// Calls `fn` with every state the host pushes, starting with the latest.
// The first subscriber says hello, which also tells the host this window's
// UI is up (it waits for that before changing the window's tabs).
let greeted = false
export function subscribe(fn: Listener): () => void {
  listeners.add(fn)
  if (last) fn(last)
  if (!greeted) {
    greeted = true
    send({ type: 'hello' })
  }
  return () => listeners.delete(fn)
}
