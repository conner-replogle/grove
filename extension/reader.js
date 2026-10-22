// Reader view: the page's article (Mozilla's Readability, readability.js,
// run before this) shown alone over the page, in a column of readable
// type. Run again, or Escape or the close button, puts the page back. The
// page itself stays as it was underneath, so its URL and history don't
// change. The grove-bridge runs both files in the tab
// (chrome.scripting.executeScript); this file's last value is whether
// reader view is now on, or null if the page has no article.
;(() => {
  const ID = 'grove-reader'
  const open = document.getElementById(ID)
  if (open) {
    open.dispatchEvent(new Event('grove-reader-close'))
    return false
  }
  // eslint-disable-next-line no-undef
  const article = new Readability(document.cloneNode(true)).parse()
  if (!article?.content) return null

  const host = document.createElement('div')
  host.id = ID
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647'
  const root = host.attachShadow({ mode: 'closed' })
  // A constructed sheet: pages' style-src CSP doesn't apply to it.
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(`
    :host { color-scheme: light dark; }
    #gr-page {
      position: absolute; inset: 0; overflow: auto;
      background: light-dark(#fbfaf7, #1c1c1e); color: light-dark(#1d1d1f, #e6e6e9);
      font: 19px/1.65 Charter, 'Iowan Old Style', Georgia, 'Noto Serif', serif;
      -webkit-font-smoothing: antialiased;
    }
    #gr-article { max-width: 680px; margin: 0 auto; padding: 64px 24px 96px; }
    #gr-site { font: 600 13px system-ui, sans-serif; letter-spacing: .02em; text-transform: uppercase; opacity: .55; }
    #gr-title { font: 700 34px/1.2 system-ui, sans-serif; margin: 10px 0 8px; }
    #gr-byline { font: 14px system-ui, sans-serif; opacity: .6; margin-bottom: 32px; }
    #gr-body img, #gr-body video, #gr-body figure, #gr-body picture { max-width: 100%; height: auto; }
    #gr-body figure { margin: 24px 0; }
    #gr-body figcaption { font: 14px system-ui, sans-serif; opacity: .65; margin-top: 6px; }
    #gr-body a { color: light-dark(#2f6fd6, #8fb8ff); }
    #gr-body pre, #gr-body code { font: 15px ui-monospace, monospace; }
    #gr-body pre { overflow: auto; padding: 12px 14px; border-radius: 8px; background: light-dark(rgba(0,0,0,.05), rgba(255,255,255,.07)); }
    #gr-body blockquote { margin: 20px 0; padding-left: 18px; border-left: 3px solid light-dark(rgba(0,0,0,.15), rgba(255,255,255,.2)); }
    #gr-body table { border-collapse: collapse; }
    #gr-body td, #gr-body th { padding: 4px 8px; border: 1px solid light-dark(rgba(0,0,0,.12), rgba(255,255,255,.14)); }
    #gr-close {
      position: fixed; top: 14px; right: 18px; width: 34px; height: 34px;
      display: grid; place-items: center; border: none; border-radius: 10px; cursor: pointer;
      background: light-dark(rgba(0,0,0,.06), rgba(255,255,255,.09)); color: inherit;
      font: 20px/1 system-ui, sans-serif;
    }
    #gr-close:hover { background: light-dark(rgba(0,0,0,.1), rgba(255,255,255,.15)); }
  `)
  root.adoptedStyleSheets = [sheet]

  const page = document.createElement('div')
  page.id = 'gr-page'
  page.tabIndex = -1
  const close = document.createElement('button')
  close.id = 'gr-close'
  close.title = 'Close reader view (Esc)'
  close.textContent = '×'
  const body = document.createElement('article')
  body.id = 'gr-article'
  const site = document.createElement('div')
  site.id = 'gr-site'
  site.textContent = article.siteName || location.hostname
  const title = document.createElement('h1')
  title.id = 'gr-title'
  title.textContent = article.title || document.title
  const byline = document.createElement('div')
  byline.id = 'gr-byline'
  byline.textContent = article.byline || ''
  const content = document.createElement('div')
  content.id = 'gr-body'
  // Readability's article, as it cleaned it: the page's own markup, without
  // its scripts.
  content.innerHTML = article.content
  body.append(site, title, byline, content)
  page.append(close, body)
  root.append(page)

  const overflow = document.documentElement.style.overflow
  document.documentElement.style.overflow = 'hidden'
  const onKey = (e) => {
    if (e.key === 'Escape') host.dispatchEvent(new Event('grove-reader-close'))
  }
  host.addEventListener('grove-reader-close', () => {
    removeEventListener('keydown', onKey, true)
    document.documentElement.style.overflow = overflow
    host.remove()
  })
  close.addEventListener('click', () => host.dispatchEvent(new Event('grove-reader-close')))
  addEventListener('keydown', onKey, true)
  document.documentElement.append(host)
  page.focus()
  return true
})()
