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
import { addressText } from './address'
import { onFocusUrlBar, onOpenNewTabSearch } from './host-client'

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
// back the page's address it had.
let searchingForNewTab = false
let addressBefore = ''

type SearchboxField = Element & { setInputText?(t: string): void }
const searchboxField = (): SearchboxField | null =>
  document.querySelector('webui-browser-app')?.shadowRoot?.querySelector('#address') ?? null

export function openNewTabSearch(): void {
  if (!searchingForNewTab) addressBefore = addressText()
  searchingForNewTab = true
  setCentered(true)
  focusField()
  searchboxField()?.setInputText?.('')
}

function endNewTabSearch(opened = false): void {
  if (!searchingForNewTab) return
  searchingForNewTab = false
  if (!opened) searchboxField()?.setInputText?.(addressBefore)
}

export function openUrlBarOnNewTab(): void {
  // Webium focuses a tab's <embed> when the tab becomes active. For a New
  // Tab page (however it opened: the button, Ctrl+T, or switching to a
  // blank tab) the URL bar gets the keyboard instead.
  focusEmbed = HTMLEmbedElement.prototype.focus
  HTMLEmbedElement.prototype.focus = function (this: HTMLEmbedElement, options?: FocusOptions) {
    if (holding) return
    if (showsNewTabPage(this)) {
      openForNewTab()
      return
    }
    focusEmbed.call(this, options)
  }

  onFocusUrlBar(openForNewTab)
  onOpenNewTabSearch(openNewTabSearch)
  openInNewTabWhileSearching()
  document.addEventListener(
    'keydown',
    (e) => {
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

function openForNewTab(): void {
  hold()
  setCentered(true)
  // Webium attaches the new page a moment after the tab activates, which
  // can take focus back; focus the field again then, until the user starts
  // typing or the bar closes.
  stopRetries()
  retries = [0, 120, 400].map((delay) => setTimeout(focusField, delay))
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

// While a new tab's search is open, Enter and a click on a suggestion open
// it in a new foreground tab: Chrome's disposition for Ctrl+Shift, which
// Webium's searchbox reads off the event and passes to the browser.
function openInNewTabWhileSearching(): void {
  const redirect = (e: KeyboardEvent | MouseEvent, make: (init: KeyboardEventInit & MouseEventInit) => Event): void => {
    if (!searchingForNewTab || !inSearchbox(e) || (e.ctrlKey && e.shiftKey)) return
    e.preventDefault()
    e.stopImmediatePropagation()
    endNewTabSearch(true)
    const init = { bubbles: true, composed: true, cancelable: true, ctrlKey: true, shiftKey: true }
    e.composedPath()[0]?.dispatchEvent(make(init))
  }
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        redirect(e, (init) => new KeyboardEvent('keydown', { ...init, key: 'Enter', code: e.code }))
      }
    },
    true
  )
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
