// Split view in the window, as in Zen (ZenViewSplitter.mjs and
// zen-split-view.css): when the window's tab is in a split, every tab of
// the split shows at once, each its own Chrome page in its pane.
//
// Webium keeps a <cr-tab-webview> for each of the window's tabs in its
// <content-region> and shows only the active one; a pane is one of those
// made visible and placed. Chrome keeps such a page live and gives it
// input like the active one. The host says where each pane's page is among
// the window's Chrome tabs; Chrome's Tab Strip API lists them in the same
// order with Webium's ids, which name the webviews.
//
// Webium hides the page of a tab that stops being active (Chrome then
// stops drawing it), so a pane that was active once would go blank:
// putting its webview back into the page makes a new <embed>, whose page
// shows again. Each pane gets that once after it was last active.
//
// A click on a pane's page focuses its <embed>, which makes that tab the
// window's active one (the URL bar and back/forward follow it). Between
// panes are resizers; at the top of each, a handle to rearrange the pane
// or take it out of the split; and a tab dragged from the sidebar onto the
// page splits it beside the pane it's dropped on.
import gripSvg from 'lucide-static/icons/grip-horizontal.svg'
import expandSvg from 'lucide-static/icons/maximize-2.svg'
import type { HostCommand, WindowState } from '../shared/protocol.ts'
import { MAX_SPLIT, type SplitBranch, type SplitNode, type SplitSide } from '../shared/types.ts'
import { send, subscribe } from './host-client'
import { addStyles } from './patch'
import splitCss from './styles/split.css'
import { svg } from './svg'

// Zen's zen.splitView.min-resize-width (percent), and its quarter-of-a-pane
// drop and rearrange edges (_calculateDropSide, rearrange-hover-size 24).
const MIN_SIZE = 7
const DROP_EDGE = 0.25
const REARRANGE_EDGE = 0.24

interface Rect {
  top: number
  left: number
  width: number
  height: number
}
type Webview = HTMLElement & { tabId?: string }
type Region = HTMLElement & { webviews?: Map<string, Webview> }
type Split = NonNullable<WindowState['split']>

const isLeaf = (n: SplitNode): n is Extract<SplitNode, { entryId: string }> => 'entryId' in n
const leaves = (n: SplitNode): string[] => (isLeaf(n) ? [n.entryId] : n.children.flatMap(leaves))

const appRoot = (): ShadowRoot | null | undefined => document.querySelector('webui-browser-app')?.shadowRoot
const region = (): Region | null => appRoot()?.querySelector<Region>('content-region') ?? null

let state: WindowState | undefined
// The split shown, as laid out here: the host's, or one being resized.
let layout: SplitNode | undefined
// Webium's tab ids in Chrome's order.
let order: string[] = []
let orderKey = ''
let overlay: HTMLElement | undefined
let shield: HTMLElement | undefined
// A resize or rearrange under way: host updates wait for its end.
let dragging = false
let pendingState = false
// Panes whose page is showing (see revive), until they're active again.
const revived = new WeakSet<Webview>()
let reviveQueued: ReturnType<typeof setTimeout> | undefined

export function showSplitView(): void {
  addStyles('content-region', splitCss)
  subscribe((s) => {
    state = s
    if (dragging) {
      pendingState = true
      return
    }
    layout = s.split?.layout
    void refresh()
  })
  // Webium adds and removes webviews as tabs come and go.
  const watch = (): void => {
    const r = region()
    if (!r?.shadowRoot) {
      requestAnimationFrame(watch)
      return
    }
    new MutationObserver(() => {
      if (!dragging) void refresh()
    }).observe(r.shadowRoot, { childList: true })
    r.shadowRoot.addEventListener('focusin', onFocusIn)
    void refresh()
  }
  watch()
}

