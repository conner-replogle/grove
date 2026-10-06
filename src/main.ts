// Grove's UI, injected into Chromium's WebUI browser (chrome://webui-browser)
// before its own scripts run. It restyles and extends Webium's components;
// the tabs underneath are real Chrome tabs.
import appCss from './styles/app.css'
import panelsCss from './styles/panels.css'
import zenTokens from './zen/tokens.css'
import searchboxCss from './styles/searchbox.css'
import urlbarResultsCss from './zen/urlbar-results.css'
import { addStyles, patchMethod } from './patch'
import { showDomainOnly } from './address'
import { anchorExtensionsBar } from './extensions-anchor'
import { showDownloads } from './downloads'
import { coverUnpaintedPages } from './loading-cover'
import { showPausedPages } from './paused'
import { showPermissionPrompts } from './permission-prompt'
import { sidebarResizer } from './resize'
import { showSettings } from './settings'
import { suggestFromHistory } from './suggestions'
import { openUrlBarOnNewTab, releasePageFocus, watchUrlBarPlace } from './urlbar'
import './sidebar'

declare global {
  interface Window {
    __grove?: { version: number }
  }
}

if (!window.__grove) {
  window.__grove = { version: 1 }

  addStyles('webui-browser-app', zenTokens + appCss + panelsCss)
  addStyles('webui-browser-searchbox', searchboxCss)
  addStyles('cr-searchbox-match', urlbarResultsCss)
  showDomainOnly()
  closeUrlBarAfterUse()
  openUrlBarOnNewTab()
  suggestFromHistory()

  // Grove's sidebar takes the tab strip's place. Webium's strip stays in
  // the page (hidden) because the app listens to its tab events.
  keepSidebarMounted()
  const main = (): HTMLElement | null =>
    document.querySelector('webui-browser-app')?.shadowRoot?.querySelector<HTMLElement>('#main') ?? null
  coverUnpaintedPages(main)
  showPausedPages(main)
  showPermissionPrompts(main)
  showDownloads(main)
  showSettings(main)

  // Webium routes every mousedown in the tab strip into its drag code,
  // which assumes a horizontal strip (and, fed vertical positions, can ask
  // the browser to move a tab it can't find, which is a CHECK failure).
  // Grove's sidebar is vertical: a press on a tab just activates it.
  interface TabStrip {
    activateTab(id: string): void
  }
  interface TabEl extends Element {
    tabData: { id: string }
  }
  patchMethod('webui-browser-tab-strip', 'dragMouseDown', function (this: void, _orig, ...args: unknown[]) {
    const e = args[0] as MouseEvent
    if (e.button !== 0) return
    const tab = e
      .composedPath()
      .find((n): n is TabEl => n instanceof Element && n.tagName === 'WEBUI-BROWSER-TAB')
    const strip = e
      .composedPath()
      .find((n) => n instanceof Element && n.tagName === 'WEBUI-BROWSER-TAB-STRIP') as unknown as TabStrip
    if (tab && strip) strip.activateTab(tab.tabData.id)
  })
}

// Puts <grove-sidebar> in the tab strip's slot, and the sidebar's resize
// handle in the window's grid, as soon as Webium's app has rendered them,
// and again if a re-render ever drops them.
function keepSidebarMounted(): void {
  let resizer: HTMLElement | undefined
  const anchored = new WeakSet<Element>()
  const mount = (): boolean => {
    const app = document.querySelector<HTMLElement>('webui-browser-app')
    const root = app?.shadowRoot
    const slot = root?.querySelector('.tabstripDiv')
    const grid = root?.querySelector('#rootContainer')
    if (!app || !root || !slot || !grid) return false
    if (!slot.querySelector('grove-sidebar')) slot.append(document.createElement('grove-sidebar'))
    resizer ??= sidebarResizer(app)
    if (resizer.parentNode !== grid) grid.append(resizer)
    // The extensions button lives inside the URL bar, as in Zen.
    const box = root.querySelector<HTMLElement>('#addressBox')
    if (box && !anchored.has(box)) {
      anchored.add(box)
      watchUrlBarPlace(box)
    }
    const extensions = root.querySelector('#extensionsBar')
    if (box && extensions && extensions.parentNode !== box) box.append(extensions)
    if (extensions?.shadowRoot?.querySelector('#extensionsMenuButton') && !anchored.has(extensions)) {
      anchored.add(extensions)
      void anchorExtensionsBar(extensions)
    }
    return true
  }
  const wait = (): void => {
    if (!mount()) {
      requestAnimationFrame(wait)
      return
    }
    const root = document.querySelector('webui-browser-app')!.shadowRoot!
    new MutationObserver(() => mount()).observe(root, { childList: true, subtree: true })
  }
  wait()
}

// The floating URL bar closes once it has done its job: Enter, a click on
// a suggestion, or Escape. (Webium keeps the field focused after it
// navigates, which would leave the panel open over the page.)
function closeUrlBarAfterUse(): void {
  const inUrlBar = (e: Event): boolean =>
    e.composedPath().some((n) => n instanceof Element && n.tagName === 'WEBUI-BROWSER-SEARCHBOX')
  const close = (): void => {
    let el: Element | null = document.activeElement
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement
    if (el instanceof HTMLElement) el.blur()
    releasePageFocus()
  }
  document.addEventListener('keydown', (e) => {
    if (!inUrlBar(e) || e.isComposing) return
    if (e.key === 'Enter' || e.key === 'Escape') setTimeout(close, 0)
  })
  document.addEventListener('click', (e) => {
    if (inUrlBar(e) && e.composedPath().some((n) => n instanceof Element && n.tagName === 'CR-SEARCHBOX-MATCH')) {
      setTimeout(close, 0)
    }
  })
}
