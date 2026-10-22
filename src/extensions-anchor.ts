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
export const POPUP_REACH = 620

let trackerLoad: Promise<Tracker> | undefined
const tracker = (): Promise<Tracker> =>
  (trackerLoad ??= import(/* @vite-ignore */ TRACKER_MODULE).then((m) => m.TrackedElementManager.getInstance()))
const anchors = new Map<string, HTMLElement>()

// Shows Chrome where to open the native bubble it anchors to `nativeId`
// (and `secondaryId`): at `button`, reaching `reach` px right of its left
// edge (0: just the button), instead of `replaces`, the element Chrome's
// own UI tracks for it. Call right before the press that opens it.
export async function anchorAt(
  button: HTMLElement,
  nativeId: string,
  secondaryId?: string,
  reach = 0,
  replaces?: Element
): Promise<void> {
  const t = await tracker()
  if (replaces) t.stopTracking(replaces)
  const key = `${nativeId} ${secondaryId ?? ''}`
  let anchor = anchors.get(key)
  if (!anchor) {
    anchor = document.createElement('div')
    anchor.style.cssText = 'position:fixed;pointer-events:none;visibility:visible;z-index:-1'
    anchors.set(key, anchor)
  }
  if (!anchor.isConnected) document.body.append(anchor)
  const r = button.getBoundingClientRect()
  const width = Math.max(r.width, Math.min(reach, innerWidth - r.left - 8))
  anchor.style.left = `${r.left}px`
  anchor.style.top = `${r.top}px`
  anchor.style.width = `${width}px`
  anchor.style.height = `${r.height}px`
  t.stopTracking(anchor)
  t.startTracking(anchor, nativeId, secondaryId === undefined ? undefined : { secondaryId })
}

// Pinned extension buttons (webui-browser-extension) track themselves as
// kToolbarActionViewElementId / "ext:<id>"; the menu button as
// kExtensionsMenuButtonElementId / "ext:".
export async function anchorExtensionsBar(bar: Element): Promise<void> {
  const root = bar.shadowRoot
  if (!root) return
  const place = (button: HTMLElement, nativeId: string, secondaryId: string, reach: number): void =>
    void anchorAt(button, nativeId, secondaryId, reach, button)

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
