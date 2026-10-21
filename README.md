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
Extra Chrome flags go in `~/.config/grove-flags.conf`, one or more to a
line, like Arch's `chromium-flags.conf` (Grove's bundled Chromium doesn't
read that one), e.g. `--password-store=gnome-libsecret` on a desktop
where Chrome can't tell which keyring to use.

## Installing

```sh
curl -fsSL https://github.com/conner-replogle/grove/releases/latest/download/install.sh | sh
```

installs the latest release for Linux (x64, arm64) or macOS (Apple
silicon, Intel): on Linux in `~/.local/opt/grove` with a desktop entry and
icons, on macOS as `Grove.app` (a DMG is in every release too). A
release bundles everything Grove needs: a pinned ungoogled-chromium and
Node (`packaging/pins.json`) and Grove itself, under Grove's name and icon
(`branding/`, made by `scripts/icons.mjs`). The Mac app is signed ad hoc,
not with an Apple Developer ID.

The bundle's start script (`packaging/linux/grove`, `packaging/macos/Grove`)
runs Grove from a copy of its app in the user's data directory
(`~/.local/share/grove`, `~/Library/Application Support/Grove`), which is
what updates replace.

`./install.sh` is the developer's install: this checkout, with the system
Chromium and mise's Node.

## Releases and updates

```sh
pnpm release 0.2.0     # = scripts/release.sh: tests, tag v0.2.0, push
```

The tag starts the Release workflow (`.github/workflows/release.yml`), which
builds the UI tarball `grove-ui-<version>.tar.gz`, a bundle per platform
(`scripts/bundle.mjs`) and the DMGs, and publishes them with `install.sh`
and `SHA256SUMS`. `node scripts/bundle.mjs linux-x64` builds one locally
(macOS bundles need macOS).

An installed Grove checks GitHub's latest release a minute after launch and
every six hours, and offers it at the bottom of the sidebar. Most updates
download only the UI tarball. A release that pins another Chromium or Node
downloads the whole bundle for the platform, which the start script swaps
in at the next start. Every download is checked against `SHA256SUMS`.
No token is needed; `GROVE_GITHUB_TOKEN`/`GITHUB_TOKEN` is sent if set.

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

Grove's public sync server is invite only: a new account needs an invite
code, from the settings (Sync → Or start syncing) or the CLI. Devices that
join an account with its sync code need no invite.

```sh
grove sync setup --invite XXXX-XXXX-XXXX           # a new account, on the public server
grove sync join <sync-code>                         # on each other device
grove sync status
```

To run your own server: `cd sync-worker && pnpm install && pnpm run deploy`,
then `wrangler secret put ADMIN_TOKEN` and give its URL to
`grove sync setup`. The admin makes invites with
`GROVE_SYNC_ADMIN_TOKEN=<token> grove sync invite [note] --server <url>`
(`invites` lists them, `revoke <code>` takes back an unused one). Set
`OPEN_SIGNUP` to `"true"` in `wrangler.jsonc` to need no invites.

## Organize

Organize sorts a workspace's loose tabs into folders with Cloudflare Workers
AI, on the user's own Cloudflare account: it's off until they give a
Workers AI account ID and API token in the settings. The token stays on
the device (`<profile>/grove-workers-ai.json`). Organize is NOT end-to-end
encrypted: the titles and addresses (without queries) of the tabs it sorts
go to Cloudflare.
