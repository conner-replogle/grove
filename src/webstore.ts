// "Add to Grove" on a Chrome Web Store extension page. The store's own
// button can't install anything here (host/webstore.ts says why), and no
// extension may run on the store's pages, so the window draws its own: a
// button in the corner of the page, then what the extension can do, to
// confirm. The host downloads, checks and installs it (host/extensions.ts).
import checkSvg from 'lucide-static/icons/check.svg'
import puzzleSvg from 'lucide-static/icons/puzzle.svg'
import type { StoreOffer } from '../shared/protocol.ts'
import { send, subscribe } from './host-client'
import { svg } from './svg'

export function showStoreOffers(main: () => HTMLElement | null): void {
  let node: HTMLElement | undefined
  let shown = ''
  let latest: StoreOffer | undefined
  const render = (): void => {
    const host = main()
    const offer = latest
    const key = offer ? JSON.stringify(offer) : ''
    if (!offer || !host) {
      node?.remove()
      node = undefined
      shown = ''
      if (offer && !host) requestAnimationFrame(render)
      return
    }
    if (node?.isConnected && key === shown) return
    node?.remove()
    shown = key
    node = view(offer)
    host.append(node)
  }
  subscribe((s) => {
    latest = s.store
    render()
  })
}

function view(o: StoreOffer): HTMLElement {
  if (o.state === 'confirm') return confirmCard(o)
  if (o.state === 'error') {
    const card = el('div', 'grove-store-card')
    card.append(
      el('div', 'grove-store-title', 'Couldn’t add this extension'),
      el('div', 'grove-store-error', o.error ?? ''),
      buttons([
        ['Close', 'quiet', () => send({ type: 'storeCancel', id: o.id })],
        ['Try again', 'primary', () => send({ type: 'storeInspect', id: o.id })]
      ])
    )
    return card
  }
  const pill = el('div', 'grove-store-pill')
  const main = el('button', 'grove-store-main')
  if (o.state === 'removed') {
    main.append(svg(checkSvg), el('span', '', 'Removed'))
    main.disabled = true
    pill.append(main)
    return pill
  }
  if (o.state === 'installed') {
    main.append(svg(checkSvg), el('span', '', o.managed ? 'In Grove' : 'Installed'))
    main.disabled = true
    pill.append(main)
    if (o.managed) {
      const remove = el('button', 'grove-store-remove', 'Remove')
      remove.addEventListener('click', () => send({ type: 'storeRemove', id: o.id }))
      pill.append(remove)
    }
    return pill
  }
  const busy = o.state === 'checking' || o.state === 'installing'
  main.append(svg(puzzleSvg), el('span', '', o.state === 'checking' ? 'Getting it…' : busy ? 'Adding…' : 'Add to Grove'))
  main.disabled = busy
  main.classList.toggle('busy', busy)
  main.addEventListener('click', () => send({ type: 'storeInspect', id: o.id }))
  pill.append(main)
  return pill
}

function confirmCard(o: StoreOffer): HTMLElement {
  const card = el('div', 'grove-store-card')
  card.setAttribute('role', 'dialog')
  const head = el('div', 'grove-store-head')
  if (o.icon) {
    const img = el('img', 'grove-store-icon')
    img.src = o.icon
    img.alt = ''
    head.append(img)
  } else {
    const i = el('span', 'grove-store-icon')
    i.append(svg(puzzleSvg))
    head.append(i)
  }
  const title = el('div', 'grove-store-title', `Add “${o.name ?? o.id}”?`)
  head.append(title)
  card.append(head)
  const warnings = o.warnings ?? []
  if (warnings.length) {
    card.append(el('div', 'grove-store-can', 'It can:'))
    const list = el('ul', 'grove-store-list')
    for (const w of warnings) list.append(el('li', '', w))
    card.append(list)
  } else {
    card.append(el('div', 'grove-store-can', 'It needs no special permissions.'))
  }
  card.append(
    buttons([
      ['Cancel', 'quiet', () => send({ type: 'storeCancel', id: o.id })],
      ['Add extension', 'primary', () => send({ type: 'storeInstall', id: o.id })]
    ])
  )
  return card
}

function buttons(list: [label: string, kind: string, click: () => void][]): HTMLElement {
  const row = el('div', 'grove-store-buttons')
  for (const [label, kind, click] of list) {
    const b = el('button', kind, label)
    b.addEventListener('click', click)
    row.append(b)
  }
  return row
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}
