// Opening the URL bar for a new tab, as Zen does.
//
// New Tab (the sidebar row, or Ctrl+T via the host) makes no tab: it opens
// the URL bar centered and empty, and the result picked there opens in a
// new tab. Only a window with nothing to show gets a real New Tab page,
// and its URL bar opens over it.
//
// Focusing the field isn't enough on its own. When a tab becomes active,
// Webium focuses the <embed> that shows its page, which gives that page the
// keyboard at the browser level; focusing an element of the window's UI
// afterwards doesn't take it back, so typing would go to the page. So for a
// New Tab page the <embed> isn't focused; the URL bar is, and the page gets
// the keyboard once the URL bar closes.
//
// Once open, the URL bar keeps the keyboard until it's done with (Enter,
// Escape, a suggestion) or the user clicks elsewhere. Webium focuses the
// active tab's <embed> when a tab activates or its page is swapped, which
// can happen at any time (another window, sync, Organize); while the bar is
// open those don't happen, and if the field loses focus some other way it
// gets it back with what was typed.
import { addressText, keepEditsWhile, onAddressSet, setOwnText } from './address'
import { onFocusUrlBar, onOpenNewTabSearch, send } from './host-client'

let holding = false
// The URL bar is open: its field got focus and the user isn't done with it.
let open = false
// What the field held when it last lost focus, to put back.
let typed: { value: string; start: number; end: number } | undefined
// Webium's own <embed> focus, which the override below stands in front of.
let focusEmbed: HTMLElement['focus'] = HTMLEmbedElement.prototype.focus
let released: ReturnType<typeof setTimeout> | undefined
let retries: ReturnType<typeof setTimeout>[] = []

function stopRetries(): void {
  retries.forEach(clearTimeout)
  retries = []
}

// A new tab's search is open: what it opens goes to a new tab. The field
// starts empty; if the search closes without opening anything, it gets
// back the page's address it had.
let searchingForNewTab = false
let addressBefore = ''
// Nothing typed in the new tab's search yet.
let searchUntouched = false
// Told how the new tab's search ended: whether it opened a tab.
let onSearchEnd: ((opened: boolean) => void) | undefined

type SearchboxField = Element & { setInputText?(t: string): void }
const searchboxField = (): SearchboxField | null =>
  document.querySelector('webui-browser-app')?.shadowRoot?.querySelector('#address') ?? null
const setFieldText = (text: string): void => setOwnText(() => searchboxField()?.setInputText?.(text))

// The user has typed in the URL bar since it opened.
let edited = false

// Webium's searchbox (cr-searchbox), as suggestions.ts and Enter use it.
export interface Searchbox extends HTMLElement {
  getInputElement(): { inputElement: HTMLInputElement }
  result: { queryId: number; matches: unknown[] } | null
  activeQueryId: number
}
export const searchbox = (): Searchbox | null => searchboxField() as Searchbox | null

// Whether the URL bar is open as a new tab's search.
export function isNewTabSearch(): boolean {
  return searchingForNewTab
}

export function openNewTabSearch(onEnd?: (opened: boolean) => void): void {
  if (!searchingForNewTab) addressBefore = addressText()
  onSearchEnd = onEnd
  searchingForNewTab = true
  searchUntouched = true
  setCentered(true)
  focusField()
  setFieldText('')
  // Ctrl+T comes from the keyboard: Chrome's keyboard focus may be on a page.
  stopRetries()
  retries = [0, 120, 400].map((delay) => setTimeout(claimKeyboard, delay))
}

function endNewTabSearch(opened = false): void {
  if (!searchingForNewTab) return
  searchingForNewTab = false
  if (!opened) setFieldText(addressBefore)
  const end = onSearchEnd
  onSearchEnd = undefined
  end?.(opened)
}

