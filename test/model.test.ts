import { describe, expect, it } from 'vitest'
import {
  activateEntry,
  addEntry,
  closeEntries,
  closeEntry,
  createGroup,
  createWorkspace,
  deleteWorkspace,
  emptyModel,
  getWorkspace,
  moveEntry,
  moveWorkspace,
  neighborWorkspace,
  normalize,
  placeEntry,
  placeGroup,
  recolorWorkspace,
  renameWorkspace,
  setEntryGroup,
  setPinned,
  transferEntry,
  ungroup,
  updateEntry,
  updateGroup,
  withWorkspace,
  workspaceOfEntry
} from '../host/model.ts'
import type { Workspace } from '../shared/types.ts'

// A workspace with tabs titled by `names`; a leading '*' pins one.
function ws(...names: string[]): Workspace {
  let w: Workspace = { id: 'w', name: 'W', color: 'green', entries: [], groups: [] }
  for (const name of names) {
    const pinned = name.startsWith('*')
    const title = name.replace('*', '')
    ;[w] = addEntry(w, { url: `https://${title}.test/`, title }, { pinned })
  }
  return w
}

const titles = (w: Workspace): string[] =>
  w.entries.map(
    (e) => (e.pinned ? '*' : '') + e.title + (e.groupId ? `[${group(w, e.groupId)}]` : '')
  )
const group = (w: Workspace, id: string): string => w.groups.find((g) => g.id === id)!.title
const id = (w: Workspace, title: string): string => w.entries.find((e) => e.title === title)!.id

describe('workspaces', () => {
  it('starts with one Home workspace', () => {
    const m = emptyModel()
    expect(m.workspaces.map((w) => w.name)).toEqual(['Home'])
    expect(m.lastActiveWorkspaceId).toBe(m.workspaces[0].id)
  })

  it('creates with a default name and an unused color', () => {
    const [m, wid] = createWorkspace(emptyModel())
    const w = getWorkspace(m, wid)
    expect(w.name).toBe('Workspace 2')
    expect(w.color).not.toBe('green')
  })

  it('renames, ignoring blank names, and recolors', () => {
    const m0 = emptyModel()
    const wid = m0.workspaces[0].id
    const m1 = renameWorkspace(m0, wid, '  Work ')
    expect(getWorkspace(m1, wid).name).toBe('Work')
    expect(renameWorkspace(m1, wid, '   ')).toBe(m1)
    expect(getWorkspace(recolorWorkspace(m1, wid, 'blue'), wid).color).toBe('blue')
  })

  it('reorders', () => {
    let m = emptyModel()
    ;[m] = createWorkspace(m, 'B')
    ;[m] = createWorkspace(m, 'C')
    const c = m.workspaces[2].id
    expect(moveWorkspace(m, c, 0).workspaces.map((w) => w.name)).toEqual(['C', 'Home', 'B'])
    expect(moveWorkspace(m, c, 99).workspaces.map((w) => w.name)).toEqual(['Home', 'B', 'C'])
  })

  it('deletes, but never the last one, and moves lastActive to a neighbor', () => {
    const m0 = emptyModel()
    expect(deleteWorkspace(m0, m0.workspaces[0].id)).toBe(m0)
    const [m1, b] = createWorkspace(m0, 'B')
    const m2 = deleteWorkspace({ ...m1, lastActiveWorkspaceId: b }, b)
    expect(m2.workspaces.map((w) => w.name)).toEqual(['Home'])
    expect(m2.lastActiveWorkspaceId).toBe(m2.workspaces[0].id)
  })

  it('finds neighbors with wraparound', () => {
    let m = emptyModel()
    ;[m] = createWorkspace(m, 'B')
    const [home, b] = m.workspaces.map((w) => w.id)
    expect(neighborWorkspace(m, home, 1)).toBe(b)
    expect(neighborWorkspace(m, home, -1)).toBe(b)
    expect(neighborWorkspace(m, b, 1)).toBe(home)
  })

  it('withWorkspace normalizes and rejects unknown ids', () => {
    const m = emptyModel()
    expect(() => withWorkspace(m, 'nope', (w) => w)).toThrow()
  })
})

