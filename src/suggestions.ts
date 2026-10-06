// Grove's history suggestions in Webium's URL bar (see host/history-index.ts
// for why Chrome's own fall short there).
//
// Chrome's results reach the searchbox through its `result` property; Grove
// puts its own suggestions into each result as it is set: an autofill (the
// site the input starts, filled in as the user types) first, and pages from
// history ahead of the search suggestions. Opening and removing matches
// goes to the browser by the match's position in Chrome's result, so the
// searchbox's page handler is wrapped to translate positions, and to open
// or forget Grove's own matches through the host.
import type { HistorySuggestion } from '../shared/protocol.ts'
import { onSuggestions, send } from './host-client'
import { enterAlsoWaitsFor, isNewTabSearch, searchbox } from './urlbar'

// A match as Webium's searchbox reads it (searchbox.mojom AutocompleteMatch).
type Match = Record<string, unknown> & { destinationUrl: string; allowedToBeDefaultMatch?: boolean; type?: string }
interface Result {
  queryId: number
  input: string
  matches: Match[]
  [key: string]: unknown
}
type Handler = Record<string, (...a: unknown[]) => unknown>
interface Box extends HTMLElement {
  result: Result | null
  lastQueriedInput: string | null
  activeQueryId: number
  selectedMatchIndex: number
  pageHandler(): Handler
  onAutocompleteResultChanged(r: Result): void
  getInputElement(): { preventInlineAutocomplete(input: string): boolean }
}

// Where each shown match came from: a position in Chrome's result, or Grove's.
type Source = { chrome: number } | { grove: HistorySuggestion }

const MAX_MATCHES = 10
const wired = new WeakSet<Element>()

export function suggestFromHistory(): void {
  let latest: { input: string; list: HistorySuggestion[] } | undefined
  let box: Box | undefined
  let chromeResult: Result | null = null
  let sources: Source[] = []
  // The last text the host was asked about.
  let asked: string | undefined
  enterAlsoWaitsFor(() => asked === undefined || latest?.input === asked)

  const wire = (): void => {
    const el = searchbox() as unknown as Box | null
    if (!el || wired.has(el)) return
    wired.add(el)
    box = el
    // Lit keeps `result` as an accessor on the class; this one on the
    // element merges Grove's suggestions into every result Chrome sets.
    let proto: object | null = Object.getPrototypeOf(el)
    let desc: PropertyDescriptor | undefined
    while (proto && !(desc = Object.getOwnPropertyDescriptor(proto, 'result'))) proto = Object.getPrototypeOf(proto)
    if (!desc?.set || !desc.get) return
    const { get, set } = desc
    Object.defineProperty(el, 'result', {
      configurable: true,
      get() {
        return get.call(this)
      },
      set(value: Result | null) {
        chromeResult = value
        const [merged, from] = merge(value, latest, el)
        sources = from
        set.call(this, merged)
      }
    })
    const own = el.pageHandler.bind(el)
    el.pageHandler = () => translate(own(), () => sources, forget)
    el.addEventListener('query-autocomplete', (e) => {
      const input = (e as CustomEvent<{ inputValue: string }>).detail?.inputValue ?? ''
      if (input.trim()) {
        asked = input
        send({ type: 'suggest', input })
      } else {
        asked = undefined
        latest = undefined
      }
    })
  }

  // The remove button on one of Grove's suggestions.
  const forget = (s: HistorySuggestion): void => {
    send({ type: 'forgetUrl', url: s.url })
    if (latest) latest = { ...latest, list: latest.list.filter((x) => x.url !== s.url) }
    if (box && chromeResult) box.result = chromeResult
  }

  onSuggestions((input, list) => {
    wire()
    latest = { input, list }
    if (!box || !chromeResult || chromeResult.input !== input || chromeResult.queryId !== box.activeQueryId) return
    // Chrome's results for this text came first: show them again with
    // Grove's, and let the searchbox pick the default (and fill it in) as
    // it does for a new result, unless the user has moved off the first row.
    if (box.selectedMatchIndex > 0) box.result = chromeResult
    else box.onAutocompleteResultChanged(chromeResult)
  })

  const tryWire = (): void => {
    wire()
    if (!box) requestAnimationFrame(tryWire)
  }
  tryWire()
}

