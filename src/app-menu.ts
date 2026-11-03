// The app menu: the ⋮ button at the end of the sidebar's top row, with what
// other browsers keep there (new windows, history, downloads, bookmarks,
// passwords, extensions, zoom, print, settings), Grove's own settings, and
// in Debug mode, saving the bug report packet (debug.ts).
// Its last item opens Chrome's own app menu, for the rest (find, cast,
// save page, developer tools, help, exit).
import historySvg from 'lucide-static/icons/history.svg'
import downloadSvg from 'lucide-static/icons/download.svg'
import bookmarkSvg from 'lucide-static/icons/bookmark.svg'
import bugSvg from 'lucide-static/icons/bug.svg'
import ellipsisSvg from 'lucide-static/icons/ellipsis.svg'
import keySvg from 'lucide-static/icons/key-round.svg'
import menuSvg from 'lucide-static/icons/ellipsis-vertical.svg'
import minusSvg from 'lucide-static/icons/minus.svg'
import plusSvg from 'lucide-static/icons/plus.svg'
import printerSvg from 'lucide-static/icons/printer.svg'
import puzzleSvg from 'lucide-static/icons/puzzle.svg'
import settingsSvg from 'lucide-static/icons/settings.svg'
import squarePlusSvg from 'lucide-static/icons/square-plus.svg'
import trashSvg from 'lucide-static/icons/trash-2.svg'
import windowSvg from 'lucide-static/icons/app-window.svg'
import privateSvg from 'lucide-static/icons/hat-glasses.svg'
import wrenchSvg from 'lucide-static/icons/wrench.svg'
import type { EntryView, HostCommand, WindowState } from '../shared/protocol.ts'
import { anchorAt } from './extensions-anchor'
import { send, subscribe } from './host-client'
import { openSettings } from './settings'
import { svg } from './svg'

// About the width of Chrome's own app menu, so it opens rightward from the
// button instead of off the window's left edge.
const CHROME_MENU_REACH = 340

const mac = navigator.platform.startsWith('Mac')
const keys = (k: string): string => (mac ? k.replace('Ctrl+Shift+', '⇧⌘').replace('Ctrl+', '⌘') : k)

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