// A click on a pane's page: its tab becomes the window's. (Webium itself
// focuses only the webview it has active, which needs nothing done.)
function onFocusIn(e: Event): void {
  const view = e.target as Webview
  if (!state?.split || view.tagName !== 'CR-TAB-WEBVIEW' || view.classList.contains('active')) return
  const entryId = paneEntries().find(([, v]) => v === view)?.[0]
  if (entryId && entryId !== state.activeEntryId) send({ type: 'activate', entryId })
}

// Re-reads Chrome's tab order when the host's tab places changed, then draws.
async function refresh(): Promise<void> {
  const split = state?.split
  const key = split ? JSON.stringify(split.tabIndex) + [...(region()?.webviews?.keys() ?? [])].join() : ''
  if (split && key !== orderKey) {
    orderKey = key
    order = await chromeOrder().catch(() => order)
    if (dragging) return
  }
  draw()
}

async function chromeOrder(): Promise<string[]> {
  const api = await import('/tab_strip_api/tab_strip_api.mojom-webui.js')
  const snapshot = await api.TabStripService.getRemote().getTabs()
  const ids: string[] = []
  type Node = { data: Record<string, { id: string } | undefined>; children?: Node[] }
  const walk = (n: Node): void => {
    if (n.data.tab) ids.push(n.data.tab.id)
    else n.children?.forEach(walk)
  }
  walk(snapshot.tabStrip as Node)
  return ids
}

// Each pane's entry and its webview here (undefined: its page isn't here).
function paneEntries(): [string, Webview | undefined][] {
  const split = state?.split
  const views = region()?.webviews
  if (!split || !layout) return []
  return leaves(layout).map((id) => {
    const index = split.tabIndex[id]
    const tabId = index === null || index === undefined ? undefined : order[index]
    return [id, tabId ? views?.get(tabId) : undefined]
  })
}

// ---- Drawing ----

function draw(): void {
  const r = region()
  const root = r?.shadowRoot
  if (!r || !root) return
  const main = appRoot()?.querySelector<HTMLElement>('#main')
  const split = state?.split
  const panes = new Map(paneEntries().filter((p): p is [string, Webview] => !!p[1]))
  const shown = new Set(panes.values())
  for (const view of r.webviews?.values() ?? []) {
    if (shown.has(view)) continue
    view.classList.remove('grove-pane', 'grove-pane-active')
    view.style.removeProperty('inset')
  }
  main?.classList.toggle('grove-split', !!split)
  r.toggleAttribute('grove-split', !!split)
  if (!split || !layout) {
    overlay?.remove()
    overlay = undefined
    return
  }
  const rects = paneRects(layout)
  for (const [entryId, view] of panes) {
    if (view.classList.contains('active')) revived.delete(view)
    view.classList.add('grove-pane')
    view.classList.toggle('grove-pane-active', entryId === state!.activeEntryId)
    view.style.inset = inset(rects.get(entryId)!)
  }
  queueRevive()

  if (!overlay || overlay.parentNode !== root) {
    overlay?.remove()
    overlay = el('div', 'grove-split-overlay')
    root.append(overlay)
  }
  overlay.replaceChildren()
  for (const [entryId] of paneEntries().filter(([, v]) => !v)) overlay.append(missingPane(entryId, rects.get(entryId)!))
  for (const [entryId, rect] of rects) overlay.append(paneHandle(split, entryId, rect))
  for (const resizer of resizers(split, layout)) overlay.append(resizer)
}

// Re-attaches panes Chrome has hidden. After a moment: Chrome hides the
// old tab when it activates the new one, which may land after this draw.
function queueRevive(): void {
  clearTimeout(reviveQueued)
  reviveQueued = setTimeout(() => {
    const root = region()?.shadowRoot
    if (!root || dragging) return
    for (const [, view] of paneEntries()) {
      if (!view || view.classList.contains('active')) {
        if (view) revived.delete(view)
        continue
      }
      if (revived.has(view)) continue
      revived.add(view)
      const next = view.nextSibling
      view.remove()
      root.insertBefore(view, next)
    }
  }, 60)
}

