import { describe, expect, it } from 'vitest'
import { HistoryIndex, normalizeInput } from '../host/history-index.ts'

const now = Date.UTC(2026, 9, 6)
const day = 86_400_000
const at = (daysAgo: number) => now - daysAgo * day

// The case that prompted this: a site visited often, whose pages share a
// title, against search-like noise.
function index() {
  const i = new HistoryIndex()
  i.load([
    { url: 'https://watch.example.dev/', title: 'Jellyfin', visitCount: 9, typedCount: 8, lastVisitTime: at(0) },
    { url: 'http://watch.example.dev/', title: '', visitCount: 4, typedCount: 0, lastVisitTime: at(0) },
    { url: 'https://watch.example.dev/web/#/video', title: 'Jellyfin', visitCount: 36, lastVisitTime: at(0) },
    { url: 'https://watch.example.dev/web/#/home', title: 'Jellyfin', visitCount: 22, lastVisitTime: at(0) },
    { url: 'https://watchmojo.com/top-10', title: 'Top 10', visitCount: 1, lastVisitTime: at(1) },
    { url: 'https://www.watches.example/', title: 'Watches', visitCount: 3, lastVisitTime: at(200) },
    { url: 'https://news.example.org/a', title: 'A story about watch.example.dev', visitCount: 1, lastVisitTime: at(2) },
    { url: 'chrome://settings/', title: 'Settings', visitCount: 50, lastVisitTime: at(0) }
  ])
  return i
}

describe('normalizeInput', () => {
  it('drops scheme, www and case', () => {
    expect(normalizeInput('  HTTPS://www.Watch.ex ')).toBe('watch.ex')
    expect(normalizeInput('watch.')).toBe('watch.')
  })
})

describe('HistoryIndex.suggest', () => {
  it('fills in a frequently visited site from a partial host', () => {
    for (const typed of ['w', 'wat', 'watch', 'watch.', 'watch.ex', 'https://watch.', 'www.watch.e', 'WATCH.']) {
      const [first] = index().suggest(typed, now)
      expect(first, typed).toMatchObject({ autofill: true, text: 'watch.example.dev', url: 'https://watch.example.dev/' })
    }
  })

  it('prefers the more frecent of two sites the input starts', () => {
    const [first] = index().suggest('watche', now)
    expect(first).toMatchObject({ autofill: true, text: 'watches.example' })
  })

  it("doesn't fill in a site visited once by a link", () => {
    const i = new HistoryIndex()
    i.load([{ url: 'https://once.example/', visitCount: 1, typedCount: 0, lastVisitTime: at(0) }])
    expect(i.suggest('once', now)[0]?.autofill).toBe(false)
    i.visit({ url: 'https://once.example/', visitCount: 1, typedCount: 1, lastVisitTime: at(0) })
    expect(i.suggest('once', now)[0]?.autofill).toBe(true)
  })

  it('fills in a page when typed past the host', () => {
    const [first] = index().suggest('watch.example.dev/web/#/v', now)
    expect(first).toMatchObject({ autofill: true, url: 'https://watch.example.dev/web/#/video' })
  })

  it('matches titles and addresses by every word, frecent first', () => {
    const s = index().suggest('jellyfin', now)
    expect(s.every((x) => !x.autofill)).toBe(true)
    expect(s[0].url).toBe('https://watch.example.dev/web/#/video')
    expect(index().suggest('story watch', now).map((x) => x.url)).toEqual(['https://news.example.org/a'])
  })

  it('leaves out non-web pages and the autofilled page itself', () => {
    const s = index().suggest('watch.', now)
    expect(s.filter((x) => x.url === 'https://watch.example.dev/')).toHaveLength(1)
    expect(index().suggest('settings', now)).toEqual([])
  })

  it('shows a page in history as both http and https once, as https', () => {
    const i = new HistoryIndex()
    i.load([
      { url: 'http://docs.example.org/guide', title: '', visitCount: 1, typedCount: 1, lastVisitTime: at(0) },
      { url: 'https://docs.example.org/guide', title: 'Guide', visitCount: 1, lastVisitTime: at(0) }
    ])
    expect(i.suggest('guide', now)).toEqual([{ url: 'https://docs.example.org/guide', title: 'Guide', text: 'docs.example.org/guide', autofill: false }])
    // Nor an http copy of the autofilled site's root.
    expect(index().suggest('watch.', now).filter((x) => x.text.replace(/\/$/, '') === 'watch.example.dev')).toHaveLength(1)
  })

  it('forgets removed pages', () => {
    const i = index()
    i.remove(['https://watch.example.dev/', 'http://watch.example.dev/', 'https://watch.example.dev/web/#/video', 'https://watch.example.dev/web/#/home'])
    expect(i.suggest('watch.', now)[0]?.text).not.toBe('watch.example.dev')
  })
})