describe('entries', () => {
  it('adds at the end, after another entry, or pinned', () => {
    let w = ws('a', 'b')
    ;[w] = addEntry(w, { url: 'x', title: 'c' }, { afterId: id(w, 'a') })
    ;[w] = addEntry(w, { url: 'x', title: 'p' }, { pinned: true })
    ;[w] = addEntry(w, { url: 'x', title: 'z' })
    expect(titles(w)).toEqual(['*p', 'a', 'c', 'b', 'z'])
  })

  it('opens a new tab after a grouped opener inside its folder', () => {
    let w = ws('a', 'b')
    ;[w] = createGroup(w, [id(w, 'a')], 'F')
    ;[w] = addEntry(w, { url: 'x', title: 'c' }, { afterId: id(w, 'a') })
    expect(titles(w)).toEqual(['a[F]', 'c[F]', 'b'])
  })

  it('closing the active entry activates the most recent other one', () => {
    let w = ws('a', 'b', 'c')
    w = activateEntry(w, id(w, 'a'), 1)
    w = activateEntry(w, id(w, 'c'), 2)
    w = activateEntry(w, id(w, 'b'), 3)
    w = closeEntry(w, id(w, 'b'))
    expect(titles(w)).toEqual(['a', 'c'])
    expect(w.activeEntryId).toBe(id(w, 'c'))
  })

  it('closing an inactive entry keeps the active one', () => {
    let w = ws('a', 'b')
    w = activateEntry(w, id(w, 'a'))
    w = closeEntry(w, id(w, 'b'))
    expect(w.activeEntryId).toBe(id(w, 'a'))
  })

  it('closing everything leaves no active entry', () => {
    let w = ws('a', 'b')
    w = activateEntry(w, id(w, 'a'))
    w = closeEntries(
      w,
      w.entries.map((e) => e.id)
    )
    expect(w.entries).toEqual([])
    expect(w.activeEntryId).toBeUndefined()
  })

  it('updates url, title and history', () => {
    let w = ws('a')
    const history = [{ url: 'https://a.test/', title: 'A' }]
    w = updateEntry(w, id(w, 'a'), { title: 'A', history, historyIndex: 0 })
    expect(w.entries[0]).toMatchObject({ title: 'A', history, historyIndex: 0 })
  })

  it('moves by index among the others', () => {
    const w = ws('a', 'b', 'c')
    expect(titles(moveEntry(w, id(w, 'a'), { index: 2, pinned: false }))).toEqual(['b', 'c', 'a'])
    expect(titles(moveEntry(w, id(w, 'c'), { index: 0, pinned: false }))).toEqual(['c', 'a', 'b'])
  })

  it('moving into the pinned area pins; out of it unpins', () => {
    const w = ws('*p', 'a', 'b')
    expect(titles(moveEntry(w, id(w, 'b'), { index: 0, pinned: true }))).toEqual(['*b', '*p', 'a'])
    expect(titles(moveEntry(w, id(w, 'p'), { index: 2, pinned: false }))).toEqual(['a', 'b', 'p'])
  })

  it('pins at the end of the pinned tabs and unpins at the start of the rest', () => {
    let w = ws('*p', 'a', 'b')
    w = setPinned(w, id(w, 'b'), true)
    expect(titles(w)).toEqual(['*p', '*b', 'a'])
    w = setPinned(w, id(w, 'p'), false)
    expect(titles(w)).toEqual(['*b', 'p', 'a'])
    expect(setPinned(w, id(w, 'b'), true)).toBe(w)
  })

  it('pinning a tab takes it out of its folder', () => {
    let w = ws('a', 'b')
    ;[w] = createGroup(w, [id(w, 'a'), id(w, 'b')], 'F')
    w = setPinned(w, id(w, 'a'), true)
    expect(titles(w)).toEqual(['*a', 'b[F]'])
  })
})

describe('folders', () => {
  it('creates a folder in place of its first member, pulling members together', () => {
    let w = ws('a', 'b', 'c', 'd')
    ;[w] = createGroup(w, [id(w, 'b'), id(w, 'd')], 'F')
    expect(titles(w)).toEqual(['a', 'b[F]', 'd[F]', 'c'])
  })

  it('unpins tabs put into a folder', () => {
    let w = ws('*p', 'a')
    ;[w] = createGroup(w, [id(w, 'p')], 'F')
    expect(titles(w)).toEqual(['p[F]', 'a'])
  })

  it('renames, recolors and collapses, ignoring blank titles', () => {
    let w = ws('a')
    let gid: string
    ;[w, gid] = createGroup(w, [id(w, 'a')], 'F')
    w = updateGroup(w, gid, { title: 'Work', color: 'red', collapsed: true })
    expect(w.groups[0]).toMatchObject({ title: 'Work', color: 'red', collapsed: true })
    expect(updateGroup(w, gid, { title: ' ' })).toBe(w)
  })

  it('ungroups in place', () => {
    let w = ws('a', 'b', 'c')
    let gid: string
    ;[w, gid] = createGroup(w, [id(w, 'b'), id(w, 'c')], 'F')
    w = ungroup(w, gid)
    expect(titles(w)).toEqual(['a', 'b', 'c'])
    expect(w.groups).toEqual([])
  })

  it('moves a tab into a folder at its end, and out just below it', () => {
    let w = ws('a', 'b', 'c')
    let gid: string
    ;[w, gid] = createGroup(w, [id(w, 'b')], 'F')
    w = setEntryGroup(w, id(w, 'a'), gid)
    expect(titles(w)).toEqual(['b[F]', 'a[F]', 'c'])
    w = setEntryGroup(w, id(w, 'b'), undefined)
    expect(titles(w)).toEqual(['a[F]', 'b', 'c'])
  })

  it('drops a folder once its last tab closes', () => {
    let w = ws('a', 'b')
    ;[w] = createGroup(w, [id(w, 'a')], 'F')
    w = closeEntry(w, id(w, 'a'))
    expect(w.groups).toEqual([])
  })

  it("dropping a tab among a folder's tabs joins that folder", () => {
    let w = ws('a', 'b', 'c')
    let gid: string
    ;[w, gid] = createGroup(w, [id(w, 'a'), id(w, 'b')], 'F')
    w = moveEntry(w, id(w, 'c'), { index: 1, pinned: false, groupId: gid })
    expect(titles(w)).toEqual(['a[F]', 'c[F]', 'b[F]'])
  })
})