// Where each pane sits, in fractions of the content area.
function paneRects(node: SplitNode, r: Rect = { top: 0, left: 0, width: 1, height: 1 }, out = new Map<string, Rect>()): Map<string, Rect> {
  if (isLeaf(node)) return out.set(node.entryId, r)
  let at = 0
  for (const child of node.children) {
    const f = child.size / 100
    const sub =
      node.direction === 'row'
        ? { top: r.top, height: r.height, left: r.left + at * r.width, width: f * r.width }
        : { left: r.left, width: r.width, top: r.top + at * r.height, height: f * r.height }
    paneRects(child, sub, out)
    at += f
  }
  return out
}

// A rect as CSS insets: inner edges leave half the gap between panes.
const EPS = 0.001
function inset(r: Rect): string {
  const edge = (f: number): string => `calc(${(f * 100).toFixed(4)}% + ${f > EPS ? 'var(--split-gap) / 2' : '0px'})`
  return [edge(r.top), edge(1 - r.left - r.width), edge(1 - r.top - r.height), edge(r.left)].join(' ')
}

// A pane whose page isn't in this window (it's showing in another one,
// or still opening): clicking it brings it here.
function missingPane(entryId: string, r: Rect): HTMLElement {
  const box = el('div', 'grove-pane-missing')
  box.style.inset = inset(r)
  const entry = state?.workspace.entries.find((e) => e.id === entryId)
  box.append(el('div', 'title', entry?.title || entry?.url || ''), el('div', 'note', 'Open in another window'))
  box.addEventListener('click', () => send({ type: 'activate', entryId }))
  return box
}

// ---- Resizing ----

function resizers(split: Split, root: SplitNode): HTMLElement[] {
  const out: HTMLElement[] = []
  const visit = (node: SplitNode, r: Rect): void => {
    if (isLeaf(node)) return
    let at = 0
    node.children.forEach((child, i) => {
      const f = child.size / 100
      const sub =
        node.direction === 'row'
          ? { top: r.top, height: r.height, left: r.left + at * r.width, width: f * r.width }
          : { left: r.left, width: r.width, top: r.top + at * r.height, height: f * r.height }
      visit(child, sub)
      at += f
      if (i < node.children.length - 1) out.push(resizer(split, node, i, r, at))
    })
  }
  visit(root, { top: 0, left: 0, width: 1, height: 1 })
  return out
}

function resizer(split: Split, node: SplitBranch, i: number, r: Rect, at: number): HTMLElement {
  const row = node.direction === 'row'
  const bar = el('div', `grove-split-resizer ${row ? 'vertical' : 'horizontal'}`)
  const pct = (f: number): string => `${(f * 100).toFixed(4)}%`
  if (row) {
    bar.style.left = `calc(${pct(r.left + at * r.width)} - var(--split-gap) / 2)`
    bar.style.top = pct(r.top)
    bar.style.height = pct(r.height)
  } else {
    bar.style.top = `calc(${pct(r.top + at * r.height)} - var(--split-gap) / 2)`
    bar.style.left = pct(r.left)
    bar.style.width = pct(r.width)
  }
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const box = region()!.getBoundingClientRect()
    const span = row ? r.width * box.width : r.height * box.height
    const start = row ? e.clientX : e.clientY
    const [a, b] = [node.children[i].size, node.children[i + 1].size]
    beginDrag(row ? 'ew-resize' : 'ns-resize', (ev) => {
      const delta = (((row ? ev.clientX : ev.clientY) - start) / span) * 100
      const d = Math.max(MIN_SIZE - a, Math.min(b - MIN_SIZE, delta))
      node.children[i].size = a + d
      node.children[i + 1].size = b - d
      draw()
    }, (done) => {
      if (done) send({ type: 'setSplitLayout', splitId: split.id, layout: layout! })
    })
    // Resize the local copy; the host gets it at the end.
    layout = structuredClone(layout!)
    const path = pathTo(state!.split!.layout, node)
    const live = path && (nodeAt(layout, path) as SplitBranch)
    if (live) node = live
  })
  return bar
}

