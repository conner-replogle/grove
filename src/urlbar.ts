// Opening the URL bar for a new tab, as Zen does.
//
// New Tab (the sidebar row, or Ctrl+T via the host) makes no tab: it opens
// the URL bar centered and empty, and the result picked there opens in a
// new tab. Only a window with nothing to show gets a real New Tab page,
// and its URL bar opens over it.
//
// Focusing the field isn't enough on its own, for two reasons:
//  - When a tab becomes active, Webium focuses the <embed> that shows its
//    page. So while a new tab's search is open, the <embed> isn't focused
//    (the override below); the page gets the keyboard once the search
//    closes.
//  - Chrome sends keys to whichever web contents it last gave focus, the
//    window's UI or a page in it. Focusing an element of the UI from script
//    doesn't move that: a page the user was typing in keeps the keys while
//    the URL bar shows a caret. A click in the UI does move it, so when the
//    URL bar opens without one (Ctrl+T, a New Tab page), the host clicks the
//    field (claimKeyboard).
import { addressText, setOwnText } from './address'
import { onFocusUrlBar, onOpenNewTabSearch, send } from './host-client'

let holding = false
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
// back the page's address.
let searchingForNewTab = false

export interface SearchboxInput extends HTMLElement {
  inputElement: HTMLInputElement
}
export interface Searchbox extends HTMLElement {
  setInputText?(t: string): void
  getInputElement(): SearchboxInput
  result: { queryId: number; matches: unknown[] } | null
  activeQueryId: number
}
export const searchbox = (): Searchbox | null =>
  document.querySelector('webui-browser-app')?.shadowRoot?.querySelector<Searchbox>('#address') ?? null

// Whether the URL bar is open as a new tab's search.
export function isNewTabSearch(): boolean {
  return searchingForNewTab
}

// New Tab: the sidebar's row (a click, which already gave the window's UI
// the keyboard) or Ctrl+T (the host, after Chrome made a tab and Grove put
// the page back: the page has the keyboard).
export function openNewTabSearch(how: 'click' | 'keyboard' = 'keyboard'): void {
  searchingForNewTab = true
  setOwnText(searchbox(), '')
  openField(how === 'keyboard')
}

function endNewTabSearch(opened = false): void {
  if (!searchingForNewTab) return
  searchingForNewTab = false
  // The page's address as Chrome last set it: the page the window shows
  // now, which may not be the one it showed when the search opened.
  if (!opened) setOwnText(searchbox(), addressText())
}

export function openUrlBarOnNewTab(): void {
  // Webium focuses a tab's <embed> when the tab becomes active. For a New
  // Tab page (however it opened: the button, Ctrl+T, or switching to a
  // blank tab) the URL bar gets the keyboard instead.
  focusEmbed = HTMLEmbedElement.prototype.focus
  HTMLEmbedElement.prototype.focus = function (this: HTMLEmbedElement, options?: FocusOptions) {
    if (holding) return
    if (showsNewTabPage(this)) {
      openField(true)
      return
    }
    focusEmbed.call(this, options)
  }

  onFocusUrlBar(() => openField(true))
  onOpenNewTabSearch(() => openNewTabSearch('keyboard'))
  openInNewTabWhileSearching()
  enterWaitsForResults()
  document.addEventListener(
    'keydown',
    (e) => {
      // The keys reach the field: it has the keyboard.
      if (inSearchbox(e)) stopRetries()
    },
    true
  )

  // A click anywhere but the URL bar closes it: the page gets the keyboard.
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (holding && !inSearchbox(e)) setTimeout(releasePageFocus, 0)
    },
    true
  )
}

// Opens the URL bar centered, focused, for a new tab: until the user types
// or the bar closes, the field is focused again a few times (Webium
// attaches a new page a moment after its tab activates, which can take
// focus back). `claim`: there was no click, so Chrome's keyboard focus may
// still be on a page; the host clicks the field to bring it over.
function openField(claim: boolean): void {
  hold()
  setCentered(true)
  stopRetries()
  retries = [0, 120, 400].map((delay) =>
    setTimeout(() => {
      focusField()
      if (claim) claimKeyboard()
    }, delay)
  )
}

// Asks the host to click the (empty) field, at its far end.
function claimKeyboard(): void {
  const input = searchbox()?.getInputElement?.()?.inputElement
  if (!input || input.value) return
  const r = input.getBoundingClientRect()
  if (!r.width || !r.height) return
  send({ type: 'claimKeyboard', x: Math.round(r.left + r.width * 0.9), y: Math.round(r.top + r.height / 2) })
}

// Whether an <embed> shows a New Tab page: its cr-tab-webview's tab, looked
// up in Webium's (hidden) tab strip.
function showsNewTabPage(embed: HTMLElement): boolean {
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

function searchboxFocused(): boolean {
  return !!searchbox()?.matches(':focus-within')
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
  // Once the bar closes (without a new tab's hold), the next open is in
  // place again.
  box.addEventListener('focusout', () =>
    setTimeout(() => {
      if (!holding && !searchboxFocused()) {
        setCentered(false)
        endNewTabSearch()
      }
      measure()
    }, 0)
  )
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
        const input = searchbox()?.getInputElement?.()?.inputElement
        if (input && input.selectionStart === input.selectionEnd && searchboxFocused()) input.select()
      }, 0)
    },
    true
  )
}

// While a new tab's search is open, a click on a suggestion opens it in a
// new foreground tab: Chrome's disposition for Ctrl+Shift, which Webium's
// searchbox reads off the event and passes to the browser. (Enter: see
// enterWaitsForResults.)
function openInNewTabWhileSearching(): void {
  document.addEventListener(
    'click',
    (e) => {
      if (e.button !== 0) return
      if (!e.composedPath().some((n) => n instanceof Element && n.tagName === 'CR-SEARCHBOX-MATCH')) return
      if (!searchingForNewTab || !inSearchbox(e) || (e.ctrlKey && e.shiftKey)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      endNewTabSearch(true)
      const init = { bubbles: true, composed: true, cancelable: true, ctrlKey: true, shiftKey: true }
      e.composedPath()[0]?.dispatchEvent(new MouseEvent('click', { ...init, button: 0, clientX: e.clientX, clientY: e.clientY }))
    },
    true
  )
}

// Enter opens what was typed even when it comes before Chrome's results
// for the text do. Webium's searchbox ignores an Enter while it has no
// results, and one it holds for results that are on their way is lost if
// the field closes first (which Grove does right after Enter). So Grove
// holds the Enter until the results for the field's text are in, then
// sends it on, as Ctrl+Shift+Enter (a new foreground tab) for a new tab's
// search.
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
      const newTab = searchingForNewTab && !(e.ctrlKey && e.shiftKey)
      void resultsReady(box).then(() => {
        if (newTab) endNewTabSearch(true)
        const enter = new KeyboardEvent('keydown', {
          key: 'Enter',
          code: e.code,
          bubbles: true,
          composed: true,
          cancelable: true,
          ctrlKey: e.ctrlKey || newTab,
          shiftKey: e.shiftKey || newTab,
          altKey: e.altKey,
          metaKey: e.metaKey
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
