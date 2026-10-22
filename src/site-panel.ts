// Zen's site panel, at the right end of the URL bar beside a copy link
// button: the page's actions (bookmark, screenshot, reader view, share),
// every extension (pinned or not; a click runs it as its toolbar button
// would, a right-click gives Chrome's menu for it), the settings the site
// was given, and at the bottom the connection (Chrome's page info), clear
// site data, and Chrome's app menu, which leaves the sidebar's top row for
// this. The host does the work (host.ts sitePanel, the bridge).
import bookmarkSvg from 'lucide-static/icons/bookmark.svg'
import bookmarkCheckSvg from 'lucide-static/icons/bookmark-check.svg'
import brushSvg from 'lucide-static/icons/brush-cleaning.svg'
import cameraSvg from 'lucide-static/icons/camera.svg'
import clipboardSvg from 'lucide-static/icons/clipboard.svg'
import codeSvg from 'lucide-static/icons/code.svg'
import ellipsisSvg from 'lucide-static/icons/ellipsis.svg'
import externalSvg from 'lucide-static/icons/external-link.svg'
import imageSvg from 'lucide-static/icons/image.svg'
import linkSvg from 'lucide-static/icons/link.svg'
import lockSvg from 'lucide-static/icons/lock.svg'
import lockOpenSvg from 'lucide-static/icons/lock-open.svg'
import plusSvg from 'lucide-static/icons/plus.svg'
import readerSvg from 'lucide-static/icons/notepad-text.svg'
import shareSvg from 'lucide-static/icons/share.svg'
import slidersSvg from 'lucide-static/icons/sliders-horizontal.svg'
import volumeSvg from 'lucide-static/icons/volume-2.svg'
import type { EntryView, SiteInfo, WindowState } from '../shared/protocol.ts'
import { anchorAt, POPUP_REACH } from './extensions-anchor'
import { send, subscribe } from './host-client'
import { icons } from './icons'
import { WHAT } from './permission-prompt'
import { svg } from './svg'

// Chrome's site settings the panel can show (bridge SITE_SETTINGS).
const SETTINGS: Record<string, [icon: string, label: string]> = {
  notifications: [icons.bell, 'Send notifications'],
  location: [icons.mapPin, 'Know your location'],
  camera: [icons.camera, 'Use your camera'],
  microphone: [icons.mic, 'Use your microphone'],
  clipboard: [clipboardSvg, 'See text and images you copy'],
  popups: [externalSvg, 'Open pop-ups and redirects'],
  sound: [volumeSvg, 'Play sound'],
  javascript: [codeSvg, 'Run JavaScript'],
  images: [imageSvg, 'Show images']
}
const SETTING_WORD: Record<string, string> = { allow: 'Allowed', block: 'Blocked', ask: 'Ask', granted: 'Allowed', denied: 'Blocked' }

const PANEL_WIDTH = 340
const STORE_URL = 'https://chromewebstore.google.com/'

interface ExtensionButton extends HTMLElement {
  extensionId: string
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}
const iconButton = (className: string, icon: string, title: string): HTMLButtonElement => {
  const b = el('button', className)
  b.type = 'button'
  b.title = title
  b.setAttribute('aria-label', title)
  b.append(svg(icon))
  return b
}
const isPageUrl = (url: string): boolean => /^(https?|file):/.test(url)

