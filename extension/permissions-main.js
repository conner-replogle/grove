// Grove's permission prompts, page side. Runs in every frame's own JS world
// before the page's scripts.
//
// Chrome draws its permission prompts as native bubbles, which a Webium
// window has no place for (Chrome segfaults trying). So the web APIs that
// can ask for a permission are wrapped here: when the site hasn't been
// decided yet, Grove asks first (through permissions-relay.js, the bridge
// and the host, which shows the prompt in the tab's window) and stores the
// answer as Chrome's own site setting. Then the page's call goes through to
// Chrome, which answers it from that setting and never has to prompt.
//
// Device pickers, screen sharing and sign-in are Chrome's own dialogs,
// which a Webium window can't show either; for those Grove opens a small
// popup window of the same site (a classic Chrome window, where they do
// show) and makes the call there. See "Pickers" below.
//
// The wrappers are Proxies of the native functions and report the native
// source, so pages see the same functions they'd see without Grove.
;(() => {
  const REQUEST = 'grove:permission-request'
  const ANSWER = 'grove:permission-answer'
  // Grove's picker popups make the native calls themselves.
  const HELPER = 'grove-helper:'
  if (window.name.startsWith(HELPER)) return

  const nativeToString = Function.prototype.toString
  const disguised = new WeakMap()
  const toString = new Proxy(nativeToString, {
    apply: (target, self, args) => Reflect.apply(target, disguised.get(self) ?? self, args)
  })
  disguised.set(toString, nativeToString)
  Function.prototype.toString = toString

  const wrap = (owner, name, apply) => {
    const orig = owner?.[name]
    if (typeof orig !== 'function') return
    const proxy = new Proxy(orig, { apply })
    disguised.set(proxy, orig)
    owner[name] = proxy
  }

  // The page could replace these later; keep Chrome's own.
  const permissions = navigator.permissions
  const query = Permissions.prototype.query
  const featurePolicy = document.featurePolicy
  const allowsFeature = featurePolicy && Object.getPrototypeOf(featurePolicy).allowsFeature
  const dispatch = EventTarget.prototype.dispatchEvent.bind(document)

  // Grove's kinds: their Permissions API descriptors and permissions policy
  // features.
  const KINDS = {
    notifications: { query: { name: 'notifications' } },
    geolocation: { query: { name: 'geolocation' }, feature: 'geolocation' },
    camera: { query: { name: 'camera' }, feature: 'camera' },
    cameraPanTiltZoom: { query: { name: 'camera', panTiltZoom: true }, feature: 'camera' },
    microphone: { query: { name: 'microphone' }, feature: 'microphone' },
    clipboard: { query: { name: 'clipboard-read' }, feature: 'clipboard-read' },
    midi: { query: { name: 'midi' }, feature: 'midi' },
    midiSysex: { query: { name: 'midi', sysex: true }, feature: 'midi' },
    idleDetection: { query: { name: 'idle-detection' }, feature: 'idle-detection' },
    windowManagement: { query: { name: 'window-management' }, feature: 'window-management' },
    localFonts: { query: { name: 'local-fonts' }, feature: 'local-fonts' },
    storageAccess: { query: { name: 'storage-access' }, feature: 'storage-access' },
    localNetwork: { query: { name: 'local-network-access' } }
  }

  const state = (kind) =>
    Reflect.apply(query, permissions, [KINDS[kind].query]).then(
      (s) => s.state,
      () => 'granted' // Unknown to this Chrome: let the call go through.
    )
  const allowedHere = (kind) => {
    const feature = KINDS[kind].feature
    try {
      return !feature || !allowsFeature || Reflect.apply(allowsFeature, featurePolicy, [feature])
    } catch {
      return true
    }
  }

  // Asks Grove; resolves 'allow', 'block', 'dismiss', or 'fallback' when
  // Grove can't ask (no relay in this frame, or an opaque origin).
  let nextId = 0
  const waiting = new Map()
  document.addEventListener(ANSWER, (e) => {
    let a
    try {
      a = JSON.parse(e.detail)
    } catch {
      return
    }
    const w = waiting.get(a.id)
    if (!w) return
    if (a.decision === 'ack') {
      clearTimeout(w.timer)
      return
    }
    clearTimeout(w.timer)
    waiting.delete(a.id)
    w.resolve(a.decision)
  })
  const ask = (kinds) =>
    new Promise((resolve) => {
      const id = ++nextId
      const timer = setTimeout(() => {
        waiting.delete(id)
        resolve('fallback')
      }, 2000)
      waiting.set(id, { resolve, timer })
      dispatch(new CustomEvent(REQUEST, { detail: JSON.stringify({ id, kinds }) }))
    })

  // Runs `run` once every kind is decided (asking Grove for those that
  // aren't), or `refuse` if the prompt was dismissed.
  const gate = async (kinds, run, refuse) => {
    const open = []
    for (const kind of kinds) {
      if (allowedHere(kind) && (await state(kind)) === 'prompt') open.push(kind)
    }
    if (!open.length) return run()
    const decision = await ask(open)
    return decision === 'dismiss' ? refuse() : run()
  }
  const notAllowed = (message) => new DOMException(message, 'NotAllowedError')

  // ---- Notifications ----

  wrap(globalThis.Notification, 'requestPermission', (orig, self, args) => {
    const callback = typeof args[0] === 'function' ? args[0] : undefined
    const result = gate(
      ['notifications'],
      () => Reflect.apply(orig, self, []),
      () => 'default'
    )
    if (callback) result.then(callback)
    return result
  })
  wrap(globalThis.PushManager?.prototype, 'subscribe', (orig, self, args) =>
    gate(
      ['notifications'],
      () => Reflect.apply(orig, self, args),
      () => Promise.reject(notAllowed('Registration failed - permission denied'))
    )
  )

  // ---- Location ----

  const locationDenied = () => {
    const e = Object.create(GeolocationPositionError.prototype)
    Object.defineProperties(e, { code: { value: 1 }, message: { value: 'User denied Geolocation' } })
    return e
  }
  wrap(globalThis.Geolocation?.prototype, 'getCurrentPosition', (orig, self, args) => {
    if (typeof args[0] !== 'function') return Reflect.apply(orig, self, args)
    const error = args[1]
    void gate(
      ['geolocation'],
      () => Reflect.apply(orig, self, args),
      () => typeof error === 'function' && error(locationDenied())
    )
  })
  // watchPosition answers with an id right away, before Grove has asked:
  // the page gets Grove's id, which stands for Chrome's once there is one.
  const watches = new Map() // Grove's id -> Chrome's id, or null until it starts
  let nextWatch = 0
  wrap(globalThis.Geolocation?.prototype, 'watchPosition', (orig, self, args) => {
    if (typeof args[0] !== 'function') return Reflect.apply(orig, self, args)
    const id = ++nextWatch
    watches.set(id, null)
    const error = args[1]
    void gate(
      ['geolocation'],
      () => {
        if (watches.has(id)) watches.set(id, Reflect.apply(orig, self, args))
      },
      () => {
        watches.delete(id)
        if (typeof error === 'function') error(locationDenied())
      }
    )
    return id
  })
  wrap(globalThis.Geolocation?.prototype, 'clearWatch', (orig, self, args) => {
    if (!watches.has(args[0])) return Reflect.apply(orig, self, args)
    const real = watches.get(args[0])
    watches.delete(args[0])
    if (real !== null) Reflect.apply(orig, self, [real])
  })

  // ---- Camera and microphone ----

  wrap(globalThis.MediaDevices?.prototype, 'getUserMedia', (orig, self, args) => {
    const c = args[0]
    const v = c && typeof c === 'object' ? c.video : undefined
    const ptz = v && typeof v === 'object' && ['pan', 'tilt', 'zoom'].some((k) => v[k] !== undefined && v[k] !== false)
    const kinds = c && typeof c === 'object' ? [v && 'camera', ptz && 'cameraPanTiltZoom', c.audio && 'microphone'].filter(Boolean) : []
    if (!kinds.length) return Reflect.apply(orig, self, args)
    return gate(
      kinds,
      () => Reflect.apply(orig, self, args),
      () => Promise.reject(notAllowed('Permission dismissed'))
    )
  })

  // ---- MIDI, idle detection, window placement, fonts ----

  wrap(globalThis.Navigator?.prototype, 'requestMIDIAccess', (orig, self, args) =>
    gate(
      [args[0]?.sysex ? 'midiSysex' : 'midi'],
      () => Reflect.apply(orig, self, args),
      () => Promise.reject(notAllowed('Permission denied.'))
    )
  )
  wrap(globalThis.IdleDetector, 'requestPermission', (orig, self, args) =>
    gate(['idleDetection'], () => Reflect.apply(orig, self, args), () => 'denied')
  )
  wrap(window, 'getScreenDetails', (orig, self, args) =>
    gate(
      ['windowManagement'],
      () => Reflect.apply(orig, self, args),
      () => Promise.reject(notAllowed('Permission denied.'))
    )
  )
  wrap(window, 'queryLocalFonts', (orig, self, args) =>
    gate(
      ['localFonts'],
      () => Reflect.apply(orig, self, args),
      () => Promise.reject(notAllowed('Permission not granted.'))
    )
  )

  // ---- An embedded site asking for its cookies ----

  wrap(globalThis.Document?.prototype, 'requestStorageAccess', (orig, self, args) => {
    if (window === window.top) return Reflect.apply(orig, self, args)
    return gate(
      ['storageAccess'],
      () => Reflect.apply(orig, self, args),
      () => Promise.reject(notAllowed('Permission denied.'))
    )
  })

  // ---- Local network ----
  //
  // Chrome asks before a site reaches this computer or the local network
  // from a more public address. Grove asks first for fetch() and XHR to an
  // address it can tell is local (localhost, private and link-local IPs,
  // .local names); other requests (a name that resolves to a local address,
  // an <img>, a WebSocket) aren't caught here.

  const levelOf = (hostname) => {
    const h = hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h)) return 0
    if (
      h.endsWith('.local') ||
      /^10\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
      /^169\.254\./.test(h) ||
      /^f[cd][0-9a-f]{0,2}:/.test(h) ||
      /^fe80:/.test(h)
    )
      return 1
    return 2
  }
  const here = levelOf(location.hostname)
  const reachesInward = (url) => {
    try {
      const u = new URL(url, location.href)
      return /^(https?|wss?):$/.test(u.protocol) && levelOf(u.hostname) < here
    } catch {
      return false
    }
  }
  wrap(window, 'fetch', (orig, self, args) => {
    const input = args[0]
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url
    if (!url || !reachesInward(url)) return Reflect.apply(orig, self, args)
    return gate(
      ['localNetwork'],
      () => Reflect.apply(orig, self, args),
      () => Promise.reject(new TypeError('Failed to fetch'))
    )
  })
  const xhrs = new WeakMap()
  wrap(globalThis.XMLHttpRequest?.prototype, 'open', (orig, self, args) => {
    xhrs.set(self, { url: String(args[1]), async: args.length < 3 || !!args[2] })
    return Reflect.apply(orig, self, args)
  })
  wrap(globalThis.XMLHttpRequest?.prototype, 'send', (orig, self, args) => {
    const x = xhrs.get(self)
    if (!x || !x.async || !reachesInward(x.url)) return Reflect.apply(orig, self, args)
    void gate(
      ['localNetwork'],
      () => Reflect.apply(orig, self, args),
      () => {
        self.dispatchEvent(new ProgressEvent('error'))
        self.dispatchEvent(new ProgressEvent('loadend'))
      }
    )
  })

  // ---- Reading the clipboard ----

  for (const name of ['read', 'readText']) {
    wrap(globalThis.Clipboard?.prototype, name, (orig, self, args) =>
      gate(
        ['clipboard'],
        () => Reflect.apply(orig, self, args),
        () => Promise.reject(notAllowed('Read permission denied.'))
      )
    )
  }
  // ---- Pickers ----
  //
  // Chrome shows its device pickers, screen-share picker and sign-in
  // dialogs in the window of the page asking, and a Webium window has no
  // place for them: the call would wait forever. So Grove opens a small
  // popup window of the same site (window.open of a blank page, which is
  // this site's too) and makes the call there, with the popup's own copy of
  // the API. Chrome's dialog shows in the popup, and the answer comes back
  // to the page: devices the site may now use, or the shared stream. A
  // stream lives as long as the window that asked for it, so while sharing
  // the popup stays open to say so, with a Stop button.

  const nativeOpen = window.open
  const site = location.host
  const userActive = () => navigator.userActivation?.isActive ?? true

  const HELPER_CSS = `
    :root { color-scheme: light dark; font: 14px system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center;
      background: light-dark(#f3f3f3, #1c1c1c); color: light-dark(#1f1f1f, #eee); }
    main { max-width: 360px; padding: 20px 22px; border-radius: 14px;
      background: light-dark(#fff, #262626); box-shadow: 0 3px 8px rgba(0,0,0,.24); }
    h1 { margin: 0 0 6px; font-size: 15px; font-weight: 600; }
    p { margin: 0 0 16px; opacity: .7; }
    .buttons { display: flex; justify-content: flex-end; gap: 8px; }
    button { padding: 6px 16px; border: 0; border-radius: 8px; font: inherit; font-weight: 600; cursor: pointer;
      color: inherit; background: light-dark(rgba(0,0,0,.07), rgba(255,255,255,.1)); }
    button.primary { color: #fff; background: #3f7d58; }
  `

  // A Grove picker popup, or null if it couldn't open (no user activation).
  // It shows a blank page of this site; with `url` (a page of this site),
  // that page instead, for dialogs that need a real, secure page (passkeys).
  // `ready` settles once the popup's page is there to use.
  const openHelper = (url = '') => {
    let popup
    try {
      popup = Reflect.apply(nativeOpen, window, [url, HELPER + Math.random().toString(36).slice(2), 'popup,width=440,height=300'])
    } catch {}
    if (!popup) return null
    let onClose = () => {}
    const watch = setInterval(() => {
      if (!popup.closed) return
      clearInterval(watch)
      onClose()
    }, 250)
    const loaded = () => {
      try {
        return !url || (popup.location.href !== 'about:blank' && popup.document.readyState !== 'loading')
      } catch {
        return false // Another site's page: it redirected away.
      }
    }
    const ready = new Promise((resolve, reject) => {
      const started = Date.now()
      const check = () => {
        let sameSite = false
        try {
          sameSite = popup.location.origin === location.origin || popup.location.href === 'about:blank'
        } catch {}
        if (popup.closed || !sameSite || Date.now() - started > 15000) reject(new Error('helper'))
        else if (loaded()) resolve()
        else setTimeout(check, 50)
      }
      check()
    })
    return {
      popup,
      ready,
      // Replaces what the popup says: a heading, a line, and buttons
      // ([label, onClick, primary?]).
      show(heading, note, buttons = []) {
        const doc = popup.document
        const sheet = new popup.CSSStyleSheet()
        sheet.replaceSync(HELPER_CSS)
        doc.adoptedStyleSheets = [sheet]
        const body = doc.body ?? doc.documentElement.appendChild(doc.createElement('body'))
        doc.title = `Grove — ${heading}`
        const main = doc.createElement('main')
        const h = doc.createElement('h1')
        h.textContent = heading
        const n = doc.createElement('p')
        n.textContent = note
        const row = doc.createElement('div')
        row.className = 'buttons'
        for (const [label, onClick, primary] of buttons) {
          const b = doc.createElement('button')
          b.textContent = label
          if (primary) b.className = 'primary'
          b.addEventListener('click', onClick)
          row.append(b)
        }
        main.append(h, n, row)
        body.replaceChildren(main)
        row.querySelector('.primary')?.focus()
      },
      onClose(fn) {
        onClose = fn
      },
      close() {
        clearInterval(watch)
        popup.close()
      }
    }
  }

  // ---- USB, HID and serial devices ----

  const noDevice = () => new DOMException('No device selected.', 'NotFoundError')
  // The page's own device objects for what the person picked in the popup:
  // the ones the site couldn't use before, or else the ones that match.
  const sameDevice = (a, b) =>
    a.vendorId === b.vendorId && a.productId === b.productId && (a.serialNumber ?? a.productName) === (b.serialNumber ?? b.productName)
  const samePort = (a, b) => {
    const x = a.getInfo(), y = b.getInfo()
    return x.usbVendorId === y.usbVendorId && x.usbProductId === y.usbProductId
  }
  const DEVICE_APIS = [
    // [interface, method, list method, what, one or many, same]
    ['USB', 'requestDevice', 'getDevices', 'a USB device', 'one', sameDevice],
    ['HID', 'requestDevice', 'getDevices', 'a HID device', 'many', sameDevice],
    ['Serial', 'requestPort', 'getPorts', 'a serial port', 'one', samePort]
  ]
  for (const [iface, method, list, what, count, same] of DEVICE_APIS) {
    const proto = globalThis[iface]?.prototype
    const nativeList = proto?.[list]
    const property = iface.toLowerCase()
    wrap(proto, method, (orig, self, args) => {
      if (!userActive()) return Reflect.apply(orig, self, args)
      const helper = openHelper()
      if (!helper) return Reflect.apply(orig, self, args)
      const before = Reflect.apply(nativeList, self, []).catch(() => [])
      return new Promise((resolve, reject) => {
        let done = false
        const finish = (settle) => {
          if (done) return
          done = true
          helper.close()
          settle()
        }
        helper.onClose(() => finish(() => reject(noDevice())))
        helper.show(`${site} wants to connect to ${what}`, 'Choose it from the list Chromium shows next.', [
          ['Cancel', () => finish(() => reject(noDevice()))],
          [
            'Choose…',
            async () => {
              const pw = helper.popup
              try {
                const picked = await Reflect.apply(pw[iface].prototype[method], pw.navigator[property], args)
                const pickedList = count === 'many' ? picked : [picked]
                const known = new Set(await before)
                const now = await Reflect.apply(nativeList, self, [])
                const fresh = now.filter((d) => !known.has(d))
                const mine = pickedList.map((p) => fresh.find((d) => same(d, p)) ?? now.find((d) => same(d, p))).filter(Boolean)
                finish(() => (count === 'many' ? resolve(mine) : mine[0] ? resolve(mine[0]) : reject(noDevice())))
              } catch (e) {
                finish(() => reject(e))
              }
            },
            true
          ]
        ])
      })
    })
  }

  // ---- Sharing the screen, a window or a tab ----

  wrap(globalThis.MediaDevices?.prototype, 'getDisplayMedia', (orig, self, args) => {
    if (!userActive()) return Reflect.apply(orig, self, args)
    const helper = openHelper()
    if (!helper) return Reflect.apply(orig, self, args)
    return new Promise((resolve, reject) => {
      let settled = false
      const refuse = () => {
        if (settled) return
        settled = true
        helper.close()
        reject(notAllowed('Permission denied'))
      }
      helper.onClose(refuse)
      helper.show(`${site} wants to share your screen`, 'Choose what to share in the list Chromium shows next.', [
        ['Cancel', refuse],
        [
          'Choose…',
          async () => {
            const pw = helper.popup
            let stream
            try {
              stream = await Reflect.apply(pw.MediaDevices.prototype.getDisplayMedia, pw.navigator.mediaDevices, args)
            } catch (e) {
              if (settled) return
              settled = true
              helper.close()
              reject(e)
              return
            }
            settled = true
            const tracks = stream.getTracks()
            const stop = () => {
              tracks.forEach((t) => t.stop())
              helper.close()
            }
            helper.show(`Sharing with ${site}`, 'Closing this window stops sharing.', [['Stop sharing', stop, true]])
            helper.onClose(() => tracks.forEach((t) => t.stop()))
            // The site stopping its tracks (stop() fires no event) ends it too.
            const ended = setInterval(() => {
              if (tracks.every((t) => t.readyState === 'ended')) {
                clearInterval(ended)
                helper.close()
              }
            }, 500)
            window.focus()
            resolve(stream)
          },
          true
        ]
      ])
    })
  })

  // ---- Passkeys, security keys and signing in with another site ----
  //
  // Chrome only runs these on a page it got over a sound HTTPS connection,
  // which a blank popup isn't, so the popup loads this site's robots.txt
  // (small, and on the site itself) and makes the call there.
  //
  // Signing in with another site (FedCM) is hidden from feature checks, so
  // sites fall back to their own in-page prompts: Google's One Tap shows its
  // card in the page instead of asking for FedCM on load, which would open
  // a window by itself. A FedCM call made anyway gets the popup only from a
  // click; without one it fails, as Chrome's would with nowhere to show it.

  delete window.IdentityCredential
  for (const name of ['get', 'create']) {
    wrap(globalThis.CredentialsContainer?.prototype, name, (orig, self, args) => {
      const options = args[0]
      const dialog = options && typeof options === 'object' && (options.publicKey || options.identity)
      // Passkey autofill waits quietly for the person to pick one; leave it.
      if (!dialog || options.mediation === 'conditional' || location.protocol !== 'https:') return Reflect.apply(orig, self, args)
      if (options.identity && !options.publicKey && !userActive())
        return Promise.reject(new DOMException('Error retrieving a token.', 'NetworkError'))
      const helper = openHelper(`${location.origin}/robots.txt`)
      if (!helper) return Reflect.apply(orig, self, args)
      return new Promise((resolve, reject) => {
        let settled = false
        const settle = (fn) => {
          if (settled) return
          settled = true
          helper.close()
          fn()
        }
        const cancel = () => settle(() => reject(notAllowed('The operation either timed out or was not allowed.')))
        helper.onClose(cancel)
        helper.ready.then(() => {
          helper.show(`Signing in to ${site}`, 'Follow the steps Chromium shows.', [['Cancel', cancel]])
          const pw = helper.popup
          Reflect.apply(pw.CredentialsContainer.prototype[name], pw.navigator.credentials, args).then(
            (credential) => settle(() => resolve(credential)),
            (e) => settle(() => reject(e))
          )
        }, cancel)
      })
    })
  }

  // ---- Opening links of a kind (mailto:, web+...) with this site ----

  // Chrome only opens its question when the call comes from a click, so the
  // call is made from one in the popup; answering is Chrome's, in the popup.
  wrap(globalThis.Navigator?.prototype, 'registerProtocolHandler', (orig, self, args) => {
    if (!userActive()) return Reflect.apply(orig, self, args)
    const helper = openHelper()
    if (!helper) return Reflect.apply(orig, self, args)
    const scheme = String(args[0]).replace(/^web\+/, '')
    const done = () => helper.close()
    helper.onClose(() => {})
    helper.show(`${site} wants to open ${scheme} links`, 'Chromium asks next, at the top of this window.', [
      ['Cancel', done],
      [
        'Continue…',
        () => {
          const pw = helper.popup
          try {
            Reflect.apply(pw.Navigator.prototype.registerProtocolHandler, pw.navigator, args)
          } catch {
            done()
            return
          }
          helper.show(`${site} wants to open ${scheme} links`, 'Answer Chromium’s question above, then close this window.', [
            ['Done', done, true]
          ])
        },
        true
      ]
    ])
  })
})()