export function openUrlBarOnNewTab(): void {
  // Webium focuses a tab's <embed> when the tab becomes active. For a New
  // Tab page (however it opened: the button, Ctrl+T, or switching to a
  // blank tab) the URL bar gets the keyboard instead.
  focusEmbed = HTMLEmbedElement.prototype.focus
  HTMLEmbedElement.prototype.focus = function (this: HTMLEmbedElement, options?: FocusOptions) {
    if (holding || open) return
    if (showsNewTabPage(this)) {
      openForNewTab()
      return
    }
    focusEmbed.call(this, options)
  }

  // Ctrl+T: the host switches back to the page the window showed after the
  // search opens, and Chrome then puts that page's address in the field.
  // Until something is typed, the search stays empty.
  onAddressSet((_, text) => {
    // The page's address now, for the field once the search is done with.
    if (searchingForNewTab && text) addressBefore = text
    if (searchingForNewTab && searchUntouched && text) setTimeout(() => setFieldText(''), 0)
  })
  // What the user types stays while the page navigates (a redirect, a page
  // still loading): the page's address waits until the URL bar closes.
  keepEditsWhile(() => (searchingForNewTab ? !searchUntouched : open && edited))
  document.addEventListener(
    'input',
    (e) => {
      if (inSearchbox(e)) edited = true
    },
    true
  )
  onFocusUrlBar(openForNewTab)
  onOpenNewTabSearch(() => openNewTabSearch())
  openInNewTabWhileSearching()
  enterWaitsForResults()
  document.addEventListener(
    'keydown',
    (e) => {
      if (!inSearchbox(e)) return
      stopRetries()
      searchUntouched = false
    },
    true
  )

  // A click anywhere but the URL bar closes it: the page gets the keyboard.
  // (A click on the page itself never reaches this document: see
  // watchUrlBarPlace.)
  document.addEventListener(
    'pointerdown',
    (e) => {
      // A suggestion picked is the URL bar done with too (closeUrlBarAfterUse
      // closes it), so the field isn't focused again as the page loads.
      if (e.composedPath().some((n) => n instanceof Element && n.tagName === 'CR-SEARCHBOX-MATCH')) open = false
      if (inSearchbox(e)) return
      open = false
      if (holding) setTimeout(releasePageFocus, 0)
    },
    true
  )
}

function openForNewTab(): void {
  hold()
  setCentered(true)
  // Webium attaches the new page a moment after the tab activates, which
  // can take focus back; focus the field again then, until the user starts
  // typing or the bar closes.
  stopRetries()
  retries = [0, 120, 400].map((delay) =>
    setTimeout(() => {
      focusField()
      claimKeyboard()
    }, delay)
  )
}

// Focusing the field doesn't move Chrome's keyboard focus off a page; a
// click does. Asks the host to click the (empty) field, at its far end.
function claimKeyboard(): void {
  const input = fieldInput()
  if (!input || input.value) return
  const r = input.getBoundingClientRect()
  if (!r.width || !r.height) return
  send({ type: 'claimKeyboard', x: Math.round(r.left + r.width * 0.9), y: Math.round(r.top + r.height / 2) })
}

// Whether an <embed> shows a New Tab page: its cr-tab-webview's tab, looked
// up in Webium's (hidden) tab strip.
function showsNewTabPage(embed: HTMLEmbedElement): boolean {
  const view = (embed.getRootNode() as ShadowRoot).host as (Element & { tabId?: string }) | undefined
  if (view?.tagName !== 'CR-TAB-WEBVIEW' || !view.tabId) return false
  const strip = document.querySelector('webui-browser-app')?.shadowRoot?.querySelector('webui-browser-tab-strip')
  for (const tab of strip?.shadowRoot?.querySelectorAll('webui-browser-tab') ?? []) {
    const data = (tab as Element & { tabData?: { id: string; url: string } }).tabData
    if (data?.id === view.tabId) return /^chrome:\/\/(newtab|new-tab-page)\/?$/.test(data.url)
  }
  return false
}

// The URL bar is done (Enter, Escape, a suggestion, a click elsewhere):
// give the page the keyboard, if a new tab's URL bar was holding it.
// Only these end the hold: the field also loses focus for a moment while
// Webium switches to the new tab.
export function releasePageFocus(): void {
  open = false
  stopRetries()
  setCentered(false)
  endNewTabSearch()
  if (!holding) return
  holding = false
  const embed = activeEmbed()
  if (embed) focusEmbed.call(embed)
}

// Focuses the URL bar as Ctrl+L does, unless it already has focus
// (focusing selects its text, which the next key typed would replace).
function focusField(): void {
  if (searchboxFocused()) return
  const app = document.querySelector('webui-browser-app') as (Element & { setFocusToLocationBar?(user: boolean): void }) | null
  app?.setFocusToLocationBar?.(true)
}

function hold(): void {
  holding = true
  // Never hold the page's focus for long if the URL bar never opened.
  clearTimeout(released)
  released = setTimeout(() => {
    if (!searchboxFocused()) holding = false
  }, 2000)
}

