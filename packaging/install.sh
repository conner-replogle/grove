#!/bin/sh
# Installs Grove from its latest GitHub release:
#
#   curl -fsSL https://github.com/conner-replogle/grove/releases/latest/download/install.sh | sh
#
# Linux: ~/.local/opt/grove, the `grove` command in ~/.local/bin, and a
# desktop entry and icons in ~/.local/share. macOS: Grove.app in
# /Applications (~/Applications if that isn't writable). Run it again to
# reinstall; Grove also updates itself.
#
#   GROVE_VERSION=0.2.0       a release other than the latest
#   GROVE_BUNDLE=<file>       install a bundle on disk (scripts/bundle.mjs)
#   GROVE_INSTALL_DIR=<dir>   install somewhere else
#   GROVE_REPO=owner/name     another repository (default conner-replogle/grove)
set -eu

repo="${GROVE_REPO:-conner-replogle/grove}"
say() { printf '%s\n' "$*"; }
die() { printf 'grove install: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=macos ;;
  *) die "Grove runs on Linux and macOS, not $(uname -s)" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) die "no Grove build for $(uname -m)" ;;
esac
# A shell under Rosetta on an Apple silicon Mac still wants the arm64 build.
if [ "$os" = macos ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi
platform="$os-$arch"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT INT TERM

fetch() { curl -fL --proto '=https' --tlsv1.2 --retry 3 -o "$2" "$1"; }

if [ -n "${GROVE_BUNDLE:-}" ]; then
  bundle="$GROVE_BUNDLE"
  [ -f "$bundle" ] || die "no file $bundle"
else
  command -v curl >/dev/null || die "needs curl"
  version="${GROVE_VERSION:-}"
  if [ -z "$version" ]; then
    version="$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" |
      sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1)"
    [ -n "$version" ] || die "couldn't find Grove's latest release on github.com/$repo"
  fi
  version="${version#v}"
  name="grove-$version-$platform.tar.xz"
  base="https://github.com/$repo/releases/download/v$version"
  say "Downloading Grove $version for $platform…"
  bundle="$work/$name"
  fetch "$base/$name" "$bundle" || die "no $name in release v$version"
  if fetch "$base/SHA256SUMS" "$work/SHA256SUMS" 2>/dev/null; then
    want="$(grep " $name\$" "$work/SHA256SUMS" | cut -d' ' -f1)"
    if command -v sha256sum >/dev/null; then got="$(sha256sum "$bundle" | cut -d' ' -f1)"
    else got="$(shasum -a 256 "$bundle" | cut -d' ' -f1)"; fi
    [ -n "$want" ] && [ "$want" = "$got" ] || die "$name doesn't match the release's SHA256SUMS"
  fi
fi

say "Unpacking…"
mkdir -p "$work/unpacked"
tar -xJf "$bundle" -C "$work/unpacked"

# Puts a new copy in place of an old one, keeping the old until the end.
swap() {
  new="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  rm -rf "$dest.new" "$dest.old"
  mv "$new" "$dest.new"
  [ -e "$dest" ] && mv "$dest" "$dest.old"
  mv "$dest.new" "$dest"
  rm -rf "$dest.old"
}

# The `grove` command (for `grove sync`), in ~/.local/bin. Something else
# there that isn't a link (a developer's install.sh wrote a script) is kept
# once as grove.before-installer.
link_command() {
  bin="$HOME/.local/bin/grove"
  mkdir -p "$(dirname "$bin")"
  if [ -e "$bin" ] && [ ! -L "$bin" ] && [ ! -e "$bin.before-installer" ]; then mv "$bin" "$bin.before-installer"; fi
  ln -sf "$1" "$bin"
}

if [ "$os" = linux ]; then
  [ -x "$work/unpacked/grove/grove" ] || die "that isn't a Linux Grove bundle"
  dest="${GROVE_INSTALL_DIR:-$HOME/.local/opt/grove}"
  swap "$work/unpacked/grove" "$dest"

  link_command "$dest/grove"

  share="${XDG_DATA_HOME:-$HOME/.local/share}"
  for png in "$dest"/icons/grove-*.png; do
    size="$(basename "$png" .png)"
    size="${size#grove-}"
    mkdir -p "$share/icons/hicolor/${size}x${size}/apps"
    cp "$png" "$share/icons/hicolor/${size}x${size}/apps/grove.png"
  done
  mkdir -p "$share/icons/hicolor/scalable/apps" "$share/applications"
  cp "$dest/icons/grove.svg" "$share/icons/hicolor/scalable/apps/grove.svg"
  cat >"$share/applications/grove.desktop" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=Grove
GenericName=Web Browser
Comment=Browse the web with workspaces
Exec=$dest/grove %U
Icon=grove
Terminal=false
StartupNotify=true
Categories=Network;WebBrowser;
MimeType=text/html;application/xhtml+xml;x-scheme-handler/http;x-scheme-handler/https;
Actions=new-window;

[Desktop Action new-window]
Name=New Window
Exec=$dest/grove --new-window
EOF
  command -v update-desktop-database >/dev/null && update-desktop-database "$share/applications" >/dev/null 2>&1 || true
  command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q "$share/icons/hicolor" >/dev/null 2>&1 || true

  say "Installed Grove in $dest."
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) say "Start it from your app launcher, or run: grove" ;;
    *) say "Start it from your app launcher, or run: $bin  (~/.local/bin isn't on your PATH)" ;;
  esac
else
  [ -d "$work/unpacked/Grove.app" ] || die "that isn't a macOS Grove bundle"
  # Where it was installed before, else /Applications if it's writable.
  if [ -n "${GROVE_INSTALL_DIR:-}" ]; then dest="$GROVE_INSTALL_DIR/Grove.app"
  elif [ -d /Applications/Grove.app ]; then dest=/Applications/Grove.app
  elif [ -d "$HOME/Applications/Grove.app" ]; then dest="$HOME/Applications/Grove.app"
  elif [ -w /Applications ]; then dest=/Applications/Grove.app
  else dest="$HOME/Applications/Grove.app"; fi
  # Downloaded with curl it carries no quarantine, but a copied bundle might.
  xattr -cr "$work/unpacked/Grove.app" 2>/dev/null || true
  swap "$work/unpacked/Grove.app" "$dest"
  link_command "$dest/Contents/MacOS/Grove"
  say "Installed $dest. Open it from Launchpad or Spotlight."
fi
