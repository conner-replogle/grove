# Releasing Grove

```
pnpm release 0.8.0
```

`scripts/release.sh` checks that the tree is clean, that you're on master in
step with GitHub, that the `GROVE_RELEASE_KEY` secret exists and that the
tests pass. It then commits the version, tags `v0.8.0`, pushes both at once
and follows the Release workflow until it finishes.

The workflow (`.github/workflows/release.yml`) builds:

- the UI tarball;
- a bundle for every platform (Chromium, Node, the app and the start script);
- the macOS DMGs.

Before publishing, it starts the Linux x64 bundle under Xvfb and waits for
its UI to come up (`scripts/smoke.mjs`). It then writes `SHA256SUMS`, signs it
(`SHA256SUMS.sig`) and publishes the release. If any job fails, nothing is
published: fix it and `gh run rerun <id> --failed`.

## The release key

Installed copies only install a release whose `SHA256SUMS` is signed with
Grove's release key: an ed25519 key whose public half is `RELEASE_KEY` in
`host/updates.ts`. The private half:

- is the `GROVE_RELEASE_KEY` Actions secret, which only the publish job sees;
- lives in `~/.config/grove-release/release-key.pem` on the machine it was
  made on. Keep a copy somewhere safe (a password manager). Without it,
  releases can't be signed, and installed copies won't update until they're
  reinstalled with a new key.

To set the secret: `gh secret set GROVE_RELEASE_KEY < ~/.config/grove-release/release-key.pem`.

**If the key leaks:** make a new one, put its public half in
`host/updates.ts`, and release with the *old* key one last time, so copies
learn the new key. Then replace the secret. Anyone holding the old key can
also sign releases until users have that one.

## What reaches installed copies

- **Most releases** are UI updates. The app (`launcher host shared extension
  dist`) is unpacked beside the installed one and swapped in. Grove runs it
  from the next start.
- **A release that changes the Chromium or Node pins**
  (`packaging/pins.json`) is a full update. So is one that changes a
  platform's start script or Chromium patch (the `packaging` fingerprints in
  `grove-<version>.json`, from `scripts/bundle.mjs`). For a full update, the
  whole bundle is staged as `<bundle>.new` and the start script swaps it in
  at the next start. A copy whose bundle's start script is older than the
  release it runs is offered that release's bundle too.

## When a release doesn't start

The start scripts (`packaging/linux/grove`, `packaging/macos/Grove`,
`packaging/windows/main.go`) give a new app two starts to come up. The
launcher writes `.healthy` into the app once a window's UI is up and the
host has Chrome's tabs. After two starts without it, the previous app
(`app.old`) goes back and the failed one is kept as `app.bad`. Its version
goes in `<data>/skip-version`, so it isn't offered again; the next release
is. A start that only hands a link to a running Grove doesn't count.

`<data>` is `~/.local/share/grove` on Linux,
`~/Library/Application Support/Grove` on macOS and `%LOCALAPPDATA%\Grove` on
Windows.

To go back to a release by hand, run its installer:
`GROVE_VERSION=0.7.1 sh install.sh` (or `install.ps1`). The installer leaves
`<data>/use-bundle-app`, which makes the start script use the bundle's app
even when the copy there is newer.

`install.sh` in a checkout marks its copy healthy and as a checkout: the
start script never rolls it back, and its UI hot-reloads.
