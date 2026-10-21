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
import { patchMethod } from './patch'
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
  suggestWhenEmptied()
  let latest: { input: string; list: HistorySuggestion[] } | undefined
  let box: Box | undefined
  let chromeResult: Result | null = null
  let sources: Source[] = []
  // The last text the host was asked about.
  let asked: string | undefined
  // Whether each query (by id) may be filled in, as the searchbox decided
  // when it sent it. Asking the input again later is no good: its
  // "deleting" mark is cleared as soon as Chrome's result sets the text, so
  // Grove's suggestions arriving after it would fill in again what a
  // Backspace just deleted.
  const fillable = new Map<number, boolean>()
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
        const [merged, from] = merge(value, latest, value ? fillable.get(value.queryId) : undefined, el)
        sources = from
        set.call(this, merged)
      }
    })
    const own = el.pageHandler.bind(el)
    el.pageHandler = () =>
      translate(own(), () => sources, forget, (queryId, preventInline) => {
        fillable.set(queryId, !preventInline)
        for (const id of fillable.keys()) if (id < queryId - 20) fillable.delete(id)
      })
    el.addEventListener('query-autocomplete', (e) => {
      // An empty box too: the host answers with the most frecent pages.
      const input = (e as CustomEvent<{ inputValue: string }>).detail?.inputValue ?? ''
      asked = input
      send({ type: 'suggest', input })
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

// Chrome's searchbox drops its suggestions once what was typed is deleted,
// and asks for the empty box's (recent and frequent pages) only when the
// field gains focus. Asked again whenever the text goes empty, they come
// back: an empty URL bar always shows them.
function suggestWhenEmptied(): void {
  interface Searchbox extends HTMLElement {
    queryAutocomplete(input: string, preventInline: boolean, isOnFocus: boolean): void
    keywordModeManager_?: { isInKeywordMode?: boolean }
  }
  patchMethod<[CustomEvent<{ value: string }>], void, Searchbox>(
    'webui-browser-searchbox',
    'onSearchboxInputTextUpdated',
    function (original, e) {
      original(e)
      if (!e.detail?.value?.trim() && !this.keywordModeManager_?.isInKeywordMode) this.queryAutocomplete('', false, true)
    }
  )
}

function merge(
  result: Result | null,
  latest: { input: string; list: HistorySuggestion[] } | undefined,
  fillable: boolean | undefined,
  box: Box
): [Result | null, Source[]] {
  const identity = (r: Result | null): Source[] => (r?.matches ?? []).map((_, i) => ({ chrome: i }))
  if (!result || !latest || latest.input !== result.input || !latest.list.length) return [result, identity(result)]
  const typed = result.input
  const bare = normalize(typed)
  // Backspace, a paste, or a caret moved back: no filling in (Chrome's rule).
  const mayFill = !/\s$/.test(typed) && (fillable ?? !box.getInputElement().preventInlineAutocomplete(typed))
  const template = result.matches[0]
  const chrome = result.matches.map((m, i) => ({ m, src: { chrome: i } as Source }))

  const autofill = latest.list.find((s) => s.autofill && s.text.startsWith(bare))
  const others = latest.list.filter((s) => s !== autofill)
  // Chrome may have the same page under the other scheme (http://, then
  // https:// after its redirect): one row for an address.
  const chromeAddresses = new Set(result.matches.map((m) => address(m.destinationUrl)))
  const groveRows = others
    .filter((s) => !chromeAddresses.has(address(s.url)))
    .map((s) => ({ m: toMatch(s, typed, bare, false, template), src: { grove: s } as Source }))

  let rows: { m: Match; src: Source }[]
  if (autofill) {
    const fill = { m: toMatch(autofill, typed, bare, mayFill, template), src: { grove: autofill } as Source }
    const rest = chrome.filter((r) => address(r.m.destinationUrl) !== address(autofill.url))
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

// A page's address whatever its scheme, "www." or trailing slash.
function address(url: string): string {
  return normalize(url).replace(/\/$/, '')
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
function translate(
  handler: Handler,
  sources: () => Source[],
  forget: (s: HistorySuggestion) => void,
  queried: (queryId: number, preventInline: boolean) => void
): Handler {
  const at = (line: unknown): Source | undefined => sources()[line as number]
  return new Proxy(handler, {
    get(target, key) {
      const value = Reflect.get(target, key) as unknown
      if (typeof value !== 'function') return value
      const call = (...a: unknown[]): unknown => (value as (...a: unknown[]) => unknown).apply(target, a)
      if (key === 'queryAutocomplete') {
        // (queryId, [tabId,] input, preventInlineAutocomplete, ...): Chromium
        // 154 added the tab id, so the flag is the first boolean.
        return (...a: unknown[]) => {
          queried(a[0] as number, a.find((x) => typeof x === 'boolean') === true)
          return call(...a)
        }
      }
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
