import { describe, expect, it } from 'vitest'
import { addEntry, closeEntry, createGroup, createSplit, setSplitLayout, splitBeside, splitOf, swapSplitPanes, unsplitEntry } from '../host/model.ts'
import { insertPane, layoutTree, leaves, parseLayout, tidy } from '../host/split.ts'
import type { SplitNode, Workspace } from '../shared/types.ts'

function ws(...names: string[]): Workspace {
  let w: Workspace = { id: 'w', name: 'W', color: 'green', entries: [], groups: [] }
  for (const name of names) {
    const pinned = name.startsWith('*')
    const title = name.replace('*', '')
    ;[w] = addEntry(w, { url: `https://${title}.test/`, title }, { pinned })
  }
  return w
}
const id = (w: Workspace, title: string): string => w.entries.find((e) => e.title === title)!.id
const ids = (w: Workspace, ...titles: string[]): string[] => titles.map((t) => id(w, t))
const titles = (w: Workspace): string[] => w.entries.map((e) => (e.pinned ? '*' : '') + e.title + (e.groupId ? '[F]' : ''))
const named = (w: Workspace, n: SplitNode): unknown =>
  'entryId' in n
    ? `${w.entries.find((e) => e.id === n.entryId)?.title}:${Math.round(n.size)}`
    : { [n.direction]: Math.round(n.size), children: n.children.map((c) => named(w, c)) }

describe('layout trees', () => {
  it('builds Zen layouts', () => {
    expect(layoutTree(['a', 'b'], 'grid')).toEqual({
      direction: 'row',
      size: 100,
      children: [
        { entryId: 'a', size: 50 },
        { entryId: 'b', size: 50 }
      ]
    })
    const grid = layoutTree(['a', 'b', 'c'], 'grid')
    expect(grid).toMatchObject({
      direction: 'row',
      children: [{ direction: 'column', size: 50, children: [{ entryId: 'a' }, { entryId: 'b' }] }, { entryId: 'c', size: 50 }]
    })
    expect(layoutTree(['a', 'b', 'c'], 'hsep')).toMatchObject({ direction: 'column', children: [{ size: 100 / 3 }, {}, {}] })
  })

  it('tidies: removes panes, collapses single children, flattens same-direction nesting, rescales', () => {
    const t: SplitNode = {
      direction: 'row',
      size: 100,
      children: [
        { entryId: 'a', size: 50 },
        { direction: 'column', size: 50, children: [{ entryId: 'b', size: 50 }, { entryId: 'c', size: 50 }] }
      ]
    }
    expect(tidy(t, (x) => x !== 'c')).toEqual({
      direction: 'row',
      size: 100,
      children: [
        { entryId: 'a', size: 50 },
        { entryId: 'b', size: 50 }
      ]
    })
    expect(tidy(t, (x) => x === 'a')).toEqual({ entryId: 'a', size: 100 })
    expect(tidy(t, () => false)).toBeUndefined()
    const flat = tidy(t, (x) => x !== 'a')!
    expect(flat).toMatchObject({ direction: 'column', children: [{ entryId: 'b', size: 50 }, { entryId: 'c', size: 50 }] })
  })

  it('inserts beside a pane (taking half of it) or beside the whole split', () => {
    const two = layoutTree(['a', 'b'], 'vsep')
    const right = insertPane(two, 'c', 'right', 'b')
    expect(right).toMatchObject({ direction: 'row', children: [{ entryId: 'a', size: 50 }, { entryId: 'b', size: 25 }, { entryId: 'c', size: 25 }] })
    const below = insertPane(two, 'c', 'bottom', 'a')
    expect(below).toMatchObject({
      direction: 'row',
      children: [{ direction: 'column', size: 50, children: [{ entryId: 'a' }, { entryId: 'c' }] }, { entryId: 'b' }]
    })
    const top = insertPane(two, 'c', 'top')
    expect(top).toMatchObject({ direction: 'column', children: [{ entryId: 'c' }, { direction: 'row' }] })
    expect(leaves(top)).toEqual(['c', 'a', 'b'])
    // Moving a pane that is already in the tree.
    expect(leaves(insertPane(two, 'a', 'right', 'b'))).toEqual(['b', 'a'])
  })

  it('parses only well-formed trees', () => {
    expect(parseLayout({ direction: 'row', size: 100, children: [{ entryId: 'a', size: 50 }, { entryId: 'b' }] })).toBeTruthy()
    expect(parseLayout({ direction: 'diagonal', children: [] })).toBeUndefined()
    expect(parseLayout({ direction: 'row', children: [{ nope: 1 }] })).toBeUndefined()
  })
})

