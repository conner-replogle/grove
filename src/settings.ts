// Grove's settings: a card over the page, opened from the gear at the
// bottom of the sidebar. Sync (its state, what it syncs, the sync code
// that joins another device, joining or starting one, turning it off) and
// general settings. The host keeps them; this only shows and sends.
import closeSvg from 'lucide-static/icons/x.svg'
import { UNLOAD_CHOICES, type GroveSettings, type SyncStatus, type WindowState } from '../shared/protocol.ts'
import { send, subscribe } from './host-client'
import { svg } from './svg'

const OPEN = 'grove-settings-open'

export function openSettings(): void {
  window.dispatchEvent(new Event(OPEN))
}

export function showSettings(main: () => HTMLElement | null): void {
  let view: SettingsView | undefined
  let latest: WindowState | undefined
  window.addEventListener(OPEN, () => {
    if (view) return view.close()
    const host = main()
    if (!host || !latest) return
    view = new SettingsView(() => (view = undefined))
    host.append(view.node)
    view.update(latest)
  })
  subscribe((s) => {
    latest = s
    view?.update(s)
  })
}

class SettingsView {
  readonly node = el('div', 'grove-settings-backdrop')
  private readonly card = el('div', 'grove-settings')
  private readonly onClose: () => void
  private state?: WindowState
  private showCode = false
  private copied = false
  private readonly timer: ReturnType<typeof setInterval>

  // Sync, on.
  private readonly statusDot = el('span', 'grove-sync-dot')
  private readonly statusText = el('span', 'grove-sync-state')
  private readonly onPart = el('div', 'grove-settings-group')
  private readonly server = el('span', 'grove-settings-value')
  private readonly counts = el('span', 'grove-settings-value')
  private readonly syncTabs = toggle()
  private readonly code = el('code', 'grove-sync-code')
  private readonly showButton = el('button', 'grove-settings-button', 'Show')
  private readonly copyButton = el('button', 'grove-settings-button', 'Copy')
  // Sync, off.
  private readonly offPart = el('div', 'grove-settings-group')
  private readonly joinInput = input('Paste a sync code from another device')
  private readonly joinButton = el('button', 'grove-settings-button primary', 'Join')
  private readonly serverInput = input('https://grove-ui-sync.you.workers.dev')
  private readonly setupButton = el('button', 'grove-settings-button', 'Set up')
  private readonly error = el('div', 'grove-settings-error')
  // General.
  private readonly resume = toggle()
  private readonly unloadAfter = select(UNLOAD_CHOICES.map((m) => [String(m), m ? duration(m) : 'Never']))

  constructor(onClose: () => void) {
    this.onClose = onClose
    this.node.append(this.card)
    this.node.addEventListener('mousedown', (e) => {
      if (e.target === this.node) this.close()
    })
    this.node.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close()
    })

    const head = el('div', 'grove-settings-head')
    const close = el('button', 'grove-settings-close')
    close.title = 'Close'
    close.append(svg(closeSvg))
    close.addEventListener('click', () => this.close())
    head.append(el('span', 'grove-settings-title', 'Settings'), close)

    // ---- Sync ----
    const sync = section('Sync')
    const status = el('div', 'grove-sync-status')
    status.append(this.statusDot, this.statusText)
    sync.append(status)

    this.onPart.append(
      row('Server', this.server),
      row('Synced', this.counts),
      toggleRow(
        'Sync unpinned tabs',
        'Off: only workspaces, the Essentials, pins and pinned folders sync. This device’s other tabs stay here.',
        this.syncTabs,
        (on) => this.set({ syncTabs: on ? 'all' : 'pinned' })
      )
    )
    const codeRow = el('div', 'grove-settings-row column')
    const codeHead = el('div', 'grove-settings-row-head')
    const codeButtons = el('div', 'grove-settings-buttons')
    codeButtons.append(this.showButton, this.copyButton)
    codeHead.append(el('span', 'grove-settings-label', 'Sync code'), codeButtons)
    codeRow.append(
      codeHead,
      el('span', 'grove-settings-hint', 'Paste it into Grove’s settings on another device to sync it with this one. Keep it private: it opens everything Grove syncs.'),
      this.code
    )
    this.showButton.addEventListener('click', () => {
      this.showCode = !this.showCode
      this.paint()
    })
    this.copyButton.addEventListener('click', () => {
      const code = this.state?.sync.code
      if (!code) return
      void navigator.clipboard.writeText(code).then(() => {
        this.copied = true
        this.paint()
        setTimeout(() => {
          this.copied = false
          this.paint()
        }, 1500)
      })
    })
    const off = el('button', 'grove-settings-button danger', 'Turn off sync')
    off.addEventListener('click', () => {
      this.showCode = false
      send({ type: 'syncOff' })
    })
    const offRow = el('div', 'grove-settings-row end')
    offRow.append(off)
    this.onPart.append(codeRow, offRow)

    const intro = el(
      'p',
      'grove-settings-hint',
      'Sync your workspaces and tabs with Grove on your other devices. Everything is end-to-end encrypted: the server can’t read any of it.'
    )
    const join = el('form', 'grove-settings-inline')
    join.append(this.joinInput, this.joinButton)
    join.addEventListener('submit', (e) => {
      e.preventDefault()
      const code = this.joinInput.value.trim()
      if (code) send({ type: 'syncJoin', code })
    })
    const setup = el('form', 'grove-settings-inline')
    setup.append(this.serverInput, this.setupButton)
    setup.addEventListener('submit', (e) => {
      e.preventDefault()
      const server = this.serverInput.value.trim()
      if (server) send({ type: 'syncSetup', server })
    })
    this.offPart.append(
      intro,
      el('span', 'grove-settings-label', 'Join your other devices'),
      join,
      el('span', 'grove-settings-label', 'Or start syncing on your own sync server'),
      setup
    )
    sync.append(this.onPart, this.offPart, this.error)

    // ---- General ----
    const general = section('General')
    general.append(
      toggleRow(
        'Pick up where you left off',
        'When Grove starts, go to the workspace and tab you last used on another device.',
        this.resume,
        (on) => this.set({ resume: on })
      ),
      selectRow(
        'Unload inactive tabs',
        "Close the page of a tab you haven't looked at for this long, to free memory. Selecting it opens it again as it was. Tabs playing sound or holding something you typed stay.",
        this.unloadAfter,
        (v) => this.set({ unloadAfter: Number(v) })
      )
    )

    this.card.append(head, sync, general)
    // Keep "Synced 2 minutes ago" current.
    this.timer = setInterval(() => this.paint(), 20_000)
  }

  close(): void {
    clearInterval(this.timer)
    this.node.remove()
    this.onClose()
  }

  update(s: WindowState): void {
    this.state = s
    this.paint()
  }

  private set(settings: Partial<GroveSettings>): void {
    send({ type: 'setSettings', settings })
  }

  private paint(): void {
    const s = this.state
    if (!s) return
    const sync = s.sync
    const on = sync.state !== 'off'
    this.onPart.hidden = !on
    this.offPart.hidden = on
    this.statusDot.dataset.state = sync.busy ? 'connecting' : sync.state
    this.statusText.textContent = describe(sync)
    this.server.textContent = sync.server ? sync.server.replace(/^https?:\/\//, '') : ''
    const c = sync.counts
    this.counts.textContent = c
      ? `${plural(c.workspaces, 'workspace')} · ${plural(c.tabs, 'tab')}${c.folders ? ` · ${plural(c.folders, 'folder')}` : ''}`
      : ''
    this.syncTabs.checked = s.settings.syncTabs === 'all'
    this.resume.checked = s.settings.resume
    this.unloadAfter.value = String(s.settings.unloadAfter)
    this.code.textContent = sync.code ? (this.showCode ? sync.code : '•'.repeat(32)) : ''
    this.code.classList.toggle('masked', !this.showCode)
    this.showButton.textContent = this.showCode ? 'Hide' : 'Show'
    this.copyButton.textContent = this.copied ? 'Copied' : 'Copy'
    this.joinButton.disabled = this.setupButton.disabled = !!sync.busy
    this.joinButton.textContent = sync.busy === 'join' ? 'Joining…' : 'Join'
    this.setupButton.textContent = sync.busy === 'setup' ? 'Setting up…' : 'Set up'
    this.error.textContent = sync.error ?? ''
    this.error.hidden = !sync.error
    if (on) this.joinInput.value = ''
  }
}

