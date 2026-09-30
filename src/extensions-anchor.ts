// Chrome opens the extensions menu as a native bubble right-aligned to the
// extensions button: it assumes the button sits at the top-right of a
// toolbar. In Grove's sidebar that pushes the bubble off the window's left
// edge. So Chrome is shown a stand-in anchor instead: invisible, starting
// at the button and reaching right over the page, which puts the bubble
// just below the button, opening rightward.
interface Tracker {
  startTracking(element: Element, nativeId: string, options?: { secondaryId?: string }): void
  stopTracking(element: Element): void
}
const TRACKER_MODULE = '//resources/js/tracked_element/tracked_element_manager.js'

const ANCHOR_ID = 'kExtensionsMenuButtonElementId'
// About the bubble's width, so its left edge lands near the button's.
const REACH = 400

export async function anchorExtensionsMenu(button: HTMLElement): Promise<void> {
  const { TrackedElementManager } = await import(/* @vite-ignore */ TRACKER_MODULE)
  const tracker: Tracker = TrackedElementManager.getInstance()
  const anchor = document.createElement('div')
  anchor.style.cssText = 'position:fixed;pointer-events:none;visibility:visible;z-index:-1'
  document.body.append(anchor)

  // Chrome reads the anchor's bounds when they're reported, so place it and
  // report it again right before each press.
  const place = (): void => {
    const r = button.getBoundingClientRect()
    const width = Math.max(r.width, Math.min(REACH, innerWidth - r.left - 8))
    anchor.style.left = `${r.left}px`
    anchor.style.top = `${r.top}px`
    anchor.style.width = `${width}px`
    anchor.style.height = `${r.height}px`
    tracker.stopTracking(button)
    tracker.startTracking(anchor, ANCHOR_ID, { secondaryId: 'ext:' })
  }
  button.addEventListener('pointerdown', place, true)
  button.addEventListener('keydown', place, true)
  place()
}