export function showSitePanel(): void {
  const app = (): HTMLElement | null => document.querySelector('webui-browser-app')
  const root = (): ShadowRoot | null | undefined => app()?.shadowRoot
  let state: WindowState | undefined
  let panel: HTMLElement | undefined
  let openFor: string | undefined
  let clearArmed = false

  const copy = iconButton('grove-copy-link', linkSvg, 'Copy link')
  const opener = iconButton('grove-site-button', slidersSvg, 'Site settings, extensions and more')
  for (const b of [copy, opener]) b.addEventListener('pointerdown', (e) => e.stopPropagation())

  const active = (): EntryView | undefined => {
    const id = state?.activeEntryId
    if (!id || !state) return undefined
    return state.workspace.entries.find((e) => e.id === id) ?? state.essentials.find((e) => e.id === id)
  }

  // ---- In the URL bar ----

  let toast: HTMLElement | undefined
  copy.addEventListener('click', (e) => {
    e.stopPropagation()
    const url = active()?.url
    if (!url) return
    void navigator.clipboard.writeText(url).then(
      () => showToast('Copied link'),
      () => showToast("Couldn't copy the link")
    )
  })
  const showToast = (text: string): void => {
    toast?.remove()
    const t = el('div', 'grove-toast', text)
    const r = copy.getBoundingClientRect()
    t.style.top = `${r.bottom + 10}px`
    t.style.left = `${r.left + r.width / 2}px`
    root()?.append(t)
    toast = t
    setTimeout(() => t.classList.add('leaving'), 1300)
    setTimeout(() => t.remove(), 1600)
  }

  opener.addEventListener('click', (e) => {
    e.stopPropagation()
    if (panel) close()
    else open()
  })

  const place = (): void => {
    const box = root()?.querySelector('#addressBox')
    if (!box) return void requestAnimationFrame(place)
    for (const b of [copy, opener]) if (b.parentNode !== box) box.append(b)
    const url = active()?.url ?? ''
    copy.hidden = opener.hidden = !isPageUrl(url) && !url.startsWith('chrome://')
    if (url.startsWith('chrome://newtab') || url.startsWith('chrome://new-tab-page')) copy.hidden = opener.hidden = true
    // The panel's Extensions take the place of Chrome's extensions menu.
    const menuButton = root()?.querySelector('#extensionsBar')?.shadowRoot?.querySelector<HTMLElement>('#extensionsMenuButton')
    if (menuButton) menuButton.style.display = 'none'
  }

  // ---- The panel ----

  const close = (): void => {
    panel?.remove()
    panel = undefined
    openFor = undefined
    clearArmed = false
    opener.classList.remove('open')
  }

  const open = (): void => {
    const entry = active()
    if (!entry || !opener.getClientRects().length) return
    openFor = entry.id
    panel = el('div', 'grove-site-panel')
    panel.addEventListener('pointerdown', (e) => e.stopPropagation())
    opener.classList.add('open')
    root()?.append(panel)
    // Under the button, its arrow pointing at it.
    const r = opener.getBoundingClientRect()
    const center = r.left + r.width / 2
    const left = Math.max(8, Math.min(center - PANEL_WIDTH / 2, innerWidth - PANEL_WIDTH - 8))
    panel.style.left = `${left}px`
    panel.style.top = `${r.bottom + 10}px`
    panel.style.setProperty('--arrow-x', `${center - left}px`)
    send({ type: 'siteInfo' })
    render()
  }

  // Chrome's own extension buttons (pinned or not), in the hidden bar.
  // Grove's own bridge is left out.
  const extensionButtons = (): ExtensionButton[] =>
    [...(root()?.querySelector('#extensionsBar')?.shadowRoot?.querySelectorAll<ExtensionButton>('webui-browser-extension') ?? [])].filter(
      (b) => !(b.title || '').startsWith('Grove bridge')
    )

  const runExtension = async (ext: ExtensionButton): Promise<void> => {
    close()
    await anchorAt(opener, 'kToolbarActionViewElementId', `ext:${ext.extensionId}`, POPUP_REACH, ext)
    ext.shadowRoot?.querySelector<HTMLElement>('cr-button')?.click()
  }
  const extensionMenu = async (ext: ExtensionButton, e: MouseEvent): Promise<void> => {
    await anchorAt(e.currentTarget as HTMLElement, 'kToolbarActionViewElementId', `ext:${ext.extensionId}`, 0, ext)
    ext.shadowRoot?.querySelector('cr-button')?.dispatchEvent(
      new PointerEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, pointerType: 'mouse', clientX: e.clientX, clientY: e.clientY })
    )
  }

  const render = (): void => {
    if (!panel) return
    const entry = active()
    if (!entry) return close()
    const site: SiteInfo | undefined = state?.site?.url === entry.url ? state.site : undefined
    const url = entry.url
    panel.replaceChildren()

    // Gone with its button (the URL bar opened, or the page has none).
    if (!opener.getClientRects().length) return close()

    // Actions.
    const actions = el('div', 'grove-site-actions')
    const bookmark = iconButton('', site?.bookmarked ? bookmarkCheckSvg : bookmarkSvg, site?.bookmarked ? 'Remove bookmark' : 'Bookmark this page')
    bookmark.classList.toggle('on', !!site?.bookmarked)
    bookmark.addEventListener('click', () => send({ type: 'toggleBookmark' }))
    const shot = iconButton('', cameraSvg, 'Take a screenshot (saved to Downloads)')
    shot.addEventListener('click', () => {
      close()
      send({ type: 'screenshot' })
    })
    const reader = iconButton('', readerSvg, site?.reader ? 'Close reader view' : 'Reader view')
    reader.classList.toggle('on', !!site?.reader)
    reader.addEventListener('click', () => send({ type: 'reader' }))
    actions.append(bookmark, shot, reader)
    if ('share' in navigator) {
      const share = iconButton('', shareSvg, 'Share')
      share.addEventListener('click', () => {
        close()
        void navigator.share({ title: entry.title, url }).catch(() => {})
      })
      actions.append(share)
    }
    for (const b of actions.querySelectorAll('button')) b.disabled = !isPageUrl(url)
    panel.append(actions)
    if (site?.notice) panel.append(el('div', 'grove-site-notice', site.notice))

    // Extensions.
    panel.append(el('div', 'grove-site-heading', 'Extensions'))
    const grid = el('div', 'grove-site-extensions')
    for (const ext of extensionButtons()) {
      const tile = el('button', 'grove-site-extension')
      tile.type = 'button'
      tile.title = ext.title || ext.getAttribute('aria-label') || ''
      // Chrome's icon for it. (Webium's own icon handles come out blank
      // for these.)
      const icon = el('img')
      icon.src = `chrome://extension-icon/${ext.extensionId}/32/1`
      icon.alt = ''
      tile.append(icon)
      tile.addEventListener('click', () => void runExtension(ext))
      tile.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        void extensionMenu(ext, e)
      })
      grid.append(tile)
    }
    const add = iconButton('grove-site-extension', plusSvg, 'Get extensions from the Chrome Web Store')
    add.addEventListener('click', () => {
      close()
      send({ type: 'open', url: STORE_URL, newTab: true })
    })
    grid.append(add)
    panel.append(grid)

    // Settings.
    const head = el('div', 'grove-site-heading')
    head.append(el('span', '', 'Settings'))
    if (site?.origin && /^https?:/.test(site.origin)) {
      const more = el('button', 'grove-site-more', 'More')
      more.type = 'button'
      more.addEventListener('click', () => {
        close()
        send({ type: 'open', url: `chrome://settings/content/siteDetails?site=${encodeURIComponent(site.origin)}`, newTab: true })
      })
      head.append(more)
    }
    panel.append(head)
    const rows = el('div', 'grove-site-settings')
    const row = (icon: string, label: string, word: string, on: boolean, flip: () => void): void => {
      const b = el('button', 'grove-site-setting')
      b.type = 'button'
      b.classList.toggle('blocked', !on)
      const i = el('span', 'grove-site-setting-icon')
      i.append(svg(icon))
      const text = el('span', 'grove-site-setting-text')
      text.append(el('span', '', label), el('small', '', word))
      b.append(i, text)
      b.title = on ? 'Click to block' : 'Click to allow'
      b.addEventListener('click', flip)
      rows.append(b)
    }
    for (const s of site?.settings ?? []) {
      const [icon, label] = SETTINGS[s.name] ?? [icons.globe, s.name]
      const on = s.setting === 'allow'
      row(icon, label, SETTING_WORD[s.setting] ?? s.setting, on, () =>
        send({ type: 'setSiteSetting', name: s.name, setting: on ? 'block' : 'allow' })
      )
    }
    for (const k of site?.kept ?? []) {
      const [icon, label] = WHAT[k.kind]
      const on = k.setting === 'granted'
      row(icon, label, SETTING_WORD[k.setting], on, () => send({ type: 'setKeptPermission', kind: k.kind, setting: on ? 'denied' : 'granted' }))
    }
    if (!rows.childElementCount) rows.append(el('div', 'grove-site-empty', site ? 'Nothing set for this site' : '…'))
    panel.append(rows)

    // Footer.
    const foot = el('div', 'grove-site-footer')
    const https = url.startsWith('https:')
    const security = el('button', `grove-site-security${https || !/^http:/.test(url) ? '' : ' insecure'}`)
    security.type = 'button'
    security.append(svg(https || !/^http:/.test(url) ? lockSvg : lockOpenSvg), el('span', '', https ? 'Secure' : /^http:/.test(url) ? 'Not secure' : 'Page info'))
    security.title = 'Connection, cookies and permissions'
    security.addEventListener('click', () => {
      const button = root()?.querySelector<HTMLElement>('#locationIconButton')
      close()
      if (!button) return
      void anchorAt(opener, 'kLocationIconElementId', undefined, 0, button).then(() => button.click())
    })
    const clear = iconButton('grove-site-clear', brushSvg, 'Clear cookies and site data')
    if (clearArmed) {
      clear.classList.add('armed')
      clear.append(el('span', '', 'Clear site data?'))
    }
    clear.disabled = !/^https?:/.test(url)
    clear.addEventListener('click', () => {
      if (!clearArmed) {
        clearArmed = true
        return render()
      }
      close()
      send({ type: 'clearSiteData' })
    })
    const menu = iconButton('grove-site-menu', ellipsisSvg, 'More tools and settings')
    menu.addEventListener('click', () => {
      const button = root()?.querySelector<HTMLElement>('#appMenuButton')
      close()
      if (!button) return
      void anchorAt(opener, 'kToolbarAppMenuButtonElementId', undefined, 0, button).then(() => button.click())
    })
    // A private window's sites keep nothing past it.
    foot.append(...(state?.private ? [security, menu] : [security, clear, menu]))
    panel.append(foot)
  }

  // Closes on a press elsewhere, Escape, or another page.
  const outside = (e: Event): void => {
    if (!panel) return
    const path = e.composedPath()
    if (path.includes(panel) || path.includes(opener)) return
    close()
  }
  addEventListener('pointerdown', outside, true)
  addEventListener('keydown', (e) => {
    if (panel && e.key === 'Escape') close()
  })
  addEventListener('blur', () => close())
  addEventListener('resize', () => close())

  subscribe((s) => {
    state = s
    place()
    if (panel && openFor !== s.activeEntryId) close()
    else render()
  })
}