// A branch's position in the tree, as child indices, to find its copy.
function pathTo(root: SplitNode, target: SplitNode, path: number[] = []): number[] | undefined {
  if (root === target) return path
  if (isLeaf(root)) return undefined
  for (const [i, c] of root.children.entries()) {
    const p = pathTo(c, target, [...path, i])
    if (p) return p
  }
  return undefined
}
const nodeAt = (root: SplitNode, path: number[]): SplitNode =>
  path.reduce((n, i) => (n as SplitBranch).children[i], root)

// A pointer drag over the whole window: a shield keeps the pages from
// taking the pointer, and host updates wait until it's over.
function beginDrag(cursor: string, move: (e: PointerEvent) => void, end: (done: boolean) => void): void {
  dragging = true
  region()?.setAttribute('grove-split-dragging', '')
  shield = el('div', 'grove-split-shield')
  shield.style.cursor = cursor
  region()?.shadowRoot?.append(shield)
  const finish = (done: boolean): void => {
    document.removeEventListener('pointermove', move, true)
    document.removeEventListener('pointerup', up, true)
    document.removeEventListener('keydown', key, true)
    shield?.remove()
    shield = undefined
    region()?.removeAttribute('grove-split-dragging')
    end(done)
    dragging = false
    if (pendingState || !done) {
      pendingState = false
      layout = state?.split?.layout
    }
    void refresh()
  }
  const up = (): void => finish(true)
  const key = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') finish(false)
  }
  document.addEventListener('pointermove', move, true)
  document.addEventListener('pointerup', up, true)
  document.addEventListener('keydown', key, true)
}

// ---- A pane's handle: rearrange, or take it out of the split ----

function paneHandle(split: Split, entryId: string, r: Rect): HTMLElement {
  const handle = el('div', 'grove-pane-header')
  handle.style.left = `${((r.left + r.width / 2) * 100).toFixed(4)}%`
  handle.style.top = `calc(${(r.top * 100).toFixed(4)}% + ${r.top > EPS ? 'var(--split-gap) / 2' : '0px'})`
  const grip = el('button', 'rearrange')
  grip.title = 'Drag to move this pane'
  grip.append(svg(gripSvg))
  grip.addEventListener('pointerdown', (e) => {
    if (e.button === 0) rearrange(entryId, e)
  })
  const out = el('button', 'unsplit')
  out.title = 'Take this tab out of the split'
  out.append(svg(expandSvg))
  out.addEventListener('click', () => send({ type: 'unsplit', entryId }))
  handle.append(grip, out)
  return handle
}

// Zen's rearrange mode: drag a pane onto another one's middle to swap
// them, or onto its edge to put it on that side; onto the sidebar to take
// it out of the split.
function rearrange(entryId: string, start: PointerEvent): void {
  start.preventDefault()
  const zone = el('div', 'grove-split-dropzone')
  let command: HostCommand | undefined
  region()?.setAttribute('grove-split-rearranging', '')
  paneEntries().find(([id]) => id === entryId)?.[1]?.classList.add('grove-pane-dragged')
  beginDrag('grabbing', (e) => {
    command = undefined
    zone.remove()
    const box = region()!.getBoundingClientRect()
    if (e.clientX < box.left) {
      command = { type: 'unsplit', entryId }
      return
    }
    const hit = paneAt(e.clientX, e.clientY)
    if (!hit || hit.entryId === entryId) return
    const side = sideOf(hit.rect, e.clientX, e.clientY, REARRANGE_EDGE)
    command = side
      ? { type: 'splitBeside', entryId, targetId: hit.entryId, side }
      : { type: 'swapPanes', entryId, otherId: hit.entryId }
    zone.style.inset = inset(side ? half(hit.rect, side) : hit.rect)
    shield?.append(zone)
  }, (done) => {
    region()?.removeAttribute('grove-split-rearranging')
    region()?.shadowRoot?.querySelectorAll('.grove-pane-dragged').forEach((v) => v.classList.remove('grove-pane-dragged'))
    if (done && command) send(command)
  })
}

