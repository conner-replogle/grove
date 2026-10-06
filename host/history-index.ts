// Grove's own history suggestions for the URL bar.
//
// Webium's URL bar is Chrome's New Tab page searchbox (the "realbox"), and
// Chrome ranks results there for searching: every history match counts for
// a tenth of its score (components/omnibox/browser/match_compare.h), so
// Google's suggestions push sites the user visits all the time off the list,
// and typing "watch." never offers watch.example.com. Grove keeps an index
// of the profile's history (from chrome.history, through the bridge) and
// suggests from it itself, as Firefox and Zen do: the site the input starts
// is filled in ("autofill"), and pages whose address or title match follow,
// ranked by frecency (visits, typed visits and how recent they are).
import type { HistorySuggestion } from '../shared/protocol.ts'

export type { HistorySuggestion }

export interface HistoryItem {
  url: string
  title?: string
  visitCount?: number
  typedCount?: number
  // Milliseconds since the epoch.
  lastVisitTime?: number
}

interface Page {
  url: string
  title: string
  host: string // lowercase, without "www."
  // The address as the URL bar shows it: no scheme, no "www.".
  bare: string
  visits: number
  typed: number
  last: number
  scheme: string
}

const DAY = 86_400_000

// Firefox's frecency buckets, roughly: recent visits count for more.
function recency(last: number, now: number): number {
  const age = now - last
  if (age < 4 * DAY) return 100
  if (age < 14 * DAY) return 70
  if (age < 31 * DAY) return 50
  if (age < 90 * DAY) return 30
  return 10
}

// A typed visit says more than a followed link.
function frecency(p: Page, now: number): number {
  return (p.visits + 2 * p.typed) * recency(p.last, now)
}

// What the URL bar's text means as an address: lowercase, without a scheme
// or "www." (so "https://www.Watch.ex" and "watch.ex" are the same).
export function normalizeInput(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '')
}

function parse(item: HistoryItem): Page | undefined {
  let u: URL
  try {
    u = new URL(item.url)
  } catch {
    return undefined
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  const port = u.port ? `:${u.port}` : ''
  const rest = `${u.pathname}${u.search}${u.hash}`
  return {
    url: item.url,
    title: item.title ?? '',
    host,
    bare: `${host}${port}${rest}`,
    visits: item.visitCount ?? 0,
    typed: item.typedCount ?? 0,
    last: item.lastVisitTime ?? 0,
    scheme: u.protocol
  }
}

export class HistoryIndex {
  private readonly pages = new Map<string, Page>()

  get size(): number {
    return this.pages.size
  }

  load(items: HistoryItem[]): void {
    this.pages.clear()
    for (const item of items) this.visit(item)
  }

  // A visit (chrome.history.onVisited carries the page's new counts).
  visit(item: HistoryItem): void {
    const page = parse(item)
    if (page) this.pages.set(page.url, page)
  }

  remove(urls: string[]): void {
    for (const url of urls) this.pages.delete(url)
  }

  clear(): void {
    this.pages.clear()
  }

  // Suggestions for what the user typed, best first: at most one autofill
  // (a site the input is the start of), then pages matching every word.
  suggest(input: string, now = Date.now(), max = 4): HistorySuggestion[] {
    const typed = normalizeInput(input)
    if (!typed) return []
    const out: HistorySuggestion[] = []
    const autofill = /\s/.test(typed) ? undefined : this.autofill(typed, now)
    if (autofill) out.push(autofill)

    const words = typed.split(/\s+/).filter(Boolean)
    const ranked = [...this.pages.values()]
      .filter((p) => p.url !== autofill?.url)
      .filter((p) => {
        const hay = `${p.bare} ${p.title.toLowerCase()}`
        return words.every((w) => hay.includes(w))
      })
      .map((p) => ({ p, score: frecency(p, now) * (p.bare.startsWith(typed) || p.host.startsWith(typed) ? 4 : 1) }))
      .sort((a, b) => b.score - a.score)
    const seen = new Set(out.map((s) => s.url))
    for (const { p } of ranked) {
      if (out.length >= max) break
      if (seen.has(p.url)) continue
      seen.add(p.url)
      out.push({ url: p.url, title: p.title, text: p.bare, autofill: false })
    }
    return out
  }

  // The site to fill in, if the input starts a site's address the user
  // goes to (Firefox's origin autofill). Typed past the host ("site.com/pa"),
  // it fills in the most frecent page under it.
  private autofill(typed: string, now: number): HistorySuggestion | undefined {
    const slash = typed.indexOf('/')
    if (slash < 0) {
      // Sites (hosts) the input starts, by their pages' total frecency.
      const hosts = new Map<string, { score: number; visits: number; typed: number; https: number; root?: Page; top?: Page }>()
      for (const p of this.pages.values()) {
        if (!p.host.startsWith(typed)) continue
        const h = hosts.get(p.host) ?? { score: 0, visits: 0, typed: 0, https: 0 }
        h.score += frecency(p, now)
        h.visits += p.visits
        h.typed += p.typed
        if (p.scheme === 'https:') h.https += p.visits + 1
        else h.https -= p.visits + 1
        const isRoot = p.bare === `${p.host}/` || p.bare === p.host
        if (isRoot && (!h.root || frecency(p, now) > frecency(h.root, now))) h.root = p
        if (!h.top || frecency(p, now) > frecency(h.top, now)) h.top = p
        hosts.set(p.host, h)
      }
      let best: [string, typeof hosts extends Map<string, infer V> ? V : never] | undefined
      for (const entry of hosts) {
        // A site visited once, by a link, isn't one the user goes to.
        if (entry[1].visits < 2 && entry[1].typed < 1) continue
        if (!best || entry[1].score > best[1].score) best = entry
      }
      if (!best) return undefined
      const [host, h] = best
      const url = h.root?.url ?? `${h.https >= 0 ? 'https' : 'http'}://${host}/`
      return { url, title: h.root?.title ?? h.top?.title ?? '', text: host, autofill: true }
    }
    // A page under a path the input starts.
    let best: Page | undefined
    for (const p of this.pages.values()) {
      if (!p.bare.startsWith(typed) || (p.visits < 2 && p.typed < 1)) continue
      if (!best || frecency(p, now) > frecency(best, now)) best = p
    }
    return best && { url: best.url, title: best.title, text: best.bare, autofill: true }
  }
}
