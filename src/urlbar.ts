// Opening the URL bar for a new tab, as Zen does.
//
// Focusing the field isn't enough on its own. When a tab becomes active,
// Webium focuses the <embed> that shows its page, which gives that page the
// keyboard at the browser level; focusing an element of the window's UI
// afterwards doesn't take it back, so typing would go to the page. So for a
// New Tab page the <embed> isn't focused; the URL bar is, and the page gets
// the keyboard once the URL bar closes.
import { onFocusUrlBar } from './host-client'

let holding = false
// Webium's own <embed> focus, which the override below stands in front of.
let focusEmbed: HTMLElement['focus'] = HTMLEmbedElement.prototype.focus
let released: ReturnType<typeof setTimeout> | undefined
let retries: ReturnType<typeof setTimeout>[] = []

function stopRetries(): void {
  retries.forEach(clearTimeout)
  retries = []
}

// Called before asking for a new tab from the UI (the New Tab button), so
// the hold is on before Webium activates it.
export function expectNewTab(): void {
  hold()
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
