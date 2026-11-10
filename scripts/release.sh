#!/usr/bin/env bash
# Starts a Grove release, which installed copies offer as an update
# (host/updates.ts):
#
#   scripts/release.sh 0.2.0          # or: pnpm release 0.2.0
#
# Checks the tree is clean, on master and in step with GitHub, that the
# release key secret is there and the tests pass; sets package.json's
# version, commits and tags v<version>, and pushes both at once. The tag
# starts the Release workflow (.github/workflows/release.yml), which builds
# the UI tarball and every platform's bundle and DMG, smoke-tests the Linux
# bundle, signs SHA256SUMS and publishes the release; this script follows
# it to the end. Needs the GitHub CLI (gh), logged in.
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
branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != master ]; then
  echo "releases come from master (this is $branch)" >&2
  exit 1
fi
git fetch -q origin master
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/master)" ] &&
  ! git merge-base --is-ancestor origin/master HEAD; then
  echo "master and origin/master have gone different ways: pull first" >&2
  exit 1
fi
if ! gh secret list | grep -q '^GROVE_RELEASE_KEY\b'; then
  echo "the GROVE_RELEASE_KEY secret isn't set: the release couldn't be signed (see docs/releasing.md)" >&2
  exit 1
fi

pnpm exec tsc --noEmit
pnpm exec vitest run

node -e "
  const fs = require('fs')
  const p = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  p.version = '$version'
  fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n')"
git commit -qm "Release $tag" package.json
git tag -a "$tag" -m "Grove $version"

# Both or neither: a tag without its commit on master would be a release of
# something master doesn't have.
git push --atomic origin master "$tag"
echo "pushed $tag; the Release workflow builds, tests and publishes it"
# The tag's run (it can take a few seconds to show up).
run=""
for _ in $(seq 30); do
  run="$(gh run list --workflow release.yml --branch "$tag" --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)"
  [ -n "$run" ] && break
  sleep 2
done
if [ -z "$run" ]; then
  echo "couldn't find the Release run; see: gh run list --workflow release.yml" >&2
  exit 1
fi
if gh run watch "$run" --exit-status; then
  echo "released $tag: $(gh release view "$tag" --json url -q .url)"
else
  echo "the Release run failed; nothing was published. Fix it, then: gh run rerun $run --failed" >&2
  exit 1
fi
