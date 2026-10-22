// Debug mode: the last 30 seconds of Grove, kept so that a bug, once seen,
// can be saved as a packet to send with a bug report. The packet
// (a .tar.gz in Downloads) holds:
//   replay.html      the windows as they looked, frame by frame, beside
//                    the timeline; open it in a browser
//   timeline.log     everything below, in order, timed from the save
//                    (-12.35 is twelve seconds before it)
//   frames/w<id>/    the frames of each window (T-12.35.jpg)
//   windows/w<id>.*  each window now: a screenshot and the UI's DOM
//   report.json      versions, settings, the windows' last state, the
//                    model, Chrome's targets, extensions, and the log
//                    lines from Grove's start
// The timeline: the host's log, the UI's and the bridge's console and
// errors, Chrome's own output, the UI's commands and the bridge's events,
// the states pushed to the windows, and, in Debug mode, the clicks and
// keys in the window's UI. The launcher feeds it (launcher/grove.mjs);
// frames are only kept in Debug mode.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export const KEEP_MS = 30_000
// The log lines kept from Grove's start, whatever their age.
const STARTUP_LINES = 300
const MAX_EVENTS = 20_000
const MAX_TEXT = 4000

export interface DebugEvent {
  t: number
  source: string
  text: string
}

interface Frame {
  t: number
  data: string
}

export interface PacketFile {
  name: string
  data: string | Buffer
}

export class DebugRecorder {
  private events: DebugEvent[] = []
  private readonly startup: DebugEvent[] = []
  private readonly frames = new Map<number, Frame[]>()
  readonly startedAt = Date.now()

  record(source: string, text: string): void {
    const e = { t: Date.now(), source, text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text }
    if (this.startup.length < STARTUP_LINES) this.startup.push(e)
    this.events.push(e)
    if (this.events.length > MAX_EVENTS || this.events[0].t < e.t - KEEP_MS * 2) this.prune()
  }

  // A window's frame, a JPEG in base64.
  frame(windowId: number, data: string): void {
    const list = this.frames.get(windowId) ?? []
    list.push({ t: Date.now(), data })
    this.frames.set(windowId, list)
    // Keep the last frame from before the 30 seconds: how the window
    // looked when they began.
    const cutoff = Date.now() - KEEP_MS
    let drop = 0
    while (drop + 1 < list.length && list[drop + 1].t <= cutoff) drop++
    if (drop) list.splice(0, drop)
  }

  dropFrames(windowId?: number): void {
    if (windowId === undefined) this.frames.clear()
    else this.frames.delete(windowId)
  }

  private prune(): void {
    const cutoff = Date.now() - KEEP_MS
    this.events = this.events.filter((e) => e.t >= cutoff).slice(-MAX_EVENTS)
  }

  // Writes the packet into Downloads and returns its path.
  async save(report: Record<string, unknown>, files: PacketFile[]): Promise<string> {
    const now = Date.now()
    this.prune()
    const stamp = new Date(now).toISOString().replace(/\..*/, '').replace(/[-:]/g, '').replace('T', '-')
    const name = `grove-debug-${stamp}`
    const work = join(tmpdir(), `${name}-${process.pid}`)
    const dir = join(work, name)
    mkdirSync(dir, { recursive: true })
    const at = (t: number): string => ((t - now) / 1000).toFixed(2)
    try {
      const events = this.events.filter((e) => e.t >= now - KEEP_MS)
      writeFileSync(join(dir, 'timeline.log'), events.map((e) => line(e, at)).join('\n') + '\n')

      const shown: Record<string, { t: number; file: string }[]> = {}
      for (const [windowId, list] of this.frames) {
        const sub = `frames/w${windowId}`
        mkdirSync(join(dir, sub), { recursive: true })
        shown[windowId] = list.map((f) => {
          const file = `${sub}/T${at(f.t)}.jpg`
          writeFileSync(join(dir, file), Buffer.from(f.data, 'base64'))
          return { t: Number(at(f.t)), file }
        })
      }
      writeFileSync(
        join(dir, 'replay.html'),
        replayPage({ frames: shown, events: events.map((e) => ({ ...e, t: Number(at(e.t)) })) })
      )

      for (const f of files) {
        mkdirSync(join(dir, f.name, '..'), { recursive: true })
        writeFileSync(join(dir, f.name), f.data)
      }
      const startup = this.startup.map((e) => line(e, (t) => `+${((t - this.startedAt) / 1000).toFixed(2)}`))
      writeFileSync(
        join(dir, 'report.json'),
        JSON.stringify({ savedAt: new Date(now).toISOString(), keptSeconds: KEEP_MS / 1000, ...report, startup }, null, 1)
      )

      const downloads = join(homedir(), 'Downloads')
      const out = join(existsSync(downloads) ? downloads : homedir(), `${name}.tar.gz`)
      await run('tar', ['-czf', out, '-C', work, name])
      return out
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }
}

function line(e: DebugEvent, at: (t: number) => string): string {
  const text = e.text.includes('\n') ? e.text.replace(/\n/g, '\n        ') : e.text
  return `${at(e.t).padStart(7)} [${e.source}] ${text}`
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    p.on('error', reject)
    p.on('exit', (code) => (code ? reject(new Error(`${cmd}: ${err.trim() || code}`)) : resolve()))
  })
}

