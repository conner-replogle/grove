// Grove's UI, injected into Chromium's WebUI browser (chrome://webui-browser)
// before its own scripts run. It restyles and extends Webium's components;
// the tabs underneath are real Chrome tabs.
import appCss from './styles/app.css'
import tabCss from './styles/tab.css'
import tabStripCss from './styles/tab-strip.css'
import { addStyles, patchMethod } from './patch'

declare global {
  interface Window {
    __grove?: { version: number }
  }
}

if (!window.__grove) {
  window.__grove = { version: 1 }

  addStyles('webui-browser-app', appCss)
  addStyles('webui-browser-tab-strip', tabStripCss)
  addStyles('webui-browser-tab', tabCss)

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
