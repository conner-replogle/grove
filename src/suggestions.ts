// Grove's history suggestions in Webium's URL bar (see host/history-index.ts
// for why Chrome's own fall short there).
//
// Chrome's results reach the searchbox through its `result` property; Grove
// puts its own suggestions into each result as it is set: an autofill (the
// site the input starts, filled in as the user types) first, and pages from
// history ahead of the search suggestions. Opening and removing matches
// goes to the browser by the match's position in Chrome's result, so the
// searchbox's page handler is wrapped to translate positions, to open or
// forget Grove's own matches through the host, and to open a new tab's
// search in a new tab.
//
// An Enter pressed before the results for what was typed are in waits for
// them, as the searchbox itself makes it wait for Chrome's: the same Enter
// also waits for Grove's, which may change the first row.
import type { HistorySuggestion } from '../shared/protocol.ts'
import { onSuggestions, send } from './host-client'
import { patchMethod } from './patch'
import { isNewTabSearch, matchOpened, searchbox } from './urlbar'

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
  // An Enter the searchbox holds until its results are in (Chromium 155).
  lastIgnoredEnterEvent_?: KeyboardEvent | null
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

// The searchbox's page handler as Grove wraps it (translate), once wired.
let wrapHandler: ((handler: Handler) => Handler) | undefined
const wrapped = new WeakSet<object>()