// The pane at a point of the window, with its rect in fractions.
function paneAt(x: number, y: number): { entryId: string; rect: Rect } | undefined {
  if (!layout) return undefined
  const box = region()!.getBoundingClientRect()
  const fx = (x - box.left) / box.width
  const fy = (y - box.top) / box.height
  for (const [entryId, rect] of paneRects(layout)) {
    if (fx >= rect.left && fx <= rect.left + rect.width && fy >= rect.top && fy <= rect.top + rect.height) return { entryId, rect }
  }
  return undefined
}

// The edge of `r` a point is nearest, if it's within `edge` of it (a
// fraction of the rect's size).
function sideOf(r: Rect, x: number, y: number, edge: number): SplitSide | undefined {
  const box = region()!.getBoundingClientRect()
  const fx = ((x - box.left) / box.width - r.left) / r.width
  const fy = ((y - box.top) / box.height - r.top) / r.height
  const sides: [SplitSide, number][] = [
    ['left', fx],
    ['right', 1 - fx],
    ['top', fy],
    ['bottom', 1 - fy]
  ]
  const [side, d] = sides.reduce((a, b) => (b[1] < a[1] ? b : a))
  return d <= edge ? side : undefined
}

function half(r: Rect, side: SplitSide): Rect {
  switch (side) {
    case 'left':
      return { ...r, width: r.width / 2 }
    case 'right':
      return { ...r, left: r.left + r.width / 2, width: r.width / 2 }
    case 'top':
      return { ...r, height: r.height / 2 }
    case 'bottom':
      return { ...r, top: r.top + r.height / 2, height: r.height / 2 }
  }
}

// ---- A tab dragged from the sidebar onto the page ----

let preview: HTMLElement | undefined

export const sidebarDrop = {
  // A drag from the sidebar started: the pages mustn't take the pointer.
  begin(): void {
    const root = region()?.shadowRoot
    if (!root || shield) return
    shield = el('div', 'grove-split-shield')
    root.append(shield)
  },

  // The command a drop of `entryId` at (x, y) would send, showing where the
  // new pane would go: beside the pane under the pointer, in the outer
  // quarter of it (Zen's drop zones).
  over(entryId: string, x: number, y: number): HostCommand | undefined {
    preview?.remove()
    preview = undefined
    const s = state
    const r = region()
    if (!s || !r || !shield) return undefined
    const box = r.getBoundingClientRect()
    if (x < box.left || x > box.right || y < box.top || y > box.bottom) return undefined
    if (s.essentials.some((e) => e.id === entryId)) return undefined
    let target: { entryId: string; rect: Rect } | undefined
    if (s.split && layout) {
      target = paneAt(x, y)
      const ids = leaves(layout)
      if (!ids.includes(entryId) && ids.length >= MAX_SPLIT) return undefined
    } else if (s.activeEntryId && s.workspace.entries.some((e) => e.id === s.activeEntryId)) {
      target = { entryId: s.activeEntryId, rect: { top: 0, left: 0, width: 1, height: 1 } }
    }
    if (!target || target.entryId === entryId) return undefined
    const side = sideOf(target.rect, x, y, DROP_EDGE)
    if (!side) return undefined
    preview = el('div', 'grove-split-preview')
    preview.style.inset = inset(half(target.rect, side))
    shield.append(preview)
    return { type: 'splitBeside', entryId, targetId: target.entryId, side }
  },

  end(): void {
    preview?.remove()
    preview = undefined
    if (!dragging) {
      shield?.remove()
      shield = undefined
    }
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}
