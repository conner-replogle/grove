#!/usr/bin/env bash
# Installs this checkout as the `grove` command and desktop app:
# builds the UI, copies what the launcher needs to ~/.local/opt/grove-ui,
# and points ~/.local/bin/grove at it. Run it again to update.
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
mkdir -p "$dest"
rsync -a --delete launcher host shared extension dist package.json "$dest/"

# Keep whatever `grove` was before (the Chromium fork's launcher) once.
if [ -f "$bin" ] && ! grep -q grove-ui "$bin" && [ ! -e "$bin.before-grove-ui" ]; then
  cp "$bin" "$bin.before-grove-ui"
fi
mkdir -p "$(dirname "$bin")"
cat > "$bin" <<SH
#!/usr/bin/env bash
# Grove (grove-ui, installed from $(pwd) by install.sh).
if [ "\${1:-}" = sync ]; then exec "$node" "$dest/launcher/grove.mjs" "\$@"; fi
log="\${XDG_CACHE_HOME:-\$HOME/.cache}/grove/grove.log"
mkdir -p "\$(dirname "\$log")"
exec "$node" "$dest/launcher/grove.mjs" "\$@" >>"\$log" 2>&1
SH
chmod +x "$bin"
echo "installed: $bin -> $dest"
