// Zen's compact mode: the sidebar can be hidden, giving the page the whole
// window. It slides back over the page while the pointer rests on the
// window's left edge, and goes again once the pointer leaves it. Like the
// sidebar's width, the choice is shared by every window and kept across
// restarts.
import panelCloseSvg from 'lucide-static/icons/panel-left-close.svg'
import panelOpenSvg from 'lucide-static/icons/panel-left-open.svg'
import { svg } from './svg'

const KEY = 'grove.sidebarHidden'
// How long the sidebar stays after the pointer leaves it (Zen's
// zen.view.compact.sidebar-keep-hover.duration is similar).
const KEEP_MS = 300

const listeners = new Set<() => void>()

export function sidebarHidden(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

function setHidden(hidden: boolean): void {
  try {
    if (hidden) localStorage.setItem(KEY, '1')
    else localStorage.removeItem(KEY)
  } catch {}
  // localStorage's storage event only reaches the other windows.
  for (const l of listeners) l()
}

// The footer button: hides the sidebar, or keeps it open again.
export function sidebarToggle(): HTMLElement {
  const hidden = sidebarHidden()
  const button = document.createElement('button')
  button.className = 'tbtn sidebar-toggle'
  button.title = hidden ? 'Keep the sidebar open' : 'Hide the sidebar'
  button.append(svg(hidden ? panelOpenSvg : panelCloseSvg))
  button.addEventListener('click', () => setHidden(!sidebarHidden()))
  return button
}

// Sets up compact mode on `app` (webui-browser-app) and returns the strip
// along the window's left edge that shows the hidden sidebar, to put in its
// grid. Windows get a `grove-sidebar-hidden` event when it changes.
export function compactMode(app: HTMLElement): HTMLElement {
  const edge = document.createElement('div')
  edge.className = 'grove-compact-edge'
  let leave: ReturnType<typeof setTimeout> | undefined
  const peek = (on: boolean): void => {
    clearTimeout(leave)
    leave = undefined
    app.classList.toggle('grove-peek', on)
  }
  const apply = (): void => {
    app.classList.toggle('grove-compact', sidebarHidden())
    peek(false)
    dispatchEvent(new Event('grove-sidebar-hidden'))
  }
  listeners.add(apply)
  addEventListener('storage', (e) => {
    if (e.key === KEY) apply()
  })
  apply()

  edge.addEventListener('pointerenter', () => {
    if (app.classList.contains('grove-compact')) peek(true)
  })
  const sidebar = (): HTMLElement | null | undefined => app.shadowRoot?.querySelector<HTMLElement>('#topContainer')
  // Goes once the pointer is off it, but not while its URL bar is open.
  const hideLater = (): void => {
    if (!app.classList.contains('grove-peek')) return
    clearTimeout(leave)
    leave = setTimeout(() => {
      const box = sidebar()
      if (box?.matches(':hover, :has(#address:focus-within)')) return
      peek(false)
    }, KEEP_MS)
  }
  app.shadowRoot?.addEventListener('pointerover', (e) => {
    if (leave && sidebar()?.contains(e.target as Node)) peek(true)
  })
  app.shadowRoot?.addEventListener('pointerout', (e) => {
    const box = sidebar()
    const to = (e as PointerEvent).relatedTarget as Node | null
    if (!box || (to && (box.contains(to) || to === edge))) return
    if (box.contains(e.target as Node) || e.target === edge) hideLater()
  })
  app.shadowRoot?.addEventListener('focusout', hideLater)
  return edge
}
