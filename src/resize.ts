// The sidebar's width: a handle on its right edge drags it between MIN and
// MAX, double-click resets it. The width is shared by every window (they
// all run on chrome://webui-browser, so they share its localStorage) and
// kept across restarts.
const KEY = 'grove.sidebarWidth'
const MIN = 150
const MAX = 480

function saved(): number | undefined {
  try {
    const n = Number(localStorage.getItem(KEY))
    return n >= MIN && n <= MAX ? n : undefined
  } catch {
    return undefined
  }
}

function save(width: number | undefined): void {
  try {
    if (width === undefined) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, String(width))
  } catch {}
}

function apply(app: HTMLElement, width: number | undefined): void {
  if (width === undefined) app.style.removeProperty('--sidebar-w')
  else app.style.setProperty('--sidebar-w', `${width}px`)
}

// Returns the handle for `app` (webui-browser-app), to put in its grid.
export function sidebarResizer(app: HTMLElement): HTMLElement {
  apply(app, saved())
  addEventListener('storage', (e) => {
    if (e.key === KEY) apply(app, saved())
  })

  const handle = document.createElement('div')
  handle.className = 'grove-resizer'
  handle.title = 'Drag to resize the sidebar'
  let start: { x: number; width: number } | undefined
  let width: number | undefined

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const sidebar = app.shadowRoot?.querySelector('#topContainer')
    start = { x: e.clientX, width: sidebar?.getBoundingClientRect().width ?? MIN }
    handle.setPointerCapture(e.pointerId)
    app.classList.add('grove-resizing')
  })
  handle.addEventListener('pointermove', (e) => {
    if (!start) return
    width = Math.round(Math.max(MIN, Math.min(MAX, start.width + e.clientX - start.x)))
    apply(app, width)
  })
  const stop = (): void => {
    if (!start) return
    start = undefined
    app.classList.remove('grove-resizing')
    if (width !== undefined) save(width)
  }
  handle.addEventListener('pointerup', stop)
  handle.addEventListener('pointercancel', stop)
  handle.addEventListener('lostpointercapture', stop)
  handle.addEventListener('dblclick', () => {
    width = undefined
    save(undefined)
    apply(app, undefined)
  })
  return handle
}
