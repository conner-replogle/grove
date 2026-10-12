// Split view layouts, as Zen keeps them (ZenViewSplitter.mjs): a tree of
// panes, rows and columns, each child sized in percent of its parent.
// Pure functions; every one returns a tidy tree (see tidy).
import type { Split, SplitBranch, SplitLayout, SplitLeaf, SplitNode, SplitSide } from '../shared/types.ts'

export const isLeaf = (n: SplitNode): n is SplitLeaf => 'entryId' in n

// The entries a tree shows, in reading order.
export function leaves(n: SplitNode): string[] {
  return isLeaf(n) ? [n.entryId] : n.children.flatMap(leaves)
}

// Zen's calculateLayoutTree: side by side (vsep), stacked (hsep), or a row
// of columns of two (grid; with two tabs, side by side).
export function layoutTree(ids: string[], layout: SplitLayout): SplitNode {
  const leaf = (entryId: string, size: number): SplitLeaf => ({ entryId, size })
  if (ids.length === 1) return leaf(ids[0], 100)
  if (layout === 'hsep') return { direction: 'column', size: 100, children: ids.map((id) => leaf(id, 100 / ids.length)) }
  if (layout === 'vsep' || ids.length === 2) {
    return { direction: 'row', size: 100, children: ids.map((id) => leaf(id, 100 / ids.length)) }
  }
  const columns = Math.ceil(ids.length / 2)
  const children: SplitNode[] = []
  for (let i = 0; i < ids.length; i += 2) {
    const pair = ids.slice(i, i + 2)
    children.push(
      pair.length === 2
        ? { direction: 'column', size: 100 / columns, children: pair.map((id) => leaf(id, 50)) }
        : leaf(pair[0], 100 / columns)
    )
  }
  return { direction: 'row', size: 100, children }
}

// Keeps the panes `keep` accepts and restores the tree's invariants: a
// node has two or more children, none laid out its own way (those join
// it), and siblings' sizes add up to 100. Undefined if no pane is left.
export function tidy(node: SplitNode, keep: (entryId: string) => boolean = () => true): SplitNode | undefined {
  const t = prune(node, keep)
  return t && { ...t, size: 100 }
}

function prune(node: SplitNode, keep: (entryId: string) => boolean): SplitNode | undefined {
  if (isLeaf(node)) return keep(node.entryId) ? { entryId: node.entryId, size: node.size } : undefined
  const kids: SplitNode[] = []
  for (const child of node.children) {
    const p = prune(child, keep)
    if (!p) continue
    if (!isLeaf(p) && p.direction === node.direction) {
      kids.push(...p.children.map((g) => ({ ...g, size: (g.size * p.size) / 100 })))
    } else kids.push(p)
  }
  if (!kids.length) return undefined
  if (kids.length === 1) return { ...kids[0], size: node.size }
  const sized = kids.map((c) => (Number.isFinite(c.size) && c.size > 0 ? c.size : 100 / kids.length))
  const total = sized.reduce((a, b) => a + b, 0)
  return {
    direction: node.direction,
    size: node.size,
    children: kids.map((c, i) => ({ ...c, size: (sized[i] * 100) / total }))
  }
}

// Puts pane `entryId` on one side of pane `targetId`, which gives it half
// its room; without a target (or one not in the tree), on that side of the
// whole split, with an equal share.
export function insertPane(root: SplitNode, entryId: string, side: SplitSide, targetId?: string): SplitNode {
  const direction = side === 'left' || side === 'right' ? 'row' : 'column'
  const first = side === 'left' || side === 'top'
  const pair = (n: SplitNode, share: number): SplitBranch => {
    const fresh: SplitLeaf = { entryId, size: share }
    const old = { ...n, size: 100 - share }
    return { direction, size: n.size, children: first ? [fresh, old] : [old, fresh] }
  }
  const without = tidy(root, (id) => id !== entryId) ?? { entryId: targetId ?? entryId, size: 100 }
  if (targetId && targetId !== entryId && leaves(without).includes(targetId)) {
    const visit = (n: SplitNode): SplitNode =>
      isLeaf(n) ? (n.entryId === targetId ? pair(n, 50) : n) : { ...n, children: n.children.map(visit) }
    return tidy(visit(without))!
  }
  return tidy(pair(without, 100 / (leaves(without).length + 1)))!
}

// Trades two panes' places.
export function swapPanes(root: SplitNode, a: string, b: string): SplitNode {
  const visit = (n: SplitNode): SplitNode =>
    isLeaf(n)
      ? { ...n, entryId: n.entryId === a ? b : n.entryId === b ? a : n.entryId }
      : { ...n, children: n.children.map(visit) }
  return visit(root)
}

// A tree read from disk or another device, if it is one.
export function parseLayout(raw: unknown): SplitNode | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const size = typeof r.size === 'number' && Number.isFinite(r.size) ? r.size : 0
  if (typeof r.entryId === 'string') return { entryId: r.entryId, size }
  if ((r.direction !== 'row' && r.direction !== 'column') || !Array.isArray(r.children)) return undefined
  const children = r.children.map(parseLayout)
  if (children.some((c) => !c)) return undefined
  return { direction: r.direction, size, children: children as SplitNode[] }
}

// A workspace's splits read from disk or another device; normalize then
// drops panes of tabs that aren't there.
export function parseSplits(raw: unknown): Split[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((s) => {
    const r = s as Record<string, unknown> | null
    const layout = r && typeof r.id === 'string' ? parseLayout(r.layout) : undefined
    return layout ? [{ id: r!.id as string, layout }] : []
  })
}
