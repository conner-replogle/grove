// A new page's first moments. Webium shows a tab's page by embedding its
// surface into the window, and until the page draws for the first time
// that surface is empty: nothing at all is drawn there, not even the page
// card's background behind it, so the desktop shows through the window
// (a new tab, a tab reopened after being unloaded, a restored workspace).
// Grove covers the page with the card's own background until the host
// says the page has drawn (EntryView.painted).
import type { EntryView, WindowState } from '../shared/protocol.ts'
import { subscribe } from './host-client'

export function coverUnpaintedPages(main: () => HTMLElement | null): void {
  let cover: HTMLElement | undefined
  subscribe((s) => {
    const host = main()
    const show = !!host && needsCover(s)
    if (!show) {
      cover?.remove()
      cover = undefined
      return
    }
    if (!cover) {
      cover = document.createElement('div')
      cover.className = 'grove-cover'
    }
    if (cover.parentNode !== host) host.append(cover)
  })
}

// The window's page hasn't drawn yet: it's still being made or reopened
// here. (A page shown in another window is paused here instead.)
export function needsCover(s: WindowState): boolean {
  // A split's panes are each their own page; one cover would hide them all.
  if (s.paused || !s.activeEntryId || s.split) return false
  const entry: EntryView | undefined = [...s.essentials, ...s.workspace.entries].find((e) => e.id === s.activeEntryId)
  if (!entry) return false
  if (!entry.live) return true
  return entry.here && !entry.painted
}
