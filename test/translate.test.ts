import { describe, expect, it } from 'vitest'
import { baseLanguage, PageTranslation } from '../host/translate.ts'

function setup(detect: () => string) {
  const calls: unknown[] = []
  const t = new PageTranslation(
    {
      async call<T>(fn: string, arg?: unknown): Promise<T> {
        calls.push([fn, arg])
        if (fn === 'uiLanguage') return 'en-US' as T
        if (fn === 'detectLanguage') return detect() as T
        return undefined as T
      }
    },
    () => {}
  )
  return { t, calls }
}

describe('Translate', () => {
  it('reduces languages to what Translate takes', () => {
    expect(baseLanguage('de-AT')).toBe('de')
    expect(baseLanguage('zh-Hant')).toBe('zh-TW')
    expect(baseLanguage('zh')).toBe('zh-CN')
  })

  it("offers a page in another language, translates it, and keeps on in that tab", async () => {
    let lang = 'de'
    const { t, calls } = setup(() => lang)
    await t.init()
    await t.loaded(1)
    expect(t.status(1)).toEqual({ from: 'de', to: 'en', state: 'original' })
    await t.toggle(1)
    expect(calls.at(-1)).toEqual(['translate', { tabId: 1, to: 'en' }])
    t.onState(1, 'translated', 'de')
    expect(t.status(1)?.state).toBe('translated')
    // The next page in German is translated too; an English one isn't.
    await t.loaded(1)
    expect(calls.at(-1)).toEqual(['translate', { tabId: 1, to: 'en' }])
    lang = 'en'
    await t.loaded(1)
    expect(t.status(1)).toBeUndefined()
    // Show original stops it for the tab.
    lang = 'de'
    await t.loaded(1)
    await t.toggle(1)
    expect(calls.at(-1)).toEqual(['translate', { tabId: 1, to: null }])
    expect(t.status(1)?.state).toBe('original')
  })

  it("offers nothing for the user's own language or an unknown one", async () => {
    const { t } = setup(() => 'und')
    await t.init()
    await t.loaded(2)
    expect(t.status(2)).toBeUndefined()
  })
})