function inSearchbox(e: Event): boolean {
  return e.composedPath().some((n) => n instanceof Element && n.tagName === 'WEBUI-BROWSER-SEARCHBOX')
}

// The field's <input>, inside the searchbox's shadow roots.
function fieldInput(): HTMLInputElement | null {
  const field = searchboxField() as (SearchboxField & { getInputElement?(): { inputElement?: HTMLInputElement } }) | null
  return field?.getInputElement?.()?.inputElement ?? null
}

// The element that has focus, down through shadow roots.
function deepActiveElement(): Element | null {
  let el: Element | null = document.activeElement
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement
  return el
}

// Gives the open URL bar its focus back, with what was typed in it and
// where the caret was (Webium's focus would select it all).
function refocus(): void {
  const input = fieldInput()
  if (!input) return
  input.focus({ preventScroll: true })
  if (!typed) return
  if (input.value !== typed.value) {
    input.value = typed.value
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  }
  input.setSelectionRange(typed.start, typed.end)
}

function searchboxFocused(): boolean {
  return !!document.querySelector('webui-browser-app')?.shadowRoot?.querySelector('#address')?.matches(':focus-within')
}

// The <embed> of the active tab's page.
function activeEmbed(): HTMLElement | undefined {
  let found: HTMLElement | undefined
  const walk = (root: ParentNode): void => {
    for (const el of root.querySelectorAll('*')) {
      if (found) return
      if (el.tagName === 'CR-TAB-WEBVIEW' && el.classList.contains('active')) {
        found = el.shadowRoot?.querySelector<HTMLElement>('.content') ?? undefined
      } else if (el.shadowRoot) walk(el.shadowRoot)
    }
  }
  const app = document.querySelector('webui-browser-app')?.shadowRoot
  if (app) walk(app)
  return found
}

// Where the floating URL bar opens (app.css): centered over the window for
// a new tab, else in place, grown from the sidebar's URL bar. The sidebar
// bar's position is kept on the app as --grove-urlbar-{top,left,width},
// measured whenever it moves while it isn't floating.
function setCentered(on: boolean): void {
  document.querySelector('webui-browser-app')?.classList.toggle('grove-urlbar-center', on)
}

export function watchUrlBarPlace(box: HTMLElement): void {
  const app = document.querySelector<HTMLElement>('webui-browser-app')
  if (!app) return
  const measure = (): void => {
    if (box.matches(':has(#address:focus-within)')) return
    const r = box.getBoundingClientRect()
    if (!r.width) return
    app.style.setProperty('--grove-urlbar-top', `${r.top}px`)
    app.style.setProperty('--grove-urlbar-left', `${r.left}px`)
    app.style.setProperty('--grove-urlbar-width', `${r.width}px`)
  }
  // Zen's hint in the floating URL bar.
  const field = box.querySelector('#address') as (Element & { placeholderText?: string }) | null
  if (field) field.placeholderText = 'Search...'
  new ResizeObserver(measure).observe(box)
  box.addEventListener('pointerdown', measure, true)
  selectAllOnClick(box)
  box.addEventListener('focusin', () => {
    if (!open) edited = false
    open = true
  })
  // The field lost focus. If the user clicked the page, the bar closes (a
  // click there gives the page's <embed> focus, and nothing else does
  // while the bar is open); if the window lost focus, it stays as it is;
  // if anything else took focus, the field gets it back. Once the bar
  // closes (without a new tab's hold), the next open is in place again.
  box.addEventListener('focusout', () => {
    const input = fieldInput()
    if (open && input) typed = { value: input.value, start: input.selectionStart ?? 0, end: input.selectionEnd ?? 0 }
    setTimeout(() => {
      const active = deepActiveElement()
      if (active === fieldInput() || searchboxFocused()) return
      if (open && active?.tagName !== 'EMBED' && document.hasFocus()) {
        refocus()
        return
      }
      if (open && active?.tagName === 'EMBED') {
        open = false
        holding = false
        stopRetries()
        if (!searchingForNewTab) setFieldText(addressText())
      }
      if (!holding && !searchboxFocused()) {
        setCentered(false)
        endNewTabSearch()
      }
      measure()
    }, 0)
  })
  measure()
}

