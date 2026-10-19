#!/usr/bin/env bash
# Starts a Grove release, which installed copies offer as an update
# (host/updates.ts):
#
#   scripts/release.sh 0.2.0          # or: pnpm release 0.2.0
#
# Checks the tree is clean and the tests pass, sets package.json's version,
# commits and tags v<version>, and pushes both. The tag starts the Release
# workflow (.github/workflows/release.yml), which builds the UI tarball and
# every platform's bundle and DMG and publishes the release. Needs the
# GitHub CLI (gh) to follow it.
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

branch="$(git rev-parse --abbrev-ref HEAD)"
git push origin "$branch" "$tag"
echo "pushed $tag; the Release workflow builds and publishes it:"
sleep 5
gh run list --workflow release.yml --limit 1