export function showAppMenu(): HTMLElement {
  const root = (): ShadowRoot | null | undefined => document.querySelector('webui-browser-app')?.shadowRoot
  let state: WindowState | undefined
  let menu: HTMLElement | undefined

  const button = el('button')
  button.id = 'groveAppMenu'
  button.title = 'Menu'
  button.setAttribute('aria-label', 'Menu')
  button.append(svg(menuSvg))
  button.addEventListener('pointerdown', (e) => e.stopPropagation())
  button.addEventListener('click', (e) => {
    e.stopPropagation()
    if (menu) close()
    else open()
  })

  const active = (): EntryView | undefined => {
    const id = state?.activeEntryId
    if (!id || !state) return undefined
    return state.workspace.entries.find((e) => e.id === id) ?? state.essentials.find((e) => e.id === id)
  }

  const close = (): void => {
    menu?.remove()
    menu = undefined
    button.classList.remove('open')
  }

  const open = (): void => {
    menu = el('div', 'grove-app-menu')
    menu.addEventListener('pointerdown', (e) => e.stopPropagation())
    button.classList.add('open')
    root()?.append(menu)
    // The page's zoom comes with its site info.
    if (active()) send({ type: 'siteInfo' })
    render()
  }

  const item = (icon: string, label: string, run: () => void, shortcut = '', disabled = false): HTMLButtonElement => {
    const b = el('button', 'grove-app-menu-item')
    b.type = 'button'
    b.disabled = disabled
    b.append(svg(icon), el('span', 'grove-app-menu-label', label))
    if (shortcut) b.append(el('span', 'grove-app-menu-keys', keys(shortcut)))
    b.addEventListener('click', () => {
      close()
      run()
    })
    return b
  }
  const command = (c: HostCommand) => () => send(c)
  const page = (url: string) => command({ type: 'open', url, newTab: true })

  const render = (): void => {
    if (!menu) return
    const entry = active()
    const url = entry?.url ?? ''
    const site = state?.site?.url === url ? state.site : undefined
    const isPage = /^(https?|file):/.test(url)

    // Zoom, as in Chrome's menu: −, the level (a click resets it), +.
    const zoom = el('div', 'grove-app-menu-zoom')
    zoom.append(el('span', 'grove-app-menu-label', 'Zoom'))
    const step = (icon: string, title: string, s: -1 | 0 | 1, text?: string): HTMLButtonElement => {
      const b = el('button', 'grove-app-menu-step')
      b.type = 'button'
      b.title = title
      // (Extensions can't zoom Chrome's own pages.)
      b.disabled = !isPage
      if (text) b.textContent = text
      else b.append(svg(icon))
      b.addEventListener('click', () => send({ type: 'zoom', step: s }))
      return b
    }
    zoom.append(
      step(minusSvg, 'Zoom out', -1),
      step('', 'Reset to 100%', 0, `${Math.round((site?.zoom ?? 1) * 100)}%`),
      step(plusSvg, 'Zoom in', 1)
    )

    menu.replaceChildren(
      item(squarePlusSvg, 'New tab', command({ type: 'newTab' }), 'Ctrl+T'),
      item(windowSvg, 'New window', command({ type: 'newWindow' }), 'Ctrl+N'),
      item(windowSvg, 'New blank window', command({ type: 'newBlankWindow' })),
      item(privateSvg, 'New private window', command({ type: 'newPrivateWindow' }), 'Ctrl+Shift+N'),
      el('div', 'grove-app-menu-separator'),
      item(historySvg, 'History', page('chrome://history'), 'Ctrl+H'),
      item(downloadSvg, 'Downloads', page('chrome://downloads'), mac ? '⌥⌘L' : 'Ctrl+J'),
      item(bookmarkSvg, 'Bookmarks', page('chrome://bookmarks'), 'Ctrl+Shift+O'),
      item(keySvg, 'Passwords', page('chrome://password-manager')),
      item(puzzleSvg, 'Extensions', page('chrome://extensions')),
      item(trashSvg, 'Delete browsing data', page('chrome://settings/clearBrowserData'), mac ? '⇧⌘⌫' : 'Ctrl+Shift+Del'),
      el('div', 'grove-app-menu-separator'),
      zoom,
      item(printerSvg, 'Print…', command({ type: 'print' }), 'Ctrl+P', !isPage),
      el('div', 'grove-app-menu-separator'),
      item(settingsSvg, 'Grove settings', openSettings),
      item(wrenchSvg, 'Chrome settings', page('chrome://settings')),
      ...(state?.debug
        ? [item(bugSvg, state.debug.saving ? 'Saving bug report…' : 'Save bug report', command({ type: 'debugSave' }), '', state.debug.saving)]
        : []),
      item(ellipsisSvg, 'More from Chrome…', chromeMenu)
    )
    // Under the button, its left edge with the button's, kept in the window.
    const r = button.getBoundingClientRect()
    const width = menu.offsetWidth
    menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - width - 8))}px`
    menu.style.top = `${r.bottom + 6}px`
  }

  // Chrome's own app menu, opened from this button.
  const chromeMenu = (): void => {
    const chrome = root()?.querySelector<HTMLElement>('#appMenuButton')
    if (!chrome) return
    void anchorAt(button, 'kToolbarAppMenuButtonElementId', undefined, CHROME_MENU_REACH, chrome).then(() => chrome.click())
  }

  // Closes on a press elsewhere, Escape, or the window losing focus.
  addEventListener(
    'pointerdown',
    (e) => {
      if (menu && !e.composedPath().some((n) => n === menu || n === button)) close()
    },
    true
  )
  addEventListener('keydown', (e) => {
    if (menu && e.key === 'Escape') close()
  })
  addEventListener('blur', () => close())
  addEventListener('resize', () => close())

  subscribe((s) => {
    state = s
    render()
  })
  return button
}
