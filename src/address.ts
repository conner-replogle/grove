// The sidebar's URL bar shows just the site, as Zen does
// (zen.urlbar.show-domain-only-in-sidebar): an https page's host without
// "www.", anything else as it is. The field gets the full address back
// while it has focus.
//
// Chrome sets the field's text through cr-searchbox-input's
// onSetInputText_; Grove keeps that full text and shows the short one in
// the <input> itself while the field isn't focused. Chrome's own record of
// the text (what it compares edits with) stays the full address.
import { patchMethod } from './patch'

type SearchboxInput = Element & { shadowRoot: ShadowRoot }

let fullText = ''
let onSet: ((host: Element, text: string) => void) | undefined
// Whether the user is typing in the field (the URL bar's, src/urlbar.ts).
let editing: () => boolean = () => false
// Grove itself is setting the text (setOwnText).
let own = false

// While `fn` says the user is typing, Chrome's address for the page (a
// redirect, a page changing its own URL) doesn't replace what they typed,
// as in Chrome's own URL bar; addressText() has it for when they're done.
export function keepEditsWhile(fn: () => boolean): void {
  editing = fn
}

// Sets the field's text from Grove, whether or not the user is typing.
export function setOwnText(set: () => void): void {
  own = true
  try {
    set()
  } finally {
    own = false
  }
}

// Called whenever Chrome sets the field's text.
export function onAddressSet(fn: (host: Element, text: string) => void): void {
  onSet = fn
}
const wired = new WeakSet<Element>()

export function sidebarAddress(url: string): string {
  const text = url.replace(/\/$/, '')
  if (!text.startsWith('https://')) return text
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return text
  }
}

// The field's full address, whatever it shows.
export function addressText(): string {
  return fullText
}

export function showDomainOnly(): void {
  patchMethod<[string], unknown, SearchboxInput>('cr-searchbox-input', 'onSetInputText_', function (original, text) {
    if (!own && editing()) {
      fullText = text
      onSet?.(this, text)
      return undefined
    }
    const result = original(text)
    fullText = text
    wire(this)
    if (!this.matches(':focus-within')) shorten(this)
    onSet?.(this, text)
    return result
  })
}

function field(host: SearchboxInput): HTMLInputElement | null {
  return host.shadowRoot.querySelector('input')
}

function shorten(host: SearchboxInput): void {
  const input = field(host)
  if (input && input.value === fullText) input.value = sidebarAddress(fullText)
}

function wire(host: SearchboxInput): void {
  if (wired.has(host)) return
  wired.add(host)
  // Capture, so the full address is back before Chrome's own handling
  // reads the field: on focus, and on a click's press, which comes first
  // (Chrome queries suggestions for the field's text on mousedown, and the
  // result would put the short text back).
  const lengthen = (): void => {
    const input = field(host)
    if (input && input.value === sidebarAddress(fullText)) input.value = fullText
  }
  host.addEventListener('focus', lengthen, true)
  host.addEventListener('pointerdown', lengthen, true)
  // The click that focuses the field selects all of it, as Chrome's
  // omnibox does, so typing replaces the address. A drag that selected
  // part of it keeps that.
  let selectOnUp = false
  host.addEventListener('pointerdown', () => (selectOnUp = !host.matches(':focus-within')), true)
  host.addEventListener(
    'pointerup',
    () => {
      if (!selectOnUp) return
      selectOnUp = false
      const input = field(host)
      if (input && input.selectionStart === input.selectionEnd) input.select()
    },
    true
  )
  host.addEventListener('focusout', () =>
    setTimeout(() => {
      if (!host.matches(':focus-within')) shorten(host)
    }, 0)
  )
}