// Opens a file's folder, the file selected where the system can.
export function reveal(path: string): void {
  const [cmd, args] = process.platform === 'darwin' ? ['open', ['-R', path]] : ['xdg-open', [join(path, '..')]]
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
}

// Keeps a value's shape for the report, without secrets: sync codes,
// tokens, keys and passwords, and the data: URLs of icons and snapshots.
export function redact(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value ?? null, (k, v) => {
      if (typeof v !== 'string') return v
      if (/^(code|token|secret|password|invite|key|apiKey)$/i.test(k) && v) return '[redacted]'
      if (v.startsWith('data:') && v.length > 120) return `${v.slice(0, 40)}…[${v.length} chars]`
      return v
    })
  )
}

function replayPage(data: { frames: Record<string, { t: number; file: string }[]>; events: DebugEvent[] }): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  return `<!doctype html>
<meta charset="utf-8">
<title>Grove debug replay</title>
<style>
  :root { color-scheme: light dark; font: 13px system-ui, sans-serif; }
  body { margin: 0; display: grid; grid-template-rows: auto 1fr; height: 100vh; }
  header { display: flex; gap: 10px; align-items: center; padding: 8px 12px; border-bottom: 1px solid #8884; }
  input[type=range] { flex: 1; }
  #t { font: 13px ui-monospace, monospace; width: 64px; text-align: right; }
  main { display: grid; grid-template-columns: 1fr minmax(320px, 40%); min-height: 0; }
  #windows { overflow: auto; padding: 8px; display: grid; gap: 8px; align-content: start; }
  #windows img { max-width: 100%; border: 1px solid #8884; display: block; }
  #log { overflow: auto; margin: 0; padding: 8px; font: 11.5px/1.45 ui-monospace, monospace; border-left: 1px solid #8884; }
  #log div { white-space: pre-wrap; word-break: break-word; opacity: .35; cursor: pointer; }
  #log div.past { opacity: 1; }
  #log div.now { background: #fc04; }
</style>
<header><button id="play">Play</button><input id="slider" type="range" min="-30" max="0" step="0.05" value="0"><span id="t"></span></header>
<main><div id="windows"></div><pre id="log"></pre></main>
<script>
const data = ${json}
const slider = document.getElementById('slider'), tOut = document.getElementById('t'), log = document.getElementById('log')
const imgs = Object.entries(data.frames).map(([id, frames]) => {
  const fig = document.createElement('figure'), img = document.createElement('img'), cap = document.createElement('figcaption')
  fig.style.margin = 0; cap.textContent = 'Window ' + id; fig.append(cap, img)
  document.getElementById('windows').append(fig)
  return { frames, img }
})
const rows = data.events.map((e) => {
  const d = document.createElement('div')
  d.textContent = e.t.toFixed(2).padStart(7) + ' [' + e.source + '] ' + e.text
  d.onclick = () => show(e.t)
  log.append(d)
  return d
})
let lastNow
function show(t) {
  slider.value = t; tOut.textContent = Number(t).toFixed(2) + 's'
  for (const w of imgs) {
    const f = w.frames.filter((f) => f.t <= t).pop() ?? w.frames[0]
    if (f && w.img.getAttribute('src') !== f.file) w.img.src = f.file
  }
  let now
  data.events.forEach((e, i) => { rows[i].className = e.t <= t ? 'past' : ''; if (e.t <= t) now = i })
  if (now !== undefined && now !== lastNow) { rows[now].classList.add('now'); rows[now].scrollIntoView({ block: 'nearest' }) }
  lastNow = now
}
slider.oninput = () => show(Number(slider.value))
let timer
document.getElementById('play').onclick = (e) => {
  if (timer) { clearInterval(timer); timer = undefined; e.target.textContent = 'Play'; return }
  if (Number(slider.value) >= 0) slider.value = -30
  e.target.textContent = 'Pause'
  timer = setInterval(() => {
    const t = Math.min(0, Number(slider.value) + 0.05)
    show(t)
    if (t >= 0) e.target.click()
  }, 50)
}
show(0)
</script>
`
}
