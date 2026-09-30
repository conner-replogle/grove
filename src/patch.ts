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

// Replaces a method on a custom element's prototype. `impl` is called on
// the instance and receives the original, bound to it.
export function patchMethod<T extends unknown[], R, E extends Element = Element>(
  tag: string,
  name: string,
  impl: (this: E, original: (...args: T) => R, ...args: T) => R
): void {
  whenDefined(tag, (ctor) => {
    const proto = ctor.prototype as Record<string, (...args: T) => R>
    const original = proto[name]
    proto[name] = function (this: E, ...args: T) {
      return impl.call(this, original.bind(this) as (...args: T) => R, ...args)
    }
  })
}

// Runs `fn` on a custom element's class before the browser registers it.
// That matters: the browser reads a class's lifecycle callbacks
// (connectedCallback) once, at registration, so patching them any later
// never reaches new instances. Grove's script runs before Webium's, so its
// components are caught here; one already defined gets `fn` late.
const beforeDefine = new Map<string, ((ctor: CustomElementConstructor) => void)[]>()
const define = customElements.define.bind(customElements)
customElements.define = (name: string, ctor: CustomElementConstructor, options?: ElementDefinitionOptions): void => {
  for (const fn of beforeDefine.get(name) ?? []) fn(ctor)
  beforeDefine.delete(name)
  define(name, ctor, options)
}

function whenDefined(tag: string, fn: (ctor: CustomElementConstructor) => void): void {
  const existing = customElements.get(tag)
  if (existing) fn(existing)
  else beforeDefine.set(tag, [...(beforeDefine.get(tag) ?? []), fn])
}

// querySelectorAll that also looks inside open shadow roots.
export function forEachDeep(root: ParentNode, selector: string, fn: (el: Element) => void): void {
  root.querySelectorAll(selector).forEach(fn)
  root.querySelectorAll('*').forEach((el) => {
    if (el.shadowRoot) forEachDeep(el.shadowRoot, selector, fn)
  })
}
