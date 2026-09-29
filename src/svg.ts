// Builds SVG elements from Grove's own static SVG markup without innerHTML,
// which Chrome's WebUI blocks (Trusted Types). Handles plain elements and
// attributes only: no text nodes, entities or CDATA.
const NS = 'http://www.w3.org/2000/svg'
const TAG = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/g
const ATTR = /([\w:-]+)="([^"]*)"/g

export function svg(markup: string): SVGElement {
  const source = markup.replace(/<!--[\s\S]*?-->/g, '')
  const stack: Element[] = []
  let root: SVGElement | undefined
  for (const [, closing, name, attrs, selfClosing] of source.matchAll(TAG)) {
    if (closing) {
      stack.pop()
      continue
    }
    const node = document.createElementNS(NS, name)
    for (const [, key, value] of attrs.matchAll(ATTR)) node.setAttribute(key, value)
    if (stack.length) stack[stack.length - 1].append(node)
    else root = node as SVGElement
    if (!selfClosing) stack.push(node)
  }
  if (!root) throw new Error('svg: no root element')
  return root
}
