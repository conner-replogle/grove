import { describe, expect, it } from 'vitest'
import * as M from '../host/model.ts'
import { applyOrganize, looseTabs, prepare, sendableUrl } from '../host/organize.ts'
import { CLEF, NAMER, checkRequest, organize, type AiRunner } from '../sync-worker/src/organize.ts'
import { MemoryStore, ORGANIZE_PER_HOUR, Room } from '../sync-worker/src/room.ts'
import type { OrganizeRequest } from '../shared/organize-protocol.ts'
import type { Workspace } from '../shared/types.ts'

// A fake Workers AI: Clef answers from `picks` (tab id -> [choice, probability]),
// the namer with `folders`. Records what each model was asked.
function fakeAi(picks: Record<string, [string, number]>, folders: unknown = { folders: [] }) {
  const calls: { model: string; input: any }[] = []
  const ai: AiRunner = {
    async run(model, input: any) {
      calls.push({ model, input })
      if (model === CLEF) {
        const answers: Record<string, unknown> = {}
        for (const id of Object.keys(input.questions)) {
          const [choice, p] = picks[id] ?? ['new', 0.9]
          answers[id] = { type: 'choice', choice, probabilities: { [choice]: p }, confidence: p }
        }
        return { answers }
      }
      return { response: folders }
    }
  }
  return { ai, calls }
}

const req = (folders: string[], tabs: string[]): OrganizeRequest => ({
  folders: folders.map((title, i) => ({ id: `f${i}`, title, examples: [] })),
  tabs: tabs.map((title, i) => ({ id: `t${i}`, title, url: `${title.toLowerCase()}.test` }))
})

describe('organize (server)', () => {
  it('files sure picks, leaves unsure ones, and names folders for the rest', async () => {
    const { ai, calls } = fakeAi(
      { t0: ['f0', 0.9], t1: ['f0', 0.4], t2: ['new', 0.8], t3: ['new', 0.7], t4: ['new', 0.9] },
      { folders: [{ title: 'Japan Trip', tabs: ['t2', 't3', 't0'] }, { title: 'Lonely', tabs: ['t4'] }] }
    )
    const out = await organize(ai, req(['Work'], ['Jira', 'Docs', 'Flights', 'Hotels', 'Recipe']))
    expect(out.assign).toEqual({ t0: 'f0' })
    // t0 was already filed, so the namer can't take it; one-tab folders go.
    expect(out.create).toEqual([{ title: 'Japan Trip', tabs: ['t2', 't3'] }])
    expect(calls.map((c) => c.model)).toEqual([CLEF, NAMER])
    expect(Object.keys(calls[0].input.questions)).toEqual(['t0', 't1', 't2', 't3', 't4'])
    expect(Object.keys(calls[0].input.questions.t0.criteria)).toEqual(['f0', 'new'])
  })

  it('skips Clef when there are no folders, and the namer with one tab left', async () => {
    const a = fakeAi({}, { folders: [{ title: 'News', tabs: ['t0', 't1'] }] })
    expect(await organize(a.ai, req([], ['BBC', 'NYT']))).toEqual({ assign: {}, create: [{ title: 'News', tabs: ['t0', 't1'] }] })
    expect(a.calls.map((c) => c.model)).toEqual([NAMER])

    const b = fakeAi({ t0: ['f0', 0.9], t1: ['new', 0.9] })
    expect(await organize(b.ai, req(['Work'], ['Jira', 'BBC']))).toEqual({ assign: { t0: 'f0' }, create: [] })
    expect(b.calls.map((c) => c.model)).toEqual([CLEF])
  })

  it('joins a made-up folder that has an existing name, and merges same-named ones', async () => {
    const { ai } = fakeAi(
      { t0: ['new', 0.9], t1: ['new', 0.9], t2: ['new', 0.9], t3: ['new', 0.9] },
      JSON.stringify({
        folders: [
          { title: 'work', tabs: ['t0'] },
          { title: 'Cooking', tabs: ['t1', 't2'] },
          { title: 'cooking', tabs: ['t3', 'bogus'] }
        ]
      })
    )
    const out = await organize(ai, req(['Work'], ['Jira', 'Pasta', 'Soup', 'Bread']))
    expect(out.assign).toEqual({ t0: 'f0' })
    expect(out.create).toEqual([{ title: 'Cooking', tabs: ['t1', 't2', 't3'] }])
  })

  it('asks Clef 64 tabs at a time', async () => {
    const { ai, calls } = fakeAi({})
    const tabs = Array.from({ length: 100 }, (_, i) => `Tab${i}`)
    await organize(ai, req(['Work'], tabs))
    expect(calls.filter((c) => c.model === CLEF).map((c) => Object.keys(c.input.questions).length)).toEqual([64, 36])
  })

  it('turns away malformed requests', () => {
    expect(() => checkRequest({ tabs: [] })).toThrow()
    expect(() => checkRequest({ folders: [], tabs: [{ id: 't0', title: 1, url: '' }] })).toThrow()
    expect(checkRequest(req(['A'], ['x'])).tabs).toHaveLength(1)
  })
})

