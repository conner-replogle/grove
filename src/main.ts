// Grove's UI, injected into Chromium's WebUI browser (chrome://webui-browser)
// before its own scripts run. It restyles and extends Webium's components;
// the tabs underneath are real Chrome tabs.
import appCss from './styles/app.css'
import zenTokens from './zen/tokens.css'
import searchboxCss from './styles/searchbox.css'
import { addStyles, patchMethod } from './patch'
import { anchorExtensionsMenu } from './extensions-anchor'
import { sidebarResizer } from './resize'
import './sidebar'

declare global {
  interface Window {
    __grove?: { version: number }
  }
}

if (!window.__grove) {
  window.__grove = { version: 1 }

  addStyles('webui-browser-app', zenTokens + appCss)
  addStyles('webui-browser-searchbox', searchboxCss)

  // Grove's sidebar takes the tab strip's place. Webium's strip stays in
  // the page (hidden) because the app listens to its tab events.
  keepSidebarMounted()

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
    const box = root.querySelector('#addressBox')
    const extensions = root.querySelector('#extensionsBar')
    if (box && extensions && extensions.parentNode !== box) box.append(extensions)
    const menuButton = extensions?.shadowRoot?.querySelector<HTMLElement>('#extensionsMenuButton')
    if (menuButton && !anchored.has(menuButton)) {
      anchored.add(menuButton)
      void anchorExtensionsMenu(menuButton)
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