describe('normalize', () => {
  it('returns the same object when nothing needs fixing', () => {
    const w = ws('*p', 'a')
    expect(normalize(w)).toBe(w)
  })

  it('puts pinned first, gathers folders, drops dangling ids', () => {
    const base = ws('a', 'b', 'c', 'd')
    const g = { id: 'g', title: 'F', color: 'red' as const, collapsed: false }
    const e = base.entries
    const broken: Workspace = {
      ...base,
      groups: [g, { ...g, id: 'empty' }],
      activeEntryId: 'gone',
      entries: [
        { ...e[0], groupId: 'g' },
        e[1],
        { ...e[2], pinned: true, groupId: 'g' },
        { ...e[3], groupId: 'g' },
        { ...e[0], id: 'x', title: 'x', groupId: 'unknown' }
      ]
    }
    const w = normalize(broken)
    expect(titles(w)).toEqual(['*c', 'a[F]', 'd[F]', 'b', 'x'])
    expect(w.groups.map((x) => x.id)).toEqual(['g'])
    expect(w.activeEntryId).toBeUndefined()
  })
})

describe('across workspaces', () => {
  it('moves a tab to the end of another workspace, keeping its pin but not its folder', () => {
    let m = emptyModel()
    let b: string
    ;[m, b] = createWorkspace(m, 'B')
    const home = m.workspaces[0].id
    m = withWorkspace(m, home, () => ({ ...ws('*p', 'a', 'c'), id: home }))
    m = withWorkspace(m, b, (w) => addEntry(w, { url: 'x', title: 'z' })[0])
    let h = getWorkspace(m, home)
    ;[h] = createGroup(h, [id(h, 'a')], 'F')
    m = withWorkspace(m, home, () => h)
    m = transferEntry(m, id(h, 'a'), home, b)
    m = transferEntry(m, id(h, 'p'), home, b)
    expect(titles(getWorkspace(m, home))).toEqual(['c'])
    expect(getWorkspace(m, home).groups).toEqual([])
    expect(titles(getWorkspace(m, b))).toEqual(['*p', 'z', 'a'])
    expect(workspaceOfEntry(m, id(h, 'a'))?.id).toBe(b)
  })
})

describe('drag and drop', () => {
  // a, b in folder F, then c; x pinned.
  function tree(): Workspace {
    let w = ws('*x', 'a', 'b', 'c')
    ;[w] = createGroup(w, [id(w, 'a'), id(w, 'b')], 'F')
    return w
  }
  const gid = (w: Workspace): string => w.groups[0].id

  it('drops before an entry, taking its section', () => {
    const w = tree()
    expect(titles(placeEntry(w, id(w, 'c'), { beforeId: id(w, 'b'), pinned: false, groupId: gid(w) }))).toEqual([
      '*x',
      'a[F]',
      'c[F]',
      'b[F]'
    ])
    expect(titles(placeEntry(w, id(w, 'c'), { beforeId: id(w, 'x'), pinned: true }))).toEqual(['*c', '*x', 'a[F]', 'b[F]'])
  })

  it('drops at the end of a section', () => {
    const w = tree()
    expect(titles(placeEntry(w, id(w, 'c'), { pinned: true }))).toEqual(['*x', '*c', 'a[F]', 'b[F]'])
    expect(titles(placeEntry(w, id(w, 'c'), { pinned: false, groupId: gid(w) }))).toEqual(['*x', 'a[F]', 'b[F]', 'c[F]'])
    expect(titles(placeEntry(w, id(w, 'x'), { pinned: false }))).toEqual(['a[F]', 'b[F]', 'c', 'x'])
  })

  it('drops out of a folder, before it', () => {
    const w = tree()
    expect(titles(placeEntry(w, id(w, 'b'), { beforeId: id(w, 'a'), pinned: false }))).toEqual(['*x', 'b', 'a[F]', 'c'])
  })

  it('ignores a drop onto itself', () => {
    const w = tree()
    expect(placeEntry(w, id(w, 'c'), { beforeId: id(w, 'c'), pinned: false })).toBe(w)
  })

  it('moves a whole folder', () => {
    const w = tree()
    expect(titles(placeGroup(w, gid(w)))).toEqual(['*x', 'c', 'a[F]', 'b[F]'])
    const moved = placeGroup(w, gid(w))
    expect(titles(placeGroup(moved, gid(w), id(moved, 'c')))).toEqual(['*x', 'a[F]', 'b[F]', 'c'])
    expect(placeGroup(w, gid(w), id(w, 'b'))).toBe(w)
  })
})
