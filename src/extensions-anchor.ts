// Chrome opens the extensions menu and extension popups as native bubbles
// right-aligned to the button that opened them: it assumes the button sits
// at the top-right of a toolbar. In Grove's sidebar that pushes the bubble
// off the window's left edge, where it gets clipped. So Chrome is shown a
// stand-in anchor instead: invisible, starting at the button and reaching
// right over the page, which puts the bubble just below the button,
// opening rightward.
interface Tracker {
  startTracking(element: Element, nativeId: string, options?: { secondaryId?: string }): void
  stopTracking(element: Element): void
}
const TRACKER_MODULE = '//resources/js/tracked_element/tracked_element_manager.js'

// About each bubble's width, so its left edge lands near the button's.
const MENU_REACH = 400
// Extension popups can be up to 800px wide; 1Password's two-pane popup is
// 600px, plus the bubble's border.
const POPUP_REACH = 620

// Pinned extension buttons (webui-browser-extension) track themselves as
// kToolbarActionViewElementId / "ext:<id>"; the menu button as
// kExtensionsMenuButtonElementId / "ext:".
export async function anchorExtensionsBar(bar: Element): Promise<void> {
  const root = bar.shadowRoot
  if (!root) return
  const { TrackedElementManager } = await import(/* @vite-ignore */ TRACKER_MODULE)
  const tracker: Tracker = TrackedElementManager.getInstance()
  const anchors = new Map<string, HTMLElement>()

  // Chrome reads an anchor's bounds when they're reported, so place it and
  // report it again right before each press.
  const place = (button: HTMLElement, nativeId: string, secondaryId: string, reach: number): void => {
    let anchor = anchors.get(secondaryId)
    if (!anchor) {
      anchor = document.createElement('div')
      anchor.style.cssText = 'position:fixed;pointer-events:none;visibility:visible;z-index:-1'
      anchors.set(secondaryId, anchor)
    }
    if (!anchor.isConnected) document.body.append(anchor)
    const r = button.getBoundingClientRect()
    const width = Math.max(r.width, Math.min(reach, innerWidth - r.left - 8))
    anchor.style.left = `${r.left}px`
    anchor.style.top = `${r.top}px`
    anchor.style.width = `${width}px`
    anchor.style.height = `${r.height}px`
    tracker.stopTracking(button)
    tracker.stopTracking(anchor)
    tracker.startTracking(anchor, nativeId, { secondaryId })
  }

  const onPress = (e: Event): void => {
    for (const node of e.composedPath()) {
      if (!(node instanceof HTMLElement)) continue
      if (node.id === 'extensionsMenuButton') {
        place(node, 'kExtensionsMenuButtonElementId', 'ext:', MENU_REACH)
        return
      }
      if (node.tagName === 'WEBUI-BROWSER-EXTENSION') {
        const id = (node as HTMLElement & { extensionId?: string }).extensionId
        if (id) place(node, 'kToolbarActionViewElementId', `ext:${id}`, POPUP_REACH)
        return
      }
    }
  }
  root.addEventListener('pointerdown', onPress, true)
  root.addEventListener('keydown', onPress, true)
  const menuButton = root.querySelector<HTMLElement>('#extensionsMenuButton')
  if (menuButton) place(menuButton, 'kExtensionsMenuButtonElementId', 'ext:', MENU_REACH)
}