function merge(result: Result | null, latest: { input: string; list: HistorySuggestion[] } | undefined, box: Box): [Result | null, Source[]] {
  const identity = (r: Result | null): Source[] => (r?.matches ?? []).map((_, i) => ({ chrome: i }))
  if (!result || !latest || latest.input !== result.input || !latest.list.length) return [result, identity(result)]
  const typed = result.input
  const bare = normalize(typed)
  // Backspace, a paste, or a caret moved back: no filling in (Chrome's rule).
  const mayFill = !/\s$/.test(typed) && !box.getInputElement().preventInlineAutocomplete(typed)
  const template = result.matches[0]
  const chrome = result.matches.map((m, i) => ({ m, src: { chrome: i } as Source }))

  const autofill = latest.list.find((s) => s.autofill && s.text.startsWith(bare))
  const others = latest.list.filter((s) => s !== autofill)
  const chromeUrls = new Set(result.matches.map((m) => m.destinationUrl))
  const groveRows = others
    .filter((s) => !chromeUrls.has(s.url))
    .map((s) => ({ m: toMatch(s, typed, bare, false, template), src: { grove: s } as Source }))

  let rows: { m: Match; src: Source }[]
  if (autofill) {
    const fill = { m: toMatch(autofill, typed, bare, mayFill, template), src: { grove: autofill } as Source }
    const rest = chrome.filter((r) => r.m.destinationUrl !== autofill.url)
    rows = mayFill ? [fill, ...groveRows, ...rest] : [...rest.slice(0, 1), fill, ...groveRows, ...rest.slice(1)]
  } else {
    rows = [...chrome.slice(0, 1), ...groveRows, ...chrome.slice(1)]
  }
  rows = rows.slice(0, Math.max(MAX_MATCHES, result.matches.length))
  return [{ ...result, matches: rows.map((r) => r.m) }, rows.map((r) => r.src)]
}

// Like host/history-index.ts normalizeInput.
function normalize(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '')
}

// One of Grove's suggestions as a history match of Chrome's would look.
function toMatch(s: HistorySuggestion, typed: string, bare: string, fill: boolean, template: Match | undefined): Match {
  const inline = fill && s.autofill && s.text.startsWith(bare) ? s.text.slice(bare.length) : ''
  const prefix = s.text.startsWith(bare) ? bare.length : 0
  const title = s.title || s.text
  return {
    ...(template ?? {}),
    isHidden: false,
    a11yLabel: `${title} ${s.text} location from history`,
    allowedToBeDefaultMatch: fill,
    actions: [],
    answer: null,
    // URL classification: the typed part matched (3 = URL | MATCH), the rest a URL (1).
    contents: s.text,
    contentsClass: prefix ? [{ offset: 0, style: 3 }, { offset: prefix, style: 1 }] : [{ offset: 0, style: 1 }],
    description: s.title,
    descriptionClass: [{ offset: 0, style: 0 }],
    destinationUrl: s.url,
    inlineAutocompletion: inline,
    fillIntoEdit: fill ? typed + inline : s.url,
    isWeatherAnswerSuggestion: null,
    iconPath: '//resources/cr_components/searchbox/icons/page_cr23.svg',
    iconUrl: '',
    imageDominantColor: '',
    imageUrl: '',
    isContextualSuggestion: false,
    isNoncannedAimSuggestion: false,
    isRichSuggestion: false,
    isSearchType: false,
    isEnterpriseSearchAggregatorPeopleType: false,
    type: 'history-url',
    removeButtonA11yLabel: `Remove Suggestion button, press Enter to remove, ${title} ${s.text} location from history`,
    swapContentsAndDescription: !!s.title,
    suggestionGroupId: -1,
    supportsDeletion: true,
    tailSuggestCommonPrefix: '',
    keywordModel: null
  }
}

// The searchbox's page handler, with match positions mapped back to
// Chrome's result; Grove's own matches open (or are forgotten) through the
// host.
function translate(handler: Handler, sources: () => Source[], forget: (s: HistorySuggestion) => void): Handler {
  const at = (line: unknown): Source | undefined => sources()[line as number]
  return new Proxy(handler, {
    get(target, key) {
      const value = Reflect.get(target, key) as unknown
      if (typeof value !== 'function') return value
      const call = (...a: unknown[]): unknown => (value as (...a: unknown[]) => unknown).apply(target, a)
      if (key === 'openAutocompleteMatch') {
        return (line: unknown, url: unknown, showing: unknown, button: unknown, mods: unknown, ...rest: unknown[]) => {
          const src = at(line)
          if (src && 'grove' in src) {
            const m = (mods ?? {}) as { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }
            const newTab = isNewTabSearch() || !!(m.ctrlKey || m.metaKey || m.shiftKey) || button === 1
            send({ type: 'open', url: src.grove.url, newTab })
            return
          }
          return call(src ? src.chrome : line, url, showing, button, mods, ...rest)
        }
      }
      if (key === 'deleteAutocompleteMatch') {
        return (line: unknown, ...rest: unknown[]) => {
          const src = at(line)
          if (src && 'grove' in src) return forget(src.grove)
          return call(src ? src.chrome : line, ...rest)
        }
      }
      if (key === 'onNavigationLikely') {
        return (line: unknown, ...rest: unknown[]) => {
          const src = at(line)
          if (src && 'grove' in src) return
          return call(src ? src.chrome : line, ...rest)
        }
      }
      return call
    }
  })
}
