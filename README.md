# grove-ui

Grove's browser UI, written as a web app on top of Chromium's own WebUI
browser ("Webium", `chrome://webui-browser`). The tabs, extensions, password
manager, printing and the rest stay real Chrome; this repo only changes how
the window looks and behaves.

No Chromium build is needed to work on it: the launcher starts the installed
Grove binary with Webium turned on and injects this UI into every window over
a private DevTools pipe, before the window's own scripts run.

```sh
mise i && pnpm install
pnpm dev            # launch Grove with this UI; rebuilds and reloads on save
pnpm start          # the same without watching
```

`GROVE_CHROME` picks the browser binary (default the system `chromium`; any
Chromium 152 or later with Webium works, e.g. ungoogled-chromium, but not the
Grove Chromium fork, whose own workspace service fights this one) and
`GROVE_PROFILE` the profile (default `~/.config/grove-webium`).

## Layout

- `launcher/` — starts the browser and injects the UI (`cdp.mjs` is the pipe client)
- `src/main.ts` — entry point, runs inside `chrome://webui-browser`
- `src/patch.ts` — hooks into Webium's Lit components (extra styles, method patches)
- `src/styles/` — CSS added to Webium's components

Chrome's own modules (`//resources/...`, `/tab_strip_api/...`) are not
bundled; the UI loads them from the binary at runtime.

## Sync

Grove syncs its whole workspace model between devices: workspaces, the
Essentials, every tab and folder, each workspace's active tab and the last
workspace used. At launch, a device picks up where you were on another one
(unless you've already started doing something). Each field merges
last-writer-wins by hybrid logical clock stamp, and order uses fractional
keys, so two devices' edits merge cleanly. See `host/sync/`.

It's end-to-end encrypted: the server (`sync-worker/`, a Cloudflare Worker
with one Durable Object per account) only stores sealed change batches and
hands them on; devices do all merging. One secret gives each device the
account id, the server token and the AES-GCM key.

```sh
cd sync-worker && pnpm install && pnpm run deploy   # once: your own sync server
grove sync setup https://grove-ui-sync.<you>.workers.dev
grove sync join <url> <secret>                      # on each other device
grove sync status
```

Set `ACCOUNTS` (comma-separated account ids, from `grove sync status`) on
the Worker to turn away anyone else.