// A click that opens the URL bar selects its whole address, as in Chrome
// and Zen, so typing replaces it (a drag still selects just what it
// covers; a click on the open bar places the caret).
function selectAllOnClick(box: HTMLElement): void {
  let opening = false
  box.addEventListener(
    'pointerdown',
    (e) => {
      opening = e.button === 0 && e.isTrusted && !searchboxFocused()
    },
    true
  )
  box.addEventListener(
    'pointerup',
    () => {
      if (!opening) return
      opening = false
      setTimeout(() => {
        const input = fieldInput()
        if (input && input.selectionStart === input.selectionEnd && searchboxFocused()) input.select()
      }, 0)
    },
    true
  )
}

// Chrome's modifier for a new tab: Cmd on a Mac, Ctrl elsewhere. With Shift
// it opens a new foreground tab; Shift alone opens a new window.
const mac = navigator.platform.startsWith('Mac')
const newTabKey = (e: KeyboardEvent | MouseEvent): boolean => (mac ? e.metaKey : e.ctrlKey) && e.shiftKey

// While a new tab's search is open, a click on a suggestion opens it in a
// new foreground tab: Chrome's disposition for Ctrl+Shift (Cmd+Shift on a
// Mac), which Webium's searchbox reads off the event and passes to the
// browser. (Enter does the same in enterWaitsForResults.)
function openInNewTabWhileSearching(): void {
  const redirect = (e: KeyboardEvent | MouseEvent, make: (init: KeyboardEventInit & MouseEventInit) => Event): void => {
    if (!searchingForNewTab || !inSearchbox(e) || newTabKey(e)) return
    e.preventDefault()
    e.stopImmediatePropagation()
    endNewTabSearch(true)
    const init = { bubbles: true, composed: true, cancelable: true, ctrlKey: !mac, metaKey: mac, shiftKey: true }
    e.composedPath()[0]?.dispatchEvent(make(init))
  }
  document.addEventListener(
    'click',
    (e) => {
      if (e.button !== 0) return
      if (!e.composedPath().some((n) => n instanceof Element && n.tagName === 'CR-SEARCHBOX-MATCH')) return
      redirect(e, (init) => new MouseEvent('click', { ...init, button: 0, clientX: e.clientX, clientY: e.clientY }))
    },
    true
  )
}

// Enter opens what the URL bar's first row is once the results for the
// text are in. Webium's searchbox ignores an Enter while it has no results,
// and one it holds for results on their way is lost if the field closes
// first (which Grove does right after Enter); and Grove's own suggestions
// (suggestions.ts) may change the first row. So Grove holds the Enter until
// the results for the field's text are in, then sends it on, as
// Ctrl+Shift+Enter (Cmd+Shift+Enter on a Mac: a new foreground tab) for a
// new tab's search.
function enterWaitsForResults(): void {
  const forwarded = new WeakSet<Event>()
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Enter' || e.isComposing || forwarded.has(e) || !inSearchbox(e)) return
      const target = e.composedPath()[0]
      const box = searchbox()
      if (!(target instanceof HTMLElement) || !box) return
      e.preventDefault()
      e.stopImmediatePropagation()
      const newTab = searchingForNewTab && !newTabKey(e)
      void resultsReady(box).then(() => {
        if (newTab) endNewTabSearch(true)
        const enter = new KeyboardEvent('keydown', {
          key: 'Enter',
          code: e.code,
          bubbles: true,
          composed: true,
          cancelable: true,
          ctrlKey: e.ctrlKey || (newTab && !mac),
          shiftKey: e.shiftKey || newTab,
          altKey: e.altKey,
          metaKey: e.metaKey || (newTab && mac)
        })
        forwarded.add(enter)
        target.dispatchEvent(enter)
      })
    },
    true
  )
}

// Something else Enter waits for: Grove's own suggestions (suggestions.ts),
// one of which may be what Enter should open.
let alsoReady = (): boolean => true
export function enterAlsoWaitsFor(ready: () => boolean): void {
  alsoReady = ready
}

// Resolves once the searchbox has results for its current query (as its
// own Enter handling wants them), or after a while regardless.
function resultsReady(box: Searchbox, timeout = 1500): Promise<void> {
  const ready = (): boolean =>
    !box.getInputElement().inputElement.value.trim() ||
    (!!box.result?.matches.length && (box.activeQueryId === -1 || box.result.queryId === box.activeQueryId) && alsoReady())
  return new Promise((resolve) => {
    const start = performance.now()
    const check = (): void => {
      if (ready() || performance.now() - start > timeout) resolve()
      else setTimeout(check, 16)
    }
    check()
  })
}
