// Translate, as the host keeps it: each tab's page language (Chrome's own
// detection, once a page has loaded), whether the page is translated, and
// the button the window shows for a page in another language than the
// user's. The translating itself is extension/translate.js. A tab the user
// translated keeps translating pages in that language as it goes on, as
// Chrome does.
import type { TranslateStatus } from '../shared/protocol.ts'

export interface TranslateBridge {
  call<T>(fn: string, arg?: unknown): Promise<T>
}

// "de-AT" -> "de"; Chinese keeps its script ("zh-TW").
export const baseLanguage = (lang: string): string => {
  const l = lang.toLowerCase()
  return l.startsWith('zh') ? (/-(tw|hk|hant)/.test(l) ? 'zh-TW' : 'zh-CN') : l.split(/[-_]/)[0]
}

export class PageTranslation {
  private readonly bridge: TranslateBridge
  private readonly changed: () => void
  private ui = 'en'
  private readonly lang = new Map<number, string>()
  private readonly state = new Map<number, TranslateStatus['state']>()
  // Tabs that go on translating pages in `from` as they navigate.
  private readonly keep = new Map<number, { from: string; to: string }>()
  private readonly asked = new Set<number>()

  constructor(bridge: TranslateBridge, changed: () => void) {
    this.bridge = bridge
    this.changed = changed
  }

  async init(): Promise<void> {
    this.ui = baseLanguage(await this.bridge.call<string>('uiLanguage').catch(() => 'en'))
  }

  // A tab finished loading a page: a new page, not translated (yet).
  async loaded(tabId: number): Promise<void> {
    this.state.delete(tabId)
    const detected = await this.bridge.call<string>('detectLanguage', tabId).catch(() => 'und')
    const lang = detected && detected !== 'und' ? baseLanguage(detected) : undefined
    if (lang) this.lang.set(tabId, lang)
    else this.lang.delete(tabId)
    const keep = this.keep.get(tabId)
    if (keep && lang === keep.from) await this.start(tabId, keep.to)
    else this.changed()
  }

  // A tab shown: its language, if no load has told it yet (pages loaded
  // before Grove's host was up).
  shown(tabId: number): void {
    if (this.lang.has(tabId) || this.state.has(tabId) || this.asked.has(tabId)) return
    this.asked.add(tabId)
    void this.bridge
      .call<string>('detectLanguage', tabId)
      .then((detected) => {
        if (!detected || detected === 'und' || this.lang.has(tabId)) return
        this.lang.set(tabId, baseLanguage(detected))
        this.changed()
      })
      .catch(() => {})
  }

  removed(tabId: number): void {
    this.asked.delete(tabId)
    this.lang.delete(tabId)
    this.state.delete(tabId)
    this.keep.delete(tabId)
  }

  // What the window showing this tab offers: nothing for a page in the
  // user's language (unless it's translated), or of no known language.
  status(tabId: number | undefined): TranslateStatus | undefined {
    if (tabId === undefined) return undefined
    const from = this.lang.get(tabId)
    const state = this.state.get(tabId) ?? 'original'
    if (!from || (from === this.ui && state === 'original')) return undefined
    return { from, to: this.ui, state }
  }

  // The button: translate the page, or show it as it was.
  async toggle(tabId: number): Promise<void> {
    const state = this.state.get(tabId) ?? 'original'
    if (state === 'original') return this.start(tabId, this.ui)
    this.keep.delete(tabId)
    this.state.set(tabId, 'original')
    this.changed()
    await this.bridge.call('translate', { tabId, to: null }).catch(() => {})
  }

  // translate.js says how the page's translation is going (and, once it
  // has seen the text, which language it was really in).
  onState(tabId: number, state: TranslateStatus['state'], source?: string): void {
    this.state.set(tabId, state)
    if (source) {
      this.lang.set(tabId, baseLanguage(source))
      const keep = this.keep.get(tabId)
      if (keep) keep.from = baseLanguage(source)
    }
    this.changed()
  }

  private async start(tabId: number, to: string): Promise<void> {
    const from = this.lang.get(tabId)
    if (from) this.keep.set(tabId, { from, to })
    this.state.set(tabId, 'translating')
    this.changed()
    await this.bridge.call('translate', { tabId, to }).catch(() => {})
  }
}
