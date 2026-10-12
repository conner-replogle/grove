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
  // Capture, so the full address is back before Chrome's own focus
  // handling reads the field.
  host.addEventListener(
    'focus',
    () => {
      const input = field(host)
      if (input && input.value === sidebarAddress(fullText)) input.value = fullText
    },
    true
  )
  host.addEventListener('focusout', () =>
    setTimeout(() => {
      if (!host.matches(':focus-within')) shorten(host)
    }, 0)
  )
}
