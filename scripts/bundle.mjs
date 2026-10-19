#!/usr/bin/env node
// Builds an installable Grove for one platform: the pinned Chromium and Node
// (packaging/pins.json, checked against their SHA-256) with Grove's app and
// start script, under Grove's name and icon.
//
//   node scripts/bundle.mjs <platform> [--out <dir>]
//
// <platform> is linux-x64, linux-arm64, macos-arm64 or macos-x64. Writes to
// <dir> (default release/):
//   grove-<version>-<platform>.tar.xz   the bundle (what installers and the
//                                       updater unpack)
//   Grove-<version>-<platform>.dmg      macOS only: drag to Applications
//   grove-<version>.json                what the release pins (the updater
//                                       reads it to choose a full update)
//
// A Linux bundle can be built anywhere; a macOS one needs macOS (hdiutil,
// plutil, codesign). Downloads are cached in ~/.cache/grove-bundle.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const PLATFORMS = ['linux-x64', 'linux-arm64', 'macos-arm64', 'macos-x64']
// What the launcher needs of the checkout (as install.sh copies it).
const APP_FILES = ['launcher', 'host', 'shared', 'extension', 'dist', 'package.json']

const args = process.argv.slice(2)
const platform = args.find((a) => PLATFORMS.includes(a))
const outAt = args.indexOf('--out')
const out = resolve(outAt >= 0 ? args[outAt + 1] : join(root, 'release'))
if (!platform) {
  console.error(`usage: node scripts/bundle.mjs <${PLATFORMS.join('|')}> [--out <dir>]`)
  process.exit(1)
}
const mac = platform.startsWith('macos')
if (mac && process.platform !== 'darwin') {
  console.error('a macOS bundle needs macOS (hdiutil, codesign)')
  process.exit(1)
}

const pins = JSON.parse(readFileSync(join(root, 'packaging/pins.json'), 'utf8'))
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const cache = join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'grove-bundle')
const run = (cmd, a, opts = {}) => execFileSync(cmd, a, { stdio: 'inherit', ...opts })

async function fetchPinned(what) {
  const { url, sha256 } = pins[what][platform]
  const file = join(cache, basename(new URL(url).pathname))
  const hash = (f) => createHash('sha256').update(readFileSync(f)).digest('hex')
  if (!existsSync(file) || hash(file) !== sha256) {
    console.log(`downloading ${what} ${pins[what].version} for ${platform}`)
    mkdirSync(cache, { recursive: true })
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
    writeFileSync(file, Buffer.from(await res.arrayBuffer()))
    if (hash(file) !== sha256) {
      rmSync(file)
      throw new Error(`${basename(file)} isn't the pinned build (SHA-256 differs)`)
    }
  }
  return file
}

const chromium = await fetchPinned('chromium')
const node = await fetchPinned('node')

run(process.execPath, [join(root, 'build.mjs')])
const stage = join(out, `.stage-${platform}`)
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
const meta = { version, chromium: pins.chromium.version, node: pins.node.version }
const bundleInfo = JSON.stringify({ ...meta, platform }, null, 1) + '\n'

function copyApp(to) {
  mkdirSync(to, { recursive: true })
  for (const f of APP_FILES) cpSync(join(root, f), join(to, f), { recursive: true })
}

// Node's binary and licence, out of its release tarball.
function unpackNode(to) {
  const top = basename(node).replace(/\.tar\.xz$/, '')
  mkdirSync(to, { recursive: true })
  run('tar', ['-xJf', node, '-C', to, '--strip-components=1', `${top}/bin/node`, `${top}/LICENSE`])
}

let product
if (!mac) {
  const dir = join(stage, 'grove')
  mkdirSync(join(dir, 'chromium'), { recursive: true })
  run('tar', ['-xJf', chromium, '-C', join(dir, 'chromium'), '--strip-components=1'])
  unpackNode(join(dir, 'node'))
  copyApp(join(dir, 'app'))
  cpSync(join(root, 'packaging/linux/grove'), join(dir, 'grove'))
  cpSync(join(root, 'branding/png'), join(dir, 'icons'), { recursive: true })
  cpSync(join(root, 'branding/grove.svg'), join(dir, 'icons/grove.svg'))
  writeFileSync(join(dir, 'bundle.json'), bundleInfo)
  product = 'grove'
} else {
  // Grove.app is Chromium.app renamed, with Grove's icon, and Grove's start
  // script as its main executable: Chromium's windows then belong to
  // Grove.app, so the Dock shows Grove.
  const mount = join(stage, 'mnt')
  mkdirSync(mount)
  run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, chromium])
  try {
    run('ditto', [join(mount, 'Chromium.app'), join(stage, 'Grove.app')])
  } finally {
    run('hdiutil', ['detach', mount])
  }
  const app = join(stage, 'Grove.app/Contents')
  const plist = join(app, 'Info.plist')
  const set = (key, value) => run('plutil', ['-replace', key, '-string', value, plist])
  set('CFBundleName', 'Grove')
  set('CFBundleDisplayName', 'Grove')
  set('CFBundleExecutable', 'Grove')
  set('CFBundleIconFile', 'grove.icns')
  set('CFBundleShortVersionString', version)
  // An asset-catalog icon would win over CFBundleIconFile.
  execFileSync('plutil', ['-remove', 'CFBundleIconName', plist], { stdio: 'ignore' })
  cpSync(join(root, 'branding/grove.icns'), join(app, 'Resources/grove.icns'))
  cpSync(join(root, 'packaging/macos/Grove'), join(app, 'MacOS/Grove'))
  unpackNode(join(app, 'Resources/node'))
  copyApp(join(app, 'Resources/app'))
  writeFileSync(join(app, 'Resources/bundle.json'), bundleInfo)
  run('xattr', ['-cr', join(stage, 'Grove.app')])
  // Ad hoc: no Apple Developer ID yet. Editing the bundle broke Chromium's
  // own signature, and Apple silicon runs nothing unsigned.
  run('codesign', ['--force', '--deep', '--sign', '-', join(stage, 'Grove.app')])
  product = 'Grove.app'
}

mkdirSync(out, { recursive: true })
const tarball = join(out, `grove-${version}-${platform}.tar.xz`)
console.log(`packing ${basename(tarball)}`)
run('tar', ['-cJf', tarball, '-C', stage, product], { env: { ...process.env, XZ_OPT: '-T0 -6' } })
if (mac) {
  const dmgRoot = join(stage, 'dmg')
  mkdirSync(dmgRoot)
  run('ditto', [join(stage, 'Grove.app'), join(dmgRoot, 'Grove.app')])
  symlinkSync('/Applications', join(dmgRoot, 'Applications'))
  const dmg = join(out, `Grove-${version}-${platform}.dmg`)
  run('hdiutil', ['create', '-volname', 'Grove', '-srcfolder', dmgRoot, '-ov', '-format', 'ULFO', dmg])
}
writeFileSync(join(out, `grove-${version}.json`), JSON.stringify(meta, null, 1) + '\n')
rmSync(stage, { recursive: true, force: true })
console.log(`bundled Grove ${version} for ${platform} in ${out}`)
