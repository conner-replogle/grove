// Hooks into Webium's own components without forking them.

// Adds `css` to every instance of the custom element `tag`, whether the
// element class is defined before or after Grove's script runs. Lit adopts
// a component's styles when it connects, so the sheet is appended right
// after that.
export function addStyles(tag: string, css: string): void {
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(css)
  const attach = (el: Element): void => {
    const root = el.shadowRoot
    if (root && !root.adoptedStyleSheets.includes(sheet)) {
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet]
    }
  }
  whenDefined(tag, (ctor) => {
    const proto = ctor.prototype as { connectedCallback?: () => void }
    const original = proto.connectedCallback
    proto.connectedCallback = function (this: Element) {
      original?.call(this)
      attach(this)
    }
    forEachDeep(document, tag, attach)
  })
}

// Replaces a method on a custom element's prototype. `impl` receives the
// original, bound to the instance.
export function patchMethod<T extends unknown[], R>(
  tag: string,
  name: string,
  impl: (original: (...args: T) => R, ...args: T) => R
): void {
  whenDefined(tag, (ctor) => {
    const proto = ctor.prototype as Record<string, (...args: T) => R>
    const original = proto[name]
    proto[name] = function (this: unknown, ...args: T) {
      return impl(original.bind(this) as (...args: T) => R, ...args)
    }
  })
}

function whenDefined(tag: string, fn: (ctor: CustomElementConstructor) => void): void {
  const existing = customElements.get(tag)
  if (existing) fn(existing)
  else void customElements.whenDefined(tag).then(fn)
}

// querySelectorAll that also looks inside open shadow roots.
export function forEachDeep(root: ParentNode, selector: string, fn: (el: Element) => void): void {
  root.querySelectorAll(selector).forEach(fn)
  root.querySelectorAll('*').forEach((el) => {
    if (el.shadowRoot) forEachDeep(el.shadowRoot, selector, fn)
  })
}
