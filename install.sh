#!/usr/bin/env bash
# Installs this checkout as the `grove` command and desktop app:
# builds the UI, copies what the launcher needs to ~/.local/opt/grove-ui,
# and points ~/.local/bin/grove at it. Run it again to update.
#
# Where Grove was installed from a release (~/.local/bin/grove links to a
# bundle's launcher, packaging/linux/grove), the checkout goes into the
# copy of the app that bundle runs instead, keeping its Chromium, Node and
# launcher (the release's updates still replace it).
set -euo pipefail
cd "$(dirname "$0")"

dest="$HOME/.local/opt/grove-ui"
bin="$HOME/.local/bin/grove"
node="$(command -v node)"
if [ "$(node -p 'process.versions.node.split(".")[0] >= 23')" != true ]; then
  echo "Grove needs Node 23+ (it runs the host's TypeScript directly); found $(node -v)" >&2
  exit 1
fi

node build.mjs

bundle="$(dirname "$(readlink -f "$bin" 2>/dev/null || echo "$bin")")"
if [ -f "$bundle/bundle.json" ]; then
  app="${XDG_DATA_HOME:-$HOME/.local/share}/grove/app"
  mkdir -p "$app"
  rsync -a --delete --exclude .installed --exclude .healthy --exclude .starts \
    launcher host shared extension dist package.json "$app/"
  # A checkout's copy: the launcher hot-reloads its UI, and the start
  # script never rolls it back (that's for releases that don't start).
  echo "checkout $(pwd) $(git rev-parse --short HEAD 2>/dev/null || true)" > "$app/.installed"
  date -u +%FT%TZ > "$app/.healthy"
  rm -f "$app/.starts"
  echo "installed into the release install: $app"
  echo "restart Grove for host and extension changes (the UI reloads itself)"
  exit 0
fi

mkdir -p "$dest"
rsync -a --delete launcher host shared extension dist package.json "$dest/"
# Marks the copy as installed: it may update itself from GitHub releases.
echo "checkout $(pwd) $(git rev-parse --short HEAD 2>/dev/null || true)" > "$dest/.installed"

# Keep whatever `grove` was before (the Chromium fork's launcher) once.
if [ -f "$bin" ] && ! grep -q grove-ui "$bin" && [ ! -e "$bin.before-grove-ui" ]; then
  cp "$bin" "$bin.before-grove-ui"
fi
mkdir -p "$(dirname "$bin")"
# Never write through a link into whatever it points at.
[ -L "$bin" ] && rm "$bin"
cat > "$bin" <<SH
#!/usr/bin/env bash
# Grove (grove-ui, installed from $(pwd) by install.sh).
case "\${1:-}" in sync | mcp) exec "$node" "$dest/launcher/grove.mjs" "\$@" ;; esac
log="\${XDG_CACHE_HOME:-\$HOME/.cache}/grove/grove.log"
mkdir -p "\$(dirname "\$log")"
exec "$node" "$dest/launcher/grove.mjs" "\$@" >>"\$log" 2>&1
SH
chmod +x "$bin"
echo "installed: $bin -> $dest"
