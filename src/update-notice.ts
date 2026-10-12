// A newer Grove release, offered at the bottom of the sidebar (the host
// checks GitHub's releases: host/updates.ts). Update installs it; Restart
// then starts the new version.
import type { UpdateStatus } from '../shared/protocol.ts'
import { send } from './host-client'

export function updateNotice(u: UpdateStatus | undefined): HTMLElement | null {
  if (!u || u.state === 'none') return null
  const box = el('div', `update-notice ${u.state}`)
  const text = el('div', 'update-text')
  const actions = el('div', 'update-actions')
  const button = (label: string, cls: string, onClick: () => void): HTMLButtonElement => {
    const b = el('button', cls, label) as HTMLButtonElement
    b.addEventListener('click', onClick)
    return b
  }
  switch (u.state) {
    case 'available':
      text.append(el('strong', '', `Grove ${u.version}`), el('span', '', ' is available'))
      if (u.notes) box.title = u.notes
      if (u.installed) actions.append(button('Update', 'primary', () => send({ type: 'installUpdate' })))
      else text.append(el('div', 'update-hint', 'Pull and reinstall this checkout to update.'))
      actions.append(button('Later', '', () => send({ type: 'dismissUpdate' })))
      break
    case 'downloading':
      text.append(el('span', '', `Installing Grove ${u.version}…`))
      break
    case 'ready':
      text.append(el('strong', '', `Grove ${u.version}`), el('span', '', ' is installed'))
      actions.append(button('Restart', 'primary', () => send({ type: 'restartForUpdate' })))
      break
    case 'error':
      text.append(el('span', '', `Couldn't update: ${u.error ?? 'unknown error'}`))
      actions.append(
        button('Retry', 'primary', () => send({ type: 'installUpdate' })),
        button('Later', '', () => send({ type: 'dismissUpdate' }))
      )
      break
  }
  box.append(text)
  if (actions.childElementCount) box.append(actions)
  return box
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}