describe('splits in a workspace', () => {
  it('joins tabs where the first one is, in its section and folder', () => {
    let w = ws('*p', 'a', 'b', 'c')
    ;[w] = createGroup(w, [id(w, 'a')], 'F')
    let sid: string | undefined
    ;[w, sid] = createSplit(w, ids(w, 'a', 'c'))
    expect(sid).toBeTruthy()
    expect(titles(w)).toEqual(['*p', 'a[F]', 'c[F]', 'b'])
    expect(named(w, splitOf(w, id(w, 'c'))!.layout)).toEqual({ row: 100, children: ['a:50', 'c:50'] })
  })

  it('adds tabs to an existing split, up to four, and relayouts', () => {
    let w = ws('a', 'b', 'c', 'd', 'e')
    ;[w] = createSplit(w, ids(w, 'a', 'b'))
    let sid: string | undefined
    ;[w, sid] = createSplit(w, ids(w, 'c', 'a', 'd', 'e'), 'vsep')
    expect(w.splits).toHaveLength(1)
    expect(leaves(splitOf(w, id(w, 'a'))!.layout)).toEqual(ids(w, 'a', 'b', 'c', 'd'))
    w = setSplitLayout(w, sid!, 'hsep')
    expect(splitOf(w, id(w, 'a'))!.layout).toMatchObject({ direction: 'column' })
  })

  it('splits beside a tab by dropping, and moves panes within a split', () => {
    let w = ws('a', 'b', 'c')
    w = splitBeside(w, id(w, 'c'), id(w, 'a'), 'left')
    // Where a was, in the order the panes read.
    expect(titles(w)).toEqual(['c', 'a', 'b'])
    expect(named(w, w.splits![0].layout)).toEqual({ row: 100, children: ['c:50', 'a:50'] })
    w = splitBeside(w, id(w, 'b'), id(w, 'a'), 'bottom')
    expect(named(w, w.splits![0].layout)).toEqual({ row: 100, children: ['c:50', { column: 50, children: ['a:50', 'b:50'] }] })
    w = swapSplitPanes(w, id(w, 'c'), id(w, 'b'))
    expect(named(w, w.splits![0].layout)).toEqual({ row: 100, children: ['b:50', { column: 50, children: ['a:50', 'c:50'] }] })
    expect(titles(w)).toEqual(['b', 'a', 'c'])
  })

  it('dissolves a split left with one tab, by unsplitting or closing', () => {
    let w = ws('a', 'b', 'c')
    ;[w] = createSplit(w, ids(w, 'a', 'b', 'c'))
    w = unsplitEntry(w, id(w, 'b'))
    expect(leaves(w.splits![0].layout)).toEqual(ids(w, 'a', 'c'))
    w = closeEntry(w, id(w, 'c'))
    expect(w.splits).toBeUndefined()
  })

  it('keeps a split whole: a resized tree with other panes is refused', () => {
    let w = ws('a', 'b', 'c')
    let sid: string | undefined
    ;[w, sid] = createSplit(w, ids(w, 'a', 'b'))
    const before = w
    w = setSplitLayout(w, sid!, { direction: 'row', size: 100, children: [{ entryId: id(w, 'a'), size: 30 }, { entryId: id(w, 'c'), size: 70 }] })
    expect(w).toBe(before)
    w = setSplitLayout(w, sid!, { direction: 'row', size: 100, children: [{ entryId: id(w, 'a'), size: 30 }, { entryId: id(w, 'b'), size: 70 }] })
    expect(named(w, w.splits![0].layout)).toEqual({ row: 100, children: ['a:30', 'b:70'] })
  })
})
