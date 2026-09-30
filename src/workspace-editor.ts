// The workspace editor: name, icon and color for a new workspace or an
// existing one. A small panel over the bottom of the sidebar; Enter saves,
// Escape cancels.
import type { WorkspaceSummary } from '../shared/protocol.ts'
import { COLORS, type Color, type WorkspaceColor } from '../shared/types.ts'
import { svg } from './svg'
import { WORKSPACE_ICONS } from './workspace-icons'

export const COLOR_HEX: Record<Color, string> = {
  green: '#4caf6e',
  blue: '#4a8fe0',
  purple: '#9a6ce0',
  pink: '#e06ca8',
  red: '#e05a5a',
  orange: '#e8914a',
  yellow: '#d6b43c',
  gray: '#8e8e93'
}

export const colorHex = (c: WorkspaceColor): string => (c.startsWith('#') ? c : COLOR_HEX[c as Color])

export interface WorkspaceFields {
  name: string
  icon: string
  color: WorkspaceColor
}

// A workspace's icon: one from the set, an emoji, or the default leaf.
export function workspaceIcon(icon: string | undefined): Element {
  const markup = WORKSPACE_ICONS[icon || 'leaf']
  if (markup) return svg(markup)
  const span = document.createElement('span')
  span.className = 'emoji'
  span.textContent = icon!
  return span
}

export function workspaceEditor(
  existing: WorkspaceSummary | undefined,
  defaults: { name: string; color: Color },
  done: (fields: WorkspaceFields | undefined) => void
): HTMLElement {
  let icon = existing?.icon ?? 'leaf'
  let color: WorkspaceColor = existing?.color ?? defaults.color

  const panel = document.createElement('form')
  panel.className = 'ws-editor'
  const title = document.createElement('div')
  title.className = 'ws-editor-title'
  title.textContent = existing ? 'Edit workspace' : 'New workspace'

  const name = document.createElement('input')
  name.className = 'ws-name'
  name.placeholder = defaults.name
  name.value = existing?.name ?? ''
  name.spellcheck = false

  const grid = document.createElement('div')
  grid.className = 'ws-icons'
  const iconButtons = new Map<string, HTMLButtonElement>()
  for (const key of Object.keys(WORKSPACE_ICONS)) {
    const b = document.createElement('button')
    b.type = 'button'
    b.title = key
    b.append(workspaceIcon(key))
    b.addEventListener('click', () => {
      icon = key
      emoji.value = ''
      paint()
    })
    iconButtons.set(key, b)
    grid.append(b)
  }
  const emoji = document.createElement('input')
  emoji.className = 'ws-emoji'
  emoji.placeholder = 'or an emoji'
  emoji.maxLength = 8
  if (!WORKSPACE_ICONS[icon]) emoji.value = icon
  emoji.addEventListener('input', () => {
    icon = emoji.value.trim() || 'leaf'
    paint()
  })

  const colors = document.createElement('div')
  colors.className = 'ws-colors'
  const colorButtons = new Map<Color, HTMLButtonElement>()
  for (const c of COLORS) {
    const b = document.createElement('button')
    b.type = 'button'
    b.title = c
    b.style.setProperty('--swatch', COLOR_HEX[c])
    b.addEventListener('click', () => {
      color = c
      paint()
    })
    colorButtons.set(c, b)
    colors.append(b)
  }
  // Any other color, from the system color picker.
  const custom = document.createElement('input')
  custom.type = 'color'
  custom.className = 'ws-custom-color'
  custom.title = 'Custom color'
  custom.addEventListener('input', () => {
    color = custom.value as WorkspaceColor
    paint()
  })
  colors.append(custom)

  const actions = document.createElement('div')
  actions.className = 'ws-actions'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'ws-cancel'
  cancel.textContent = 'Cancel'
  cancel.addEventListener('click', () => done(undefined))
  const save = document.createElement('button')
  save.type = 'submit'
  save.className = 'ws-save'
  save.textContent = existing ? 'Save' : 'Create'
  actions.append(cancel, save)

  panel.append(title, name, grid, emoji, colors, actions)
  panel.addEventListener('submit', (e) => {
    e.preventDefault()
    done({ name: name.value.trim() || existing?.name || defaults.name, icon, color })
  })
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      done(undefined)
    }
  })

  function paint(): void {
    for (const [key, b] of iconButtons) b.classList.toggle('selected', key === icon)
    for (const [c, b] of colorButtons) b.classList.toggle('selected', c === color)
    const isCustom = color.startsWith('#')
    custom.classList.toggle('selected', isCustom)
    custom.value = colorHex(color)
    custom.style.setProperty('--swatch', isCustom ? color : '')
    panel.style.setProperty('--ws-color', colorHex(color))
  }
  paint()
  requestAnimationFrame(() => name.focus())
  return panel
}
