// Spell check dictionaries. Chrome downloads the one for each spell check
// language from Google when it's missing; ungoogled-chromium blocks that,
// leaving spell check without words. Grove fetches them from the same
// place (redirector.gvt1.com/edgedl/chrome/dict/) into <profile>/Dictionaries,
// where Chrome looks for them; Chrome loads a new one at its next start.
//
// Chrome names the file <language-region><version>.bdic, the version per
// language (components/spellcheck/common/spellcheck_common.cc). English's
// changes across Chromium versions, so both recent ones are fetched; Chrome
// reads the one it wants.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SERVER = 'https://redirector.gvt1.com/edgedl/chrome/dict/'

// Spell check language -> the dictionary's language-region.
const REGION: Record<string, string> = {
  af: 'af-ZA', bg: 'bg-BG', ca: 'ca-ES', cs: 'cs-CZ', cy: 'cy-GB', da: 'da-DK', de: 'de-DE', el: 'el-GR',
  en: 'en-US', es: 'es-ES', 'es-419': 'es-ES', 'es-AR': 'es-ES', 'es-MX': 'es-ES', 'es-US': 'es-ES', et: 'et-EE',
  fa: 'fa-IR', fo: 'fo-FO', fr: 'fr-FR', he: 'he-IL', hi: 'hi-IN', hr: 'hr-HR', hu: 'hu-HU', id: 'id-ID',
  it: 'it-IT', lt: 'lt-LT', lv: 'lv-LV', nb: 'nb-NO', nl: 'nl-NL', pl: 'pl-PL', pt: 'pt-BR', ro: 'ro-RO',
  ru: 'ru-RU', sk: 'sk-SK', sl: 'sl-SI', sv: 'sv-SE', ta: 'ta-IN', tg: 'tg-TG', tr: 'tr-TR', uk: 'uk-UA', vi: 'vi-VN'
}
// Versions other than the default -3-0.
const VERSIONS: Record<string, string[]> = {
  'tr-TR': ['-4-0'],
  'tg-TG': ['-5-0'],
  'cy-GB': ['-1-0'],
  hy: ['-1-0'],
  sh: ['-4-0'],
  sr: ['-4-0'],
  'fa-IR': ['-9-0'],
  'en-AU': ['-10-1', '-10-2'],
  'en-CA': ['-10-1', '-10-2'],
  'en-GB': ['-10-1', '-10-2'],
  'en-GB-oxendict': ['-10-1', '-10-2'],
  'en-US': ['-10-1', '-10-2'],
  'uk-UA': ['-5-0'],
  gl: ['-1-0']
}

// The dictionary files a spell check language needs (Chrome wants one).
export function dictionaryFiles(language: string): string[] {
  const region = REGION[language] ?? language
  return (VERSIONS[region] ?? ['-3-0']).map((v) => `${region}${v}.bdic`)
}

// The profile's spell check languages (Chrome keeps them in Preferences),
// else its first preferred language.
export function spellcheckLanguages(profile: string): string[] {
  try {
    const prefs = JSON.parse(readFileSync(join(profile, 'Default', 'Preferences'), 'utf8')) as {
      spellcheck?: { dictionaries?: string[] }
      intl?: { selected_languages?: string }
    }
    const list = prefs.spellcheck?.dictionaries?.filter(Boolean)
    if (list?.length) return list
    const first = prefs.intl?.selected_languages?.split(',')[0]
    if (first) return [first]
  } catch {
    // A new profile.
  }
  return ['en-US']
}

// Fetches the dictionaries the profile's spell check languages lack.
export async function fetchDictionaries(
  profile: string,
  log: (...a: unknown[]) => void = () => {},
  get: typeof fetch = fetch
): Promise<string[]> {
  const dir = join(profile, 'Dictionaries')
  const fetched: string[] = []
  for (const file of spellcheckLanguages(profile).flatMap(dictionaryFiles)) {
    if (existsSync(join(dir, file))) continue
    try {
      const res = await get(SERVER + file.toLowerCase(), { signal: AbortSignal.timeout(60_000) })
      if (res.status === 404) continue
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = Buffer.from(await res.arrayBuffer())
      // A Chrome dictionary starts "BDic".
      if (data.toString('latin1', 0, 4) !== 'BDic') throw new Error('not a dictionary')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, file), data)
      fetched.push(file)
    } catch (e) {
      log(`dictionary ${file}:`, (e as Error).message)
    }
  }
  if (fetched.length) log(`spell check dictionaries ${fetched.join(', ')} fetched; used from the next start`)
  return fetched
}
