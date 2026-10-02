// Downloads, as in Zen: a button at the bottom left of the sidebar (with a
// ring showing progress while anything downloads) opens a panel over the
// bottom left of the page listing recent downloads. Click a finished one
// to open it. The list is Chrome's own, through the host.
import downloadSvg from 'lucide-static/icons/download.svg'
import fileSvg from 'lucide-static/icons/file.svg'
import folderOpenSvg from 'lucide-static/icons/folder-open.svg'
import pauseSvg from 'lucide-static/icons/pause.svg'
import playSvg from 'lucide-static/icons/play.svg'
import rotateCcwSvg from 'lucide-static/icons/rotate-ccw.svg'
import type { DownloadAction, DownloadView, WindowState } from '../shared/protocol.ts'
import { send, subscribe } from './host-client'
import { icons } from './icons'
import { svg } from './svg'

const TOGGLE = 'grove-downloads-toggle'

export function toggleDownloads(): void {
  window.dispatchEvent(new Event(TOGGLE))
}

// The sidebar's button: the download arrow, a ring for overall progress,
// and a pulse when a download starts.
// `seen`: the downloads this window has shown already (none yet: `primed`
// is false, and nothing pulses).
export interface Seen {
  ids: Set<number>
  primed: boolean
}

export function downloadsButton(s: WindowState, seen: Seen): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = 'tbtn downloads-button'
  b.title = 'Downloads'
  b.append(svg(downloadSvg))
  const running = s.downloads.filter((d) => d.state === 'in_progress' && !d.paused)
  if (running.length) {
    const total = running.reduce((n, d) => n + d.total, 0)
    const got = running.reduce((n, d) => n + d.received, 0)
    b.classList.add('active')
    b.style.setProperty('--progress', total ? String(got / total) : '0.1')
    b.classList.toggle('indeterminate', !total)
  }
  const fresh = s.downloads.some((d) => !seen.ids.has(d.id))
  for (const d of s.downloads) seen.ids.add(d.id)
  if (fresh && seen.primed) b.classList.add('pulse')
  seen.primed = true
  b.addEventListener('click', toggleDownloads)
  return b
}

export function showDownloads(main: () => HTMLElement | null): void {
  let panel: HTMLElement | undefined
  let latest: DownloadView[] = []

  const close = (): void => {
    panel?.remove()
    panel = undefined
  }
  const render = (): void => {
    if (!panel) return
    panel.replaceChildren(...content(latest))
  }
  window.addEventListener(TOGGLE, () => {
    if (panel) return close()
    const host = main()
    if (!host) return
    panel = el('div', 'grove-downloads')
    panel.setAttribute('role', 'dialog')
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close()
    })
    host.append(panel)
    render()
  })
  // A click anywhere else closes it.
  document.addEventListener(
    'mousedown',
    (e) => {
      if (!panel) return
      const path = e.composedPath()
      if (path.includes(panel) || path.some((n) => n instanceof Element && n.classList.contains('downloads-button'))) return
      close()
    },
    true
  )
  subscribe((s) => {
    latest = s.downloads
    render()
  })
}

function content(downloads: DownloadView[]): HTMLElement[] {
  const head = el('div', 'grove-downloads-head')
  head.append(el('span', 'grove-downloads-title', 'Downloads'))
  if (downloads.some((d) => d.state !== 'in_progress')) {
    const clear = el('button', 'grove-downloads-clear', 'Clear')
    clear.title = 'Take finished downloads off the list (the files stay)'
    clear.addEventListener('click', () => send({ type: 'clearDownloads' }))
    head.append(clear)
  }
  if (!downloads.length) return [head, el('div', 'grove-downloads-empty', 'No downloads yet')]
  const list = el('div', 'grove-downloads-list')
  for (const d of downloads) list.append(row(d))
  return [head, list]
}

function row(d: DownloadView): HTMLElement {
  const act = (action: DownloadAction) => (e: Event) => {
    e.stopPropagation()
    send({ type: 'download', id: d.id, action })
  }
  const done = d.state === 'complete'
  const gone = done && !d.exists
  const r = el('div', `grove-download ${d.state}${d.paused ? ' paused' : ''}${gone ? ' gone' : ''}`)
  r.title = d.url
  const icon = el('span', 'grove-download-icon')
  if (d.icon) {
    const img = document.createElement('img')
    img.src = d.icon
    img.alt = ''
    icon.append(img)
  } else {
    icon.append(svg(fileSvg))
  }
  const text = el('div', 'grove-download-text')
  text.append(el('span', 'grove-download-name', d.name), el('span', 'grove-download-sub', describe(d)))
  if (d.state === 'in_progress') {
    const bar = el('div', 'grove-download-bar')
    const fill = el('div', 'grove-download-fill')
    fill.style.width = d.total ? `${Math.round((d.received / d.total) * 100)}%` : '30%'
    bar.classList.toggle('indeterminate', !d.total)
    bar.append(fill)
    text.append(bar)
  }
  const actions = el('div', 'grove-download-actions')
  const button = (markup: string, title: string, action: DownloadAction): void => {
    const b = el('button', 'grove-download-action')
    b.title = title
    b.append(svg(markup))
    b.addEventListener('click', act(action))
    actions.append(b)
  }
  if (d.state === 'in_progress') {
    if (d.paused) button(playSvg, 'Resume', 'resume')
    else button(pauseSvg, 'Pause', 'pause')
    button(icons.x, 'Cancel', 'cancel')
  } else if (d.state === 'interrupted') {
    if (d.canResume) button(playSvg, 'Resume', 'resume')
    else button(rotateCcwSvg, 'Try again', 'retry')
    button(icons.x, 'Remove from list', 'remove')
  } else {
    if (!gone) button(folderOpenSvg, 'Show in folder', 'show')
    button(icons.x, 'Remove from list', 'remove')
  }
  r.append(icon, text, actions)
  if (done && !gone) r.addEventListener('click', act('open'))
  return r
}

function describe(d: DownloadView): string {
  if (d.state === 'complete') return d.exists ? size(d.total || d.received) : 'Deleted'
  if (d.state === 'interrupted') return d.error === 'USER_CANCELED' ? 'Canceled' : `Failed${d.error ? ` · ${reason(d.error)}` : ''}`
  const of = d.total ? `${size(d.received)} of ${size(d.total)}` : size(d.received)
  return d.paused ? `Paused · ${of}` : of
}

function reason(error: string): string {
  return error.replace(/^(FILE|NETWORK|SERVER|USER|CRASH)_/, '').toLowerCase().replace(/_/g, ' ')
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let n = bytes / 1024
  let u = 0
  while (n >= 1000 && u < units.length - 1) {
    n /= 1024
    u++
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[u]}`
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}