function describe(sync: SyncStatus): string {
  if (sync.busy === 'join') return 'Joining…'
  if (sync.busy === 'setup') return 'Setting up…'
  switch (sync.state) {
    case 'off':
      return 'Off'
    case 'connecting':
      return 'Connecting…'
    case 'error':
      return 'The sync server turned this device away'
    case 'offline':
      return sync.pending ? `Offline · ${plural(sync.pending, 'change')} waiting to sync` : 'Offline · will sync when back'
    case 'online':
      if (sync.pending) return `Syncing ${plural(sync.pending, 'change')}…`
      return sync.lastSync ? `Synced ${ago(sync.lastSync)}` : 'Synced'
  }
}

function ago(t: number): string {
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`
  return new Date(t).toLocaleDateString()
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

function section(title: string): HTMLElement {
  const s = el('section', 'grove-settings-section')
  s.append(el('h3', 'grove-settings-section-title', title))
  return s
}

function row(label: string, value: HTMLElement): HTMLElement {
  const r = el('div', 'grove-settings-row')
  r.append(el('span', 'grove-settings-label', label), value)
  return r
}

function toggle(): HTMLInputElement {
  const t = document.createElement('input')
  t.type = 'checkbox'
  t.className = 'grove-toggle'
  return t
}

function toggleRow(label: string, hint: string, t: HTMLInputElement, change: (on: boolean) => void): HTMLElement {
  const r = el('label', 'grove-settings-row')
  const text = el('div', 'grove-settings-text')
  text.append(el('span', 'grove-settings-label', label), el('span', 'grove-settings-hint', hint))
  t.addEventListener('change', () => change(t.checked))
  r.append(text, t)
  return r
}

function select(options: [value: string, label: string][]): HTMLSelectElement {
  const s = el('select', 'grove-select')
  for (const [value, label] of options) {
    const o = el('option', '', label)
    o.value = value
    s.append(o)
  }
  return s
}

function selectRow(label: string, hint: string, s: HTMLSelectElement, change: (value: string) => void): HTMLElement {
  const r = el('div', 'grove-settings-row')
  const text = el('div', 'grove-settings-text')
  text.append(el('span', 'grove-settings-label', label), el('span', 'grove-settings-hint', hint))
  s.addEventListener('change', () => change(s.value))
  r.append(text, s)
  return r
}

const duration = (minutes: number): string =>
  minutes < 60 ? `After ${minutes} minutes` : `After ${plural(minutes / 60, 'hour')}`

function input(placeholder: string): HTMLInputElement {
  const i = document.createElement('input')
  i.className = 'grove-settings-input'
  i.placeholder = placeholder
  i.spellcheck = false
  i.autocomplete = 'off'
  return i
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}
