// Grove's permission prompt. Chrome's own is a native bubble, which a
// Webium window can't show; instead the page's request comes through the
// host (see extension/permissions-main.js), and this window shows it when
// the page asking is the one on screen. Allow and Block are kept as
// Chrome's site settings; closing the prompt decides nothing.
import type { PermissionDecision, PermissionKind, PermissionRequest } from '../shared/protocol.ts'
import { send, subscribe } from './host-client'
import { icons } from './icons'
import { svg } from './svg'

const WHAT: Record<PermissionKind, [icon: string, label: string]> = {
  notifications: [icons.bell, 'Show notifications'],
  geolocation: [icons.mapPin, 'Know your location'],
  camera: [icons.camera, 'Use your camera'],
  cameraPanTiltZoom: [icons.move, 'Move your camera'],
  microphone: [icons.mic, 'Use your microphone'],
  clipboard: [icons.clipboardPaste, 'See text and images you copy'],
  midi: [icons.music, 'Use your MIDI devices'],
  midiSysex: [icons.keyboardMusic, 'Control and reprogram your MIDI devices'],
  idleDetection: [icons.userCheck, 'Know when you’re actively using this device'],
  windowManagement: [icons.appWindow, 'Manage windows on all your displays'],
  localFonts: [icons.type, 'Use the fonts on your computer'],
  storageAccess: [icons.cookie, 'Use cookies and site data'],
  localNetwork: [icons.network, 'Find and connect to devices on your local network']
}

const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

export function showPermissionPrompts(main: () => HTMLElement | null): void {
  let card: HTMLElement | undefined
  let shown: string | undefined
  let latest: PermissionRequest | undefined
  let retrying = false

  const render = (): void => {
    const request = latest
    const host = main()
    if (request && !host) {
      // The window's UI is still being built (it was just opened or reloaded).
      if (!retrying) {
        retrying = true
        requestAnimationFrame(() => {
          retrying = false
          render()
        })
      }
      return
    }
    if (!request || !host) {
      card?.remove()
      card = shown = undefined
      return
    }
    if (card?.isConnected && shown === request.id) return
    card?.remove()
    shown = request.id
    card = prompt(request)
    host.append(card)
  }
  subscribe((s) => {
    latest = s.permission
    render()
  })
}

function prompt(request: PermissionRequest): HTMLElement {
  const answer = (decision: PermissionDecision): void => send({ type: 'answerPermission', id: request.id, decision })

  const card = el('div', 'grove-permission')
  card.setAttribute('role', 'dialog')
  const head = el('div', 'grove-permission-head')
  head.append(el('span', 'grove-permission-site', hostOf(request.origin)), el('span', 'grove-permission-wants', ' wants to'))
  const close = el('button', 'grove-permission-close')
  close.title = 'Not now'
  close.append(svg(icons.x))
  close.addEventListener('click', () => answer('dismiss'))
  head.append(close)

  const list = el('div', 'grove-permission-list')
  for (const kind of request.kinds) {
    const [icon, what] = WHAT[kind]
    // Storage access is an embedded site asking about the page it's on.
    const label = kind === 'storageAccess' && request.topOrigin ? `${what} on ${hostOf(request.topOrigin)}` : what
    const row = el('div', 'grove-permission-row')
    const i = el('span', 'grove-permission-icon')
    i.append(svg(icon))
    row.append(i, el('span', '', label))
    list.append(row)
  }

  const buttons = el('div', 'grove-permission-buttons')
  const block = el('button', 'grove-permission-block', 'Block')
  block.addEventListener('click', () => answer('block'))
  const allow = el('button', 'grove-permission-allow', 'Allow')
  allow.addEventListener('click', () => answer('allow'))
  buttons.append(block, allow)

  card.append(head, list, buttons)
  return card
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}
