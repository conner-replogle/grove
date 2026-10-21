// The Translate button at the right end of the URL bar, for a page in
// another language than the user's (host/translate.ts): translates the
// page, and shows it as it was again.
import languagesSvg from 'lucide-static/icons/languages.svg'
import type { TranslateStatus } from '../shared/protocol.ts'
import { send, subscribe } from './host-client'
import { svg } from './svg'

const languageName = (code: string): string => {
  try {
    return new Intl.DisplayNames([navigator.language], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

export function showTranslateButton(): void {
  const button = document.createElement('button')
  button.className = 'grove-translate'
  button.append(svg(languagesSvg))
  button.addEventListener('pointerdown', (e) => e.stopPropagation())
  button.addEventListener('click', (e) => {
    e.stopPropagation()
    send({ type: 'translate' })
  })
  let latest: TranslateStatus | undefined

  const render = (): void => {
    const box = document.querySelector('webui-browser-app')?.shadowRoot?.querySelector('#addressBox')
    if (!box) return void requestAnimationFrame(render)
    if (button.parentNode !== box) box.append(button)
    const t = latest
    button.hidden = !t
    if (!t) return
    const from = languageName(t.from)
    button.dataset.state = t.state
    button.title =
      t.state === 'original'
        ? `Translate this page from ${from} to ${languageName(t.to)}`
        : t.state === 'translating'
          ? `Translating from ${from}…`
          : `Show the original (${from})`
  }
  subscribe((s) => {
    latest = s.translate
    render()
  })
}
