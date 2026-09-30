// The paused page: when another window takes this window's page (both
// show the same workspace, and a page lives in one window at a time), this
// window keeps the entry selected and shows it greyed out, from a snapshot
// of how it last looked here, until it's clicked back.
import type { WindowState } from '../shared/protocol.ts'
import { send, subscribe } from './host-client'

export function showPausedPages(main: () => HTMLElement | null): void {
  let overlay: HTMLElement | undefined
  let shown: WindowState['paused']

  subscribe((s) => {
    const paused = s.paused
    const host = main()
    if (!paused || !host) {
      overlay?.remove()
      overlay = undefined
      shown = undefined
      return
    }
    if (overlay?.isConnected && shown?.entryId === paused.entryId && shown.snapshot === paused.snapshot) {
      overlay.querySelector('.grove-paused-title')!.textContent = paused.title
      return
    }
    shown = paused
    overlay?.remove()
    overlay = document.createElement('div')
    overlay.className = 'grove-paused'
    if (paused.snapshot) overlay.style.backgroundImage = `url("${paused.snapshot}")`
    const card = document.createElement('div')
    card.className = 'grove-paused-card'
    const title = document.createElement('div')
    title.className = 'grove-paused-title'
    title.textContent = paused.title
    const note = document.createElement('div')
    note.className = 'grove-paused-note'
    note.textContent = 'Open in another window'
    const button = document.createElement('button')
    button.className = 'grove-paused-button'
    button.textContent = 'Show here'
    card.append(title, note, button)
    overlay.append(card)
    const entryId = paused.entryId
    overlay.addEventListener('click', () => send({ type: 'activate', entryId }))
    host.append(overlay)
  })
}
