#!/usr/bin/env node
// Builds an installable Grove for one platform: the pinned Chromium and Node
// (packaging/pins.json, checked against their SHA-256) with Grove's app and
// start script, under Grove's name and icon.
//
//   node scripts/bundle.mjs <platform> [--out <dir>]
//
// <platform> is linux-x64, linux-arm64, macos-arm64, macos-x64, windows-x64
// or windows-arm64. Writes to <dir> (default release/):
//   grove-<version>-<platform>.tar.xz   the bundle (what installers and the
//                                       updater unpack; on Windows a .zip)
//   Grove-<version>-<platform>.dmg      macOS only: drag to Applications
//   grove-<version>.json                what the release pins (the updater
//                                       reads it to choose a full update)
//
// A Linux bundle can be built anywhere; a macOS one needs macOS (hdiutil,
// plutil, codesign); a Windows one needs Go (Grove.exe and the icons, from
// packaging/windows) and, off Windows, unzip and zip. Downloads are cached
// in ~/.cache/grove-bundle.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { holdWebiumUi } from './webium-pak.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const PLATFORMS = ['linux-x64', 'linux-arm64', 'macos-arm64', 'macos-x64', 'windows-x64', 'windows-arm64']
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
const windows = platform.startsWith('windows')
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

// A .zip, with the system's tar on Windows (bsdtar reads zips).
const unzip = (file, to) =>
  process.platform === 'win32' ? run('tar', ['-xf', file, '-C', to]) : run('unzip', ['-q', file, '-d', to])

// Node's binary and licence, out of its release tarball.
function unpackNode(to) {
  const top = basename(node).replace(/\.tar\.xz$/, '')
  mkdirSync(to, { recursive: true })
  run('tar', ['-xJf', node, '-C', to, '--strip-components=1', `${top}/bin/node`, `${top}/LICENSE`])
}

// Grove.exe (packaging/windows), with Grove's icon, for the Windows GUI
// subsystem: it starts Node with no console window.
const GO_WINRES = 'github.com/tc-hib/go-winres@v0.3.3'
function buildGroveExe(to) {
  const src = join(stage, 'grove-exe')
  cpSync(join(root, 'packaging/windows'), src, { recursive: true, filter: (f) => !f.endsWith('.ps1') })
  const goarch = platform.endsWith('arm64') ? 'arm64' : 'amd64'
  const winVersion = `${version.split(/[-+]/)[0]}.0`
  run('go', ['run', GO_WINRES, 'simply', '--arch', goarch, '--out', join(src, 'rsrc'), '--manifest', 'gui',
    '--icon', join(root, 'branding/grove.ico'), '--product-name', 'Grove', '--file-description', 'Grove',
    '--product-version', winVersion, '--file-version', winVersion, '--original-filename', 'Grove.exe'], { cwd: src })
  run('go', ['build', '-trimpath', '-ldflags=-H=windowsgui -s -w', '-o', to, '.'], {
    cwd: src,
    env: { ...process.env, GOOS: 'windows', GOARCH: goarch, CGO_ENABLED: '0' }
  })
}

// Chrome draws its windows' and taskbar button's icon from its own
// IDR_MAINFRAME: make that Grove's.
function brandChrome(exe) {
  const dir = join(stage, 'chrome-icon')
  mkdirSync(dir, { recursive: true })
  cpSync(join(root, 'branding/grove.ico'), join(dir, 'grove.ico'))
  writeFileSync(join(dir, 'winres.json'), JSON.stringify({ RT_GROUP_ICON: { IDR_MAINFRAME: { '0409': 'grove.ico' } } }))
  run('go', ['run', GO_WINRES, 'patch', '--in', join(dir, 'winres.json'), '--no-backup', exe])
}

let product
if (windows) {
  const dir = join(stage, 'Grove')
  const unpacked = join(stage, 'unpacked')
  mkdirSync(unpacked, { recursive: true })
  unzip(chromium, unpacked)
  mkdirSync(dir, { recursive: true })
  renameSync(join(unpacked, basename(chromium, '.zip')), join(dir, 'chromium'))
  // No flash of Webium's own UI in new windows (webium-pak.mjs).
  holdWebiumUi(join(dir, 'chromium/resources.pak'))
  brandChrome(join(dir, 'chromium/chrome.exe'))
  unzip(node, unpacked)
  const nodeTop = join(unpacked, basename(node, '.zip'))
  mkdirSync(join(dir, 'node'))
  for (const f of ['node.exe', 'LICENSE']) cpSync(join(nodeTop, f), join(dir, 'node', f))
  copyApp(join(dir, 'app'))
  buildGroveExe(join(dir, 'Grove.exe'))
  for (const f of ['grove.cmd', 'uninstall.ps1']) cpSync(join(root, 'packaging/windows', f), join(dir, f))
  cpSync(join(root, 'branding/grove.ico'), join(dir, 'grove.ico'))
  writeFileSync(join(dir, 'bundle.json'), bundleInfo)
  product = 'Grove'
} else if (!mac) {
  const dir = join(stage, 'grove')
  mkdirSync(join(dir, 'chromium'), { recursive: true })
  run('tar', ['-xJf', chromium, '-C', join(dir, 'chromium'), '--strip-components=1'])
  // No flash of Webium's own UI in new windows (webium-pak.mjs).
  holdWebiumUi(join(dir, 'chromium/resources.pak'))
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
  // No flash of Webium's own UI in new windows (webium-pak.mjs). Before
  // signing: this edits the framework's resources.
  const versions = join(app, 'Frameworks/Chromium Framework.framework/Versions')
  const framework = readdirSync(versions).find((v) => v !== 'Current')
  holdWebiumUi(join(versions, framework, 'Resources/resources.pak'))
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
const tarball = join(out, `grove-${version}-${platform}.${windows ? 'zip' : 'tar.xz'}`)
console.log(`packing ${basename(tarball)}`)
rmSync(tarball, { force: true })
if (!windows) run('tar', ['-cJf', tarball, '-C', stage, product], { env: { ...process.env, XZ_OPT: '-T0 -6' } })
else if (process.platform === 'win32') run('tar', ['-a', '-cf', tarball, '-C', stage, product])
else run('zip', ['-qrX9', tarball, product], { cwd: stage })
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
