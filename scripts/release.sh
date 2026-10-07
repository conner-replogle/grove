#!/usr/bin/env bash
# Publishes a Grove release on GitHub, which installed copies offer as an
# update (host/updates.ts):
#
#   scripts/release.sh 0.2.0          # or: pnpm release 0.2.0
#
# Checks the tree is clean and the tests pass, sets package.json's version,
# commits and tags v<version>, builds the UI, packs what the launcher needs
# (the same files install.sh copies) into grove-ui-<version>.tar.gz, pushes
# the commit and tag, and creates the release with that tarball attached and
# notes from the commits since the last release. Needs the GitHub CLI (gh).
set -euo pipefail
cd "$(dirname "$0")/.."

version="${1:-}"
version="${version#v}"
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: scripts/release.sh <major.minor.patch>" >&2
  exit 1
fi
tag="v$version"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "commit or set aside your changes first" >&2
  exit 1
fi
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "$tag already exists" >&2
  exit 1
fi
current="$(node -p 'require("./package.json").version')"
if [ "$(node -e "
  const p = (v) => v.split('.').map(Number)
  const [a, b] = [p('$version'), p('$current')]
  console.log(a[0] - b[0] || a[1] - b[1] || a[2] - b[2])")" -le 0 ]; then
  echo "$version isn't newer than $current" >&2
  exit 1
fi
gh auth status >/dev/null

pnpm exec tsc --noEmit
pnpm exec vitest run

node -e "
  const fs = require('fs')
  const p = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  p.version = '$version'
  fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n')"
git commit -qm "Release $tag" package.json
git tag -a "$tag" -m "Grove $version"

node build.mjs
out="$(mktemp -d)"
tarball="$out/grove-ui-$version.tar.gz"
tar -czf "$tarball" launcher host shared extension dist package.json

branch="$(git rev-parse --abbrev-ref HEAD)"
git push origin "$branch" "$tag"
previous="$(git describe --tags --abbrev=0 "$tag^" 2>/dev/null || true)"
gh release create "$tag" "$tarball" --title "Grove $version" --generate-notes ${previous:+--notes-start-tag "$previous"}
rm -rf "$out"
echo "released $tag"