describe('organize (room)', () => {
  it("takes only the account's token, and only so often", async () => {
    const store = new MemoryStore()
    const room = new Room(store)
    expect(await room.authorize('x'.repeat(30))).toBe(false)
    const peer = { send() {}, close() {}, authed: false }
    await room.message(peer, JSON.stringify({ t: 'hello', v: 1, token: 'x'.repeat(30), cursor: 0 }), [peer])
    expect(await room.authorize('x'.repeat(30))).toBe(true)
    expect(await room.authorize('y'.repeat(30))).toBe(false)
    expect(await room.authorize(undefined)).toBe(false)
    const now = 10 * 3_600_000
    for (let i = 0; i < ORGANIZE_PER_HOUR; i++) expect(room.takeOrganize(now)).toBe(true)
    expect(room.takeOrganize(now + 1000)).toBe(false)
    expect(room.takeOrganize(now + 3_600_000)).toBe(true)
  })
})

describe('organize (host)', () => {
  function workspace(): Workspace {
    let ws = M.emptyModel().workspaces[0]
    for (const [title, url, pinned] of [
      ['Pin', 'https://pin.test/', true],
      ['Jira', 'https://jira.test/browse/X-1?q=secret#frag', false],
      ['Flights', 'https://flights.test/', false],
      ['Hotels', 'https://hotels.test/', false],
      ['New Tab', 'chrome://newtab/', false]
    ] as const) {
      ws = M.addEntry(ws, { url, title }, { pinned })[0]
    }
    return M.createGroup(ws, [ws.entries.find((e) => e.title === 'Jira')!.id], 'Work')[0]
  }

  it('sends loose web tabs without queries, and folders with examples', () => {
    expect(sendableUrl('https://jira.test/browse/X-1?q=secret#frag')).toBe('jira.test/browse/X-1')
    expect(sendableUrl('chrome://newtab/')).toBeUndefined()
    const ws = workspace()
    const { request } = prepare(ws, looseTabs(ws))
    expect(request.folders).toEqual([{ id: 'f0', title: 'Work', examples: ['Jira'] }])
    expect(request.tabs.map((t) => t.url)).toEqual(['flights.test', 'hotels.test'])
  })

  it('files tabs into folders, old and new, skipping ones that changed meanwhile', () => {
    let ws = workspace()
    const { request, ids } = prepare(ws, looseTabs(ws))
    expect(request.tabs.map((t) => t.title)).toEqual(['Flights', 'Hotels'])
    const answer = { assign: { t0: 'f0' }, create: [{ title: 'Trip', tabs: ['t0', 't1'] }] }
    ws = applyOrganize(ws, answer, ids)
    const groupOf = (title: string) => ws.groups.find((g) => g.id === ws.entries.find((e) => e.title === title)!.groupId)?.title
    expect(groupOf('Flights')).toBe('Work')
    // Only Hotels was still loose: no one-tab folder.
    expect(groupOf('Hotels')).toBeUndefined()
    expect(ws.groups.map((g) => g.title)).toEqual(['Work'])

    let ws2 = workspace()
    const p2 = prepare(ws2, looseTabs(ws2))
    ws2 = applyOrganize(ws2, { assign: {}, create: [{ title: 'Trip', tabs: ['t0', 't1'] }] }, p2.ids)
    expect(ws2.groups.map((g) => g.title)).toEqual(['Work', 'Trip'])
    expect(ws2.entries.filter((e) => e.groupId === ws2.groups[1].id).map((e) => e.title)).toEqual(['Flights', 'Hotels'])
  })
})