export function suggestFromHistory(): void {
  suggestWhenEmptied()
  // The rows open and remove their matches with a handler of their own
  // (the same browser handler, not the searchbox's pageHandler()): it goes
  // through Grove's wrapper too.
  patchMethod<[], void, Element & { pageHandler_?: Handler }>('cr-searchbox-match', 'connectedCallback', function (original) {
    original()
    if (this.pageHandler_ && wrapHandler && !wrapped.has(this.pageHandler_)) {
      this.pageHandler_ = wrapHandler(this.pageHandler_)
      wrapped.add(this.pageHandler_)
    }
  })
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
  // Grove's suggestions for the text are in.
  const groveReady = (): boolean => asked === undefined || latest?.input === asked
  // An Enter waiting for Grove's suggestions, and how long it may.
  let heldEnter: KeyboardEvent | undefined
  let heldTimer: ReturnType<typeof setTimeout> | undefined
  const hold = (e: KeyboardEvent): void => {
    heldEnter = e
    clearTimeout(heldTimer)
    heldTimer = setTimeout(release, 1500)
  }
  // Hands the Enter back to the searchbox's own wait, and lets the
  // searchbox take the results (Grove's in them by now, or not coming) as
  // new: it then opens the first row for that Enter.
  const release = (): void => {
    clearTimeout(heldTimer)
    if (!heldEnter || !box || !chromeResult) return
    box.lastIgnoredEnterEvent_ = heldEnter
    heldEnter = undefined
    box.onAutocompleteResultChanged(chromeResult)
  }

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
        // Chrome's results came with an Enter waiting for them; it waits on
        // for Grove's. (The searchbox looks for it right after this.)
        if (el.lastIgnoredEnterEvent_ && !groveReady()) {
          hold(el.lastIgnoredEnterEvent_)
          el.lastIgnoredEnterEvent_ = null
        }
      }
    })
    // An Enter with Chrome's results in but not yet Grove's, on the first
    // row: it waits, unseen by the searchbox. (Without the searchbox's own
    // wait, in Chromium before 155, Enter goes through as it is.)
    el.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Enter' || e.isComposing || groveReady() || !('lastIgnoredEnterEvent_' in el)) return
        const chromeReady = el.activeQueryId === -1 || el.result?.queryId === el.activeQueryId
        if (!chromeReady || el.selectedMatchIndex > 0) return
        e.preventDefault()
        e.stopImmediatePropagation()
        hold(e)
      },
      true
    )
    const own = el.pageHandler.bind(el)
    wrapHandler = (handler) =>
      translate(handler, () => sources, forget, (queryId, preventInline) => {
        fillable.set(queryId, !preventInline)
        for (const id of fillable.keys()) if (id < queryId - 20) fillable.delete(id)
      })
    el.pageHandler = () => wrapHandler!(own())
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
    if (heldEnter) return release()
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
  // Filled in, Grove's page leads (and replaces Chrome's row for it).
  // Otherwise it's one more row after Chrome's default, and Chrome keeps
  // its own row for the same page: after a paste of an address, that row
  // is the default, and dropping it left the search for the address first.
  const filling = mayFill ? autofill : undefined
  const others = autofill && !filling ? [autofill, ...latest.list.filter((s) => s !== autofill)] : latest.list.filter((s) => s !== filling)
  // Chrome may have the same page under the other scheme (http://, then
  // https:// after its redirect): one row for an address.
  const chromeAddresses = new Set(result.matches.map((m) => address(m.destinationUrl)))
  const groveRows = others
    .filter((s) => !chromeAddresses.has(address(s.url)))
    .map((s) => ({ m: toMatch(s, typed, bare, false, template), src: { grove: s } as Source }))

  let rows: { m: Match; src: Source }[]
  if (filling) {
    const fill = { m: toMatch(filling, typed, bare, true, template), src: { grove: filling } as Source }
    const rest = chrome.filter((r) => address(r.m.destinationUrl) !== address(filling.url))
    rows = [fill, ...groveRows, ...rest]
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

// Chrome's modifiers for a new foreground tab: Cmd+Shift on a Mac,
// Ctrl+Shift elsewhere (on a Mac, Ctrl+Shift reads as Shift: a new window).
const mac = navigator.platform.startsWith('Mac')
const NEW_TAB_MODIFIERS = { altKey: false, ctrlKey: !mac, metaKey: mac, shiftKey: true }

// The searchbox's page handler, with match positions mapped back to
// Chrome's result; Grove's own matches open (or are forgotten) through the
// host.
function translate(
  handler: Handler,
  sources: () => Source[],
  forget: (s: HistorySuggestion) => void,
  queried: (queryId: number, preventInline: boolean) => void
): Handler {
  // A match's calls name it by its line, which comes just before its URL:
  // (line, url, ...) until Chromium 155, which puts a number of its own
  // first. Swaps a line of what's shown for Chrome's own.
  const lineAt = (a: unknown[]): number => {
    const url = a.findIndex((x) => typeof x === 'string')
    return url > 0 && typeof a[url - 1] === 'number' ? url - 1 : 0
  }
  const withLine = (a: unknown[], i: number, line: number): unknown[] => a.map((x, j) => (j === i ? line : x))
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
      if (key === 'openAutocompleteMatch' || key === 'deleteAutocompleteMatch' || key === 'onNavigationLikely') {
        return (...a: unknown[]) => {
          const i = lineAt(a)
          const src = sources()[a[i] as number]
          if (src && 'grove' in src) {
            if (key === 'deleteAutocompleteMatch') return forget(src.grove)
            if (key === 'onNavigationLikely') return
            // (..., url, areMatchesShowing, mouseButton, modifiers, ...)
            const button = a[i + 3]
            const m = (a[i + 4] ?? {}) as { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }
            const newTab = isNewTabSearch() || !!(m.ctrlKey || m.metaKey || m.shiftKey) || button === 1
            send({ type: 'open', url: src.grove.url, newTab })
            if (key === 'openAutocompleteMatch') matchOpened()
            return
          }
          if (key !== 'openAutocompleteMatch') return call(...(src ? withLine(a, i, src.chrome) : a))
          // A new tab's search opens in a new foreground tab: the browser
          // takes where to open from the modifiers given with the match
          // (..., mouseButton, modifiers, viaKeyboard), as a click's.
          if (isNewTabSearch() && typeof a[i + 4] === 'object') {
            a = a.map((x, j) => (j === i + 4 ? NEW_TAB_MODIFIERS : j === i + 5 && typeof x === 'boolean' ? false : x))
          }
          const r = call(...(src ? withLine(a, i, src.chrome) : a))
          matchOpened()
          return r
        }
      }
      return call
    }
  })
}
