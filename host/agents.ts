// Local agents (Claude Code and the like) drive Grove through the Model
// Context Protocol: `grove mcp` (launcher/mcp.mjs) joins an agent's stdio
// to a socket only this user can open, and every connection to it is one
// agent. An agent works in tabs of its own, in the Agents workspace, with
// the user's own logins: their pages open in the background of a window,
// and everything it does goes to its pages over DevTools (input included),
// never through the user's mouse, keyboard or focus. Switching a window
// to the Agents workspace shows what the agents are doing.
//
// An agent only ever sees and drives its own tabs: the ones it opened, and
// the pages those opened.
import { createHash } from 'node:crypto'
import { chmodSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Bridge, GroveHost } from './host.ts'

// The socket of the Grove running on a profile.
export function agentSocket(profile: string): string {
  const id = createHash('sha256').update(profile).digest('hex').slice(0, 10)
  if (process.platform === 'win32') return `\\\\.\\pipe\\grove-agent-${id}`
  return join(process.env.XDG_RUNTIME_DIR || tmpdir(), `grove-agent-${id}.sock`)
}

export interface Cdp {
  send(method: string, params?: object, sessionId?: string): Promise<any>
  on(event: string, fn: (params: any, sessionId?: string) => void): void
}

interface AgentTab {
  id: string
  entryId: string
  sessionId?: string
  attaching?: Promise<string>
  // The page's main frame is loading.
  loading: boolean
  dialog?: { type: string; message: string; defaultPrompt?: string }
  // Waiting on a tool while a dialog may open (see guard).
  onDialog: (() => void)[]
}

interface Agent {
  name: string
  tabs: Map<string, AgentTab>
  current?: string
  nextTab: number
  // Things to tell the agent with its next result (a page opened a tab).
  notes: string[]
}

type Args = Record<string, any>
interface ToolResult {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
  isError?: boolean
}

const PROTOCOL = '2025-06-18'
const COMMAND_MS = 30_000
const SNAPSHOT_LIMIT = 60_000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const INSTRUCTIONS = `Grove is the user's own web browser. These tools drive it in tabs of your own, in its Agents workspace, without getting in the user's way: your tabs stay in the background, and your clicks and keys go to your pages only. The user can switch a window to the Agents workspace to watch.

Pages have the user's own logins (cookies, accounts). Ask the user before doing anything on their behalf that can't be undone or that others will see: buying, sending messages or email, posting, deleting, changing account settings.

Start with open_tab. Use snapshot to read a page: it lists the page's elements as an accessibility tree, each with a ref (e12) that click, type, hover, select_option and scroll take. Refs last until the page changes; take a new snapshot after navigating. Use screenshot when the layout or images matter.`

const tabArg = { tab: { type: 'string', description: 'Your tab (t1, t2, ...). Default: the current one.' } }
const refArg = { ref: { type: 'string', description: "The element's ref from the last snapshot (e12)." } }
const TOOLS = [
  {
    name: 'open_tab',
    description: 'Opens a new tab of your own (in the background) and makes it your current tab.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'Default: a blank page.' } } }
  },
  { name: 'tabs', description: 'Lists your tabs.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'select_tab',
    description: 'Makes one of your tabs the current one (for you; the user’s windows are left alone).',
    inputSchema: { type: 'object', properties: tabArg, required: ['tab'] }
  },
  { name: 'close_tab', description: 'Closes one of your tabs.', inputSchema: { type: 'object', properties: tabArg } },
  {
    name: 'navigate',
    description: 'Goes to a URL in a tab, or "back", "forward" or "reload".',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, ...tabArg }, required: ['url'] }
  },
  {
    name: 'snapshot',
    description: "The page as an accessibility tree: each element's role, name and state, and a ref to act on it.",
    inputSchema: { type: 'object', properties: tabArg }
  },
  {
    name: 'click',
    description: 'Clicks an element.',
    inputSchema: {
      type: 'object',
      properties: {
        ...refArg,
        double: { type: 'boolean' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        modifiers: { type: 'array', items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] } },
        ...tabArg
      },
      required: ['ref']
    }
  },
  {
    name: 'hover',
    description: 'Moves the mouse over an element.',
    inputSchema: { type: 'object', properties: { ...refArg, ...tabArg }, required: ['ref'] }
  },
  {
    name: 'type',
    description: 'Types text into a field, replacing what it holds (unless append).',
    inputSchema: {
      type: 'object',
      properties: {
        ...refArg,
        text: { type: 'string' },
        submit: { type: 'boolean', description: 'Press Enter afterwards.' },
        append: { type: 'boolean' },
        ...tabArg
      },
      required: ['ref', 'text']
    }
  },
  {
    name: 'press',
    description: 'Presses a key or a combination in the page: Enter, Escape, Tab, ArrowDown, Backspace, a, Control+a, Shift+Tab...',
    inputSchema: { type: 'object', properties: { key: { type: 'string' }, ...tabArg }, required: ['key'] }
  },
  {
    name: 'scroll',
    description: 'Scrolls the page (or the element under ref) by dy pixels down (negative: up). Default: most of a screen down.',
    inputSchema: { type: 'object', properties: { dy: { type: 'number' }, dx: { type: 'number' }, ref: { type: 'string' }, ...tabArg } }
  },
  {
    name: 'select_option',
    description: 'Picks options of a <select> by value or label.',
    inputSchema: {
      type: 'object',
      properties: { ...refArg, values: { type: 'array', items: { type: 'string' } }, ...tabArg },
      required: ['ref', 'values']
    }
  },
  {
    name: 'wait_for',
    description: 'Waits for text to appear on the page or to go, or for some seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        text_gone: { type: 'string' },
        seconds: { type: 'number' },
        timeout: { type: 'number', description: 'Seconds to wait for text at most (default 20).' },
        ...tabArg
      }
    }
  },
  { name: 'screenshot', description: 'A picture of what the tab shows.', inputSchema: { type: 'object', properties: tabArg } },
  {
    name: 'evaluate',
    description: "Runs JavaScript in the page and returns its result (as JSON). Awaits a promise.",
    inputSchema: { type: 'object', properties: { expression: { type: 'string' }, ...tabArg }, required: ['expression'] }
  },
  {
    name: 'handle_dialog',
    description: 'Answers an alert, confirm, prompt or leave-page dialog the page opened.',
    inputSchema: {
      type: 'object',
      properties: { accept: { type: 'boolean' }, text: { type: 'string', description: "A prompt's answer." }, ...tabArg },
      required: ['accept']
    }
  }
]

export class AgentServer {
  private readonly agents = new Set<Agent>()
  private readonly owner = new Map<string, Agent>() // entry id -> its agent
  private readonly bySession = new Map<string, AgentTab>() // DevTools session -> tab
  // Each tab's target, whose id its main frame's is.
  private readonly targets = new Map<AgentTab, string>()
  private readonly openers = new Map<string, string>()
  private server?: Server
  private readonly cdp: Cdp
  private readonly host: GroveHost
  private readonly bridge: Bridge
  private readonly version: string
  private readonly log: (...a: unknown[]) => void

  constructor(opts: { cdp: Cdp; host: GroveHost; bridge: Bridge; version: string; log: (...a: unknown[]) => void }) {
    this.cdp = opts.cdp
    this.host = opts.host
    this.bridge = opts.bridge
    this.version = opts.version
    this.log = opts.log
    this.host.agentDriven = (entryId) => this.owner.has(entryId)
    this.host.onAgentTab = (entryId, opener) => {
      const agent = this.owner.get(opener)
      if (!agent) return
      const t = this.addTab(agent, entryId)
      agent.notes.push(`The page opened a new tab, ${t.id}.`)
    }
    // Pages agents' pages opened, by target: the opener's target.
    this.cdp.on('Target.targetCreated', ({ targetInfo }) => {
      if (targetInfo.type !== 'page' || !targetInfo.openerId) return
      if ([...this.targets.values()].includes(targetInfo.openerId)) this.openers.set(targetInfo.targetId, targetInfo.openerId)
    })
    this.host.agentOpener = (targetId) => {
      const opener = this.openers.get(targetId)
      this.openers.delete(targetId)
      const t = [...this.targets].find(([tab, id]) => id === opener && this.owner.has(tab.entryId))?.[0]
      return t?.entryId
    }
    const tabOf = (sessionId?: string) => (sessionId ? this.bySession.get(sessionId) : undefined)
    this.cdp.on('Target.detachedFromTarget', ({ sessionId }) => {
      const t = this.bySession.get(sessionId)
      if (!t) return
      this.bySession.delete(sessionId)
      t.sessionId = undefined
      t.loading = false
      t.dialog = undefined
    })
    this.cdp.on('Page.frameStartedLoading', ({ frameId }, sessionId) => {
      const t = tabOf(sessionId)
      if (t && this.isMain(t, frameId)) t.loading = true
    })
    this.cdp.on('Page.frameStoppedLoading', ({ frameId }, sessionId) => {
      const t = tabOf(sessionId)
      if (t && this.isMain(t, frameId)) t.loading = false
    })
    this.cdp.on('Page.javascriptDialogOpening', ({ type, message, defaultPrompt }, sessionId) => {
      const t = tabOf(sessionId)
      if (!t) return
      t.dialog = { type, message, defaultPrompt }
      t.onDialog.splice(0).forEach((f) => f())
    })
    this.cdp.on('Page.javascriptDialogClosed', (_p, sessionId) => {
      const t = tabOf(sessionId)
      if (t) t.dialog = undefined
    })
  }

  private isMain(t: AgentTab, frameId: string): boolean {
    return this.targets.get(t) === frameId
  }

  listen(path: string): void {
    if (process.platform !== 'win32') rmSync(path, { force: true })
    this.server = createServer((socket) => this.connect(socket))
    this.server.on('error', (e) => this.log('agents:', e.message))
    this.server.listen(path, () => {
      if (process.platform !== 'win32') chmodSync(path, 0o600)
    })
  }

  // ---- The protocol: JSON-RPC, a message to a line ----

  private connect(socket: Socket): void {
    const agent: Agent = { name: 'agent', tabs: new Map(), nextTab: 1, notes: [] }
    this.agents.add(agent)
    let buffer = ''
    const reply = (msg: object) => socket.writable && socket.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim()
        buffer = buffer.slice(end + 1)
        if (!line) continue
        let msg: any
        try {
          msg = JSON.parse(line)
        } catch {
          reply({ id: null, error: { code: -32700, message: 'parse error' } })
          continue
        }
        void this.handle(agent, msg).then(
          (result) => msg.id !== undefined && result !== undefined && reply({ id: msg.id, result }),
          (e: Error) => msg.id !== undefined && reply({ id: msg.id, error: { code: -32603, message: e.message } })
        )
      }
    })
    const done = () => {
      if (!this.agents.delete(agent)) return
      this.log(`agents: ${agent.name} left`)
      // Its tabs stay, for the user to look at; Grove may unload them now.
      for (const t of agent.tabs.values()) {
        this.owner.delete(t.entryId)
        if (t.sessionId) void this.cdp.send('Target.detachFromTarget', { sessionId: t.sessionId }).catch(() => {})
      }
    }
    socket.on('close', done)
    socket.on('error', done)
  }

  private async handle(agent: Agent, msg: any): Promise<object | undefined> {
    switch (msg.method) {
      case 'initialize':
        agent.name = String(msg.params?.clientInfo?.name ?? 'agent')
        this.log(`agents: ${agent.name} connected`)
        return {
          protocolVersion: msg.params?.protocolVersion ?? PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'grove', version: this.version },
          instructions: INSTRUCTIONS
        }
      case 'ping':
        return {}
      case 'tools/list':
        return { tools: TOOLS }
      case 'tools/call':
        return this.call(agent, msg.params?.name, msg.params?.arguments ?? {})
      default:
        if (msg.id === undefined) return undefined // a notification
        throw new Error(`unknown method ${msg.method}`)
    }
  }

  private async call(agent: Agent, name: string, args: Args): Promise<ToolResult> {
    try {
      const result = await this.run(agent, name, args)
      const out = typeof result === 'string' ? { content: [{ type: 'text' as const, text: result }] } : result
      const notes = agent.notes.splice(0)
      if (notes.length) out.content.push({ type: 'text', text: notes.join('\n') })
      return out
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true }
    }
  }

  // ---- Tabs ----

  private addTab(agent: Agent, entryId: string): AgentTab {
    const t: AgentTab = { id: `t${agent.nextTab++}`, entryId, loading: false, onDialog: [] }
    agent.tabs.set(t.id, t)
    this.owner.set(entryId, agent)
    return t
  }

  private dropTab(agent: Agent, t: AgentTab): void {
    agent.tabs.delete(t.id)
    this.owner.delete(t.entryId)
    this.targets.delete(t)
    if (agent.current === t.id) agent.current = [...agent.tabs.keys()].pop()
    if (t.sessionId) {
      this.bySession.delete(t.sessionId)
      void this.cdp.send('Target.detachFromTarget', { sessionId: t.sessionId }).catch(() => {})
    }
  }

  private tab(agent: Agent, id?: string): AgentTab {
    const t = agent.tabs.get(id ?? agent.current ?? '')
    if (!t) throw new Error(id ? `You have no tab ${id}; see tabs.` : 'You have no tab open; use open_tab first.')
    if (!this.host.agentEntry(t.entryId)) {
      this.dropTab(agent, t)
      throw new Error(`Tab ${t.id} was closed (the user may have closed it).`)
    }
    return t
  }

  // The tab's DevTools session, attached the first time (and again after
  // its page was closed and reopened).
  private session(t: AgentTab): Promise<string> {
    if (t.sessionId) return Promise.resolve(t.sessionId)
    t.attaching ??= (async () => {
      try {
        const tabId = await this.host.agentTab(t.entryId)
        const targetId = await this.bridge.call<string | null>('targetOf', tabId)
        if (!targetId) throw new Error(`Chrome has no page for tab ${t.id}`)
        const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true })
        this.bySession.set(sessionId, t)
        this.targets.set(t, targetId)
        t.sessionId = sessionId
        await this.cdp.send('Page.enable', {}, sessionId)
        // A tab in the background stops drawing; this keeps it drawing (for
        // screenshots) and makes the page act as focused, as it would for
        // a person using it.
        await this.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId)
        return sessionId
      } finally {
        t.attaching = undefined
      }
    })()
    return t.attaching
  }

  private async send(t: AgentTab, method: string, params: object = {}): Promise<any> {
    const sessionId = await this.session(t)
    return timed(this.cdp.send(method, params, sessionId), COMMAND_MS, method)
  }

  private async evaluate(t: AgentTab, expression: string): Promise<any> {
    const r = await this.send(t, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result?.value
  }

  // After an action: a moment for what it starts, then the page's loading.
  private async settle(t: AgentTab, quiet = 150): Promise<void> {
    await sleep(quiet)
    const until = Date.now() + 15_000
    while (Date.now() < until && !t.dialog) {
      const state = await this.evaluate(t, 'document.readyState').catch(() => 'loading')
      if (!t.loading && state !== 'loading') return
      await sleep(150)
    }
  }

  // Runs an action, which stops waiting if the page opens a dialog (that
  // holds the page, and the action's reply, until it's answered).
  private async guard<T>(t: AgentTab, action: () => Promise<T>): Promise<T | string> {
    if (t.dialog) return this.dialogNote(t)
    let off!: () => void
    const opened = new Promise<string>((resolve) => {
      off = () => resolve(this.dialogNote(t))
      t.onDialog.push(off)
    })
    try {
      return await Promise.race([action(), opened])
    } finally {
      t.onDialog = t.onDialog.filter((f) => f !== off)
    }
  }

  private dialogNote(t: AgentTab): string {
    const d = t.dialog!
    return `The page opened a ${d.type} dialog: ${JSON.stringify(d.message)}${d.type === 'prompt' ? ` (default ${JSON.stringify(d.defaultPrompt ?? '')})` : ''}. Answer it with handle_dialog.`
  }

  private async state(t: AgentTab): Promise<string> {
    if (t.dialog) return this.dialogNote(t)
    const [title, url] = (await this.evaluate(t, '[document.title, location.href]').catch(() => null)) ?? ['', this.host.agentEntry(t.entryId)?.url ?? '']
    const watched = this.host.isShown(t.entryId) ? ' The user is watching this tab.' : ''
    return `Tab ${t.id}: ${title ? `${JSON.stringify(title)} ` : ''}${url}${watched}`
  }

  // ---- Tools ----

  private async run(agent: Agent, name: string, a: Args): Promise<ToolResult | string> {
    switch (name) {
      case 'open_tab': {
        const entryId = await this.host.agentOpen(a.url || 'about:blank')
        const t = this.addTab(agent, entryId)
        agent.current = t.id
        await this.session(t)
        await this.settle(t)
        return this.state(t)
      }
      case 'tabs': {
        const lines = []
        for (const t of [...agent.tabs.values()]) {
          const e = this.host.agentEntry(t.entryId)
          if (!e) {
            this.dropTab(agent, t)
            continue
          }
          lines.push(`${t.id}${t.id === agent.current ? ' (current)' : ''}: ${JSON.stringify(e.title)} ${e.url}`)
        }
        return lines.length ? lines.join('\n') : 'You have no tabs open.'
      }
      case 'select_tab': {
        const t = this.tab(agent, a.tab)
        agent.current = t.id
        return this.state(t)
      }
      case 'close_tab': {
        const t = this.tab(agent, a.tab)
        this.dropTab(agent, t)
        await this.host.agentClose([t.entryId])
        return `Closed ${t.id}.${agent.current ? ` Current tab: ${agent.current}.` : ''}`
      }
      case 'navigate': {
        const t = this.tab(agent, a.tab)
        return this.guard(t, async () => {
          const url = String(a.url)
          if (url === 'reload') await this.send(t, 'Page.reload')
          else if (url === 'back' || url === 'forward') {
            const { currentIndex, entries } = await this.send(t, 'Page.getNavigationHistory')
            const entry = entries[currentIndex + (url === 'back' ? -1 : 1)]
            if (!entry) throw new Error(`There is no page to go ${url} to.`)
            await this.send(t, 'Page.navigateToHistoryEntry', { entryId: entry.id })
          } else {
            const r = await this.send(t, 'Page.navigate', { url: withScheme(url) })
            if (r.errorText) throw new Error(`Couldn't load ${url}: ${r.errorText}`)
          }
          await this.settle(t, 300)
          return this.state(t)
        })
      }
      case 'snapshot': {
        const t = this.tab(agent, a.tab)
        return this.guard(t, async () => {
          const { nodes } = await this.send(t, 'Accessibility.getFullAXTree')
          const tree = renderTree(nodes)
          const text = `${await this.state(t)}\n${tree}`
          return text.length > SNAPSHOT_LIMIT
            ? `${text.slice(0, SNAPSHOT_LIMIT)}\n… (cut short: the page is long; scroll, or use evaluate to read a part)`
            : text
        })
      }
      case 'click':
      case 'hover': {
        const t = this.tab(agent, a.tab)
        return this.guard(t, async () => {
          const { x, y } = await this.point(t, a.ref)
          const modifiers = modifierBits(a.modifiers ?? [])
          await this.send(t, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers })
          if (name === 'click') {
            const button = a.button ?? 'left'
            const mouse = (type: string, clickCount: number) =>
              this.send(t, 'Input.dispatchMouseEvent', { type, x, y, button, clickCount, modifiers, buttons: type === 'mousePressed' ? 1 : 0 })
            for (let n = 1; n <= (a.double ? 2 : 1); n++) {
              await this.host.agentPress(t.entryId, () => mouse('mousePressed', n))
              await mouse('mouseReleased', n)
            }
            await this.settle(t, 300)
          }
          return this.state(t)
        })
      }
      case 'type': {
        const t = this.tab(agent, a.tab)
        return this.guard(t, async () => {
          const objectId = await this.object(t, a.ref)
          await this.onNode(t, a.ref, 'DOM.focus').catch(() => {})
          await this.send(t, 'Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: `function (append) {
              this.focus()
              if (append) return
              if (typeof this.select === 'function') this.select()
              else if (this.isContentEditable) {
                const r = document.createRange()
                r.selectNodeContents(this)
                getSelection().removeAllRanges()
                getSelection().addRange(r)
              }
            }`,
            arguments: [{ value: !!a.append }]
          })
          if (a.text) await this.send(t, 'Input.insertText', { text: String(a.text) })
          else if (!a.append) await this.key(t, 'Delete')
          if (a.submit) await this.key(t, 'Enter')
          await this.settle(t, a.submit ? 300 : 50)
          return this.state(t)
        })
      }
      case 'press': {
        const t = this.tab(agent, a.tab)
        return this.guard(t, async () => {
          await this.key(t, String(a.key))
          await this.settle(t, 200)
          return this.state(t)
        })
      }
      case 'scroll': {
        const t = this.tab(agent, a.tab)
        return this.guard(t, async () => {
          const { cssVisualViewport: v } = await this.send(t, 'Page.getLayoutMetrics')
          const at = a.ref ? await this.point(t, a.ref) : { x: v.clientWidth / 2, y: v.clientHeight / 2 }
          const deltaY = a.dy ?? (a.dx ? 0 : Math.round(v.clientHeight * 0.8))
          await this.send(t, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: a.dx ?? 0, deltaY })
          await sleep(300)
          const [sy, h] = await this.evaluate(t, '[Math.round(scrollY), document.documentElement.scrollHeight - innerHeight]')
          return `${await this.state(t)}\nScrolled; the page is at ${sy} of ${Math.max(0, h)}px.`
        })
      }
      case 'select_option': {
        const t = this.tab(agent, a.tab)
        return this.guard(t, async () => {
          const objectId = await this.object(t, a.ref)
          const r = await this.send(t, 'Runtime.callFunctionOn', {
            objectId,
            returnByValue: true,
            functionDeclaration: `function (values) {
              if (!(this instanceof HTMLSelectElement)) return 'not a <select>'
              const picked = [...this.options].filter((o) => values.includes(o.value) || values.includes(o.label.trim()))
              if (!picked.length) return 'no option matches; options: ' + [...this.options].map((o) => o.label.trim()).join(', ')
              for (const o of this.options) o.selected = picked.includes(o)
              this.dispatchEvent(new Event('input', { bubbles: true }))
              this.dispatchEvent(new Event('change', { bubbles: true }))
              return ''
            }`,
            arguments: [{ value: (a.values ?? []).map(String) }]
          })
          if (r.result?.value) throw new Error(r.result.value)
          await this.settle(t)
          return this.state(t)
        })
      }
      case 'wait_for': {
        const t = this.tab(agent, a.tab)
        return this.guard(t, async () => {
          if (a.seconds) await sleep(Math.min(Number(a.seconds), 60) * 1000)
          if (a.text || a.text_gone) {
            const until = Date.now() + Math.min(Number(a.timeout ?? 20), 120) * 1000
            const want = JSON.stringify(a.text ?? a.text_gone)
            const expr = `(document.body?.innerText ?? '').includes(${want})`
            for (;;) {
              const has = await this.evaluate(t, expr).catch(() => false)
              if (a.text ? has : !has) break
              if (Date.now() > until) throw new Error(`Timed out waiting for ${a.text ? '' : 'the end of '}${want}.`)
              await sleep(250)
            }
          }
          return this.state(t)
        })
      }
      case 'screenshot': {
        const t = this.tab(agent, a.tab)
        return this.guard(t, async () => {
          const { data } = await timed(
            this.send(t, 'Page.captureScreenshot', { format: 'jpeg', quality: 75, optimizeForSpeed: true }),
            15_000,
            'screenshot'
          )
          return { content: [{ type: 'image', data, mimeType: 'image/jpeg' }, { type: 'text', text: await this.state(t) }] } as ToolResult
        })
      }
      case 'evaluate': {
        const t = this.tab(agent, a.tab)
        return this.guard(t, async () => {
          const value = await this.evaluate(t, String(a.expression))
          const text = value === undefined ? 'undefined' : JSON.stringify(value, null, 1)
          return text.length > SNAPSHOT_LIMIT ? `${text.slice(0, SNAPSHOT_LIMIT)}… (cut short)` : text
        })
      }
      case 'handle_dialog': {
        const t = this.tab(agent, a.tab)
        if (!t.dialog) throw new Error(`Tab ${t.id} has no dialog open.`)
        await this.send(t, 'Page.handleJavaScriptDialog', { accept: !!a.accept, promptText: a.text })
        t.dialog = undefined
        await this.settle(t, 200)
        return this.state(t)
      }
      default:
        throw new Error(`Grove has no tool ${name}.`)
    }
  }

  // A DOM command about a ref's element. DevTools only knows elements by
  // ref once it has the document, which a fresh session hasn't asked for.
  private async onNode(t: AgentTab, ref: string, method: string): Promise<any> {
    const params = { backendNodeId: refNode(ref) }
    return this.send(t, method, params).catch(async () => {
      await this.send(t, 'DOM.getDocument', { depth: 0 })
      return this.send(t, method, params).catch(staleRef(ref))
    })
  }

  // The middle of an element, scrolled into view, in the page's viewport.
  private async point(t: AgentTab, ref: string): Promise<{ x: number; y: number }> {
    await this.onNode(t, ref, 'DOM.scrollIntoViewIfNeeded')
    const { quads } = await this.onNode(t, ref, 'DOM.getContentQuads')
    const quad = (quads as number[][]).find((q) => area(q) > 1)
    if (!quad) throw new Error(`Element ${ref} isn't visible (it has no size on the page).`)
    return { x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4, y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4 }
  }

  private async object(t: AgentTab, ref: string): Promise<string> {
    const { object } = await this.onNode(t, ref, 'DOM.resolveNode')
    return object.objectId
  }

  // A key, or a combination (Control+Shift+Tab), pressed and let go.
  private async key(t: AgentTab, combo: string): Promise<void> {
    const parts = combo.split('+')
    const name = parts.pop() || '+'
    const modifiers = modifierBits(parts)
    const k = keyOf(name)
    const text = modifiers & ~MODIFIERS.Shift ? undefined : k.text
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers }
    await this.send(t, 'Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, text, unmodifiedText: text })
    await this.send(t, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }
}

// ---- The accessibility tree, as text ----

interface AXValue {
  value?: unknown
}
interface AXNode {
  nodeId: string
  ignored?: boolean
  role?: AXValue
  name?: AXValue
  value?: AXValue
  properties?: { name: string; value: AXValue }[]
  childIds?: string[]
  backendDOMNodeId?: number
}

// Roles that only group others: their children stand in for them, unless
// they're named.
const HOIST = new Set(['generic', 'none', 'presentation', 'paragraph', 'group', 'Section', 'list', 'listitem', 'LayoutTable', 'LayoutTableRow', 'LayoutTableCell', 'GenericContainer', 'ListMarker', 'LineBreak', 'InlineTextBox', 'Abbr', 'Pre', 'Div', 'emphasis', 'strong', 'time', 'mark', 'code', 'superscript', 'subscript', 'LabelText', 'MenuListPopup'])
const STATES = ['checked', 'selected', 'expanded', 'pressed', 'disabled', 'required', 'focused', 'invalid', 'readonly', 'modal']

export function renderTree(nodes: AXNode[]): string {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]))
  const root = nodes[0]
  const lines: string[] = []
  const clip = (s: string) => (s.length > 200 ? `${s.slice(0, 200)}…` : s)
  const visit = (n: AXNode | undefined, depth: number, context: string) => {
    if (!n) return
    const role = String(n.role?.value ?? '')
    const name = clip(String(n.name?.value ?? '').replace(/\s+/g, ' ').trim())
    const children = (d: number, c: string) => n.childIds?.forEach((id) => visit(byId.get(id), d, c))
    if (n.ignored || role === 'RootWebArea' || (HOIST.has(role) && !name)) return children(depth, context)
    if (role === 'StaticText') {
      if (name && !context.includes(name)) lines.push(`${'  '.repeat(depth)}- text: ${JSON.stringify(name)}`)
      return
    }
    let line = `${'  '.repeat(depth)}- ${role}${name ? ` ${JSON.stringify(name)}` : ''}`
    for (const p of n.properties ?? []) {
      const v = p.value?.value
      if (STATES.includes(p.name) && v && v !== 'false') line += v === true || v === 'true' ? ` [${p.name}]` : ` [${p.name}=${v}]`
      if (p.name === 'level') line += ` [level=${v}]`
    }
    const value = n.value?.value
    if (value !== undefined && value !== '' && String(value) !== name) line += ` value=${JSON.stringify(clip(String(value)))}`
    if (n.backendDOMNodeId) line += ` [ref=e${n.backendDOMNodeId}]`
    lines.push(line)
    children(depth + 1, `${name} ${value ?? ''}`)
  }
  visit(root, 0, '')
  return lines.join('\n')
}

// ---- Input ----

const MODIFIERS: Record<string, number> = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Shift: 8 }
const modifierBits = (names: string[]) => names.reduce((bits, m) => bits | (MODIFIERS[m] ?? 0), 0)

const KEYS: Record<string, [code: string, keyCode: number, text?: string]> = {
  Enter: ['Enter', 13, '\r'],
  Tab: ['Tab', 9],
  Escape: ['Escape', 27],
  Backspace: ['Backspace', 8],
  Delete: ['Delete', 46],
  ArrowUp: ['ArrowUp', 38],
  ArrowDown: ['ArrowDown', 40],
  ArrowLeft: ['ArrowLeft', 37],
  ArrowRight: ['ArrowRight', 39],
  Home: ['Home', 36],
  End: ['End', 35],
  PageUp: ['PageUp', 33],
  PageDown: ['PageDown', 34],
  Space: ['Space', 32, ' '],
  ' ': ['Space', 32, ' ']
}

function keyOf(name: string): { key: string; code: string; keyCode: number; text?: string } {
  const known = KEYS[name] ?? KEYS[name[0].toUpperCase() + name.slice(1)]
  if (known) return { key: name === 'Space' ? ' ' : name, code: known[0], keyCode: known[1], text: known[2] }
  if (/^F\d{1,2}$/.test(name)) return { key: name, code: name, keyCode: 111 + Number(name.slice(1)) }
  if (name.length === 1) {
    const upper = name.toUpperCase()
    const code = /[a-z]/i.test(name) ? `Key${upper}` : /\d/.test(name) ? `Digit${name}` : ''
    return { key: name, code, keyCode: upper.charCodeAt(0), text: name }
  }
  throw new Error(`Grove doesn't know the key ${JSON.stringify(name)}.`)
}

// ---- Helpers ----

function refNode(ref: unknown): number {
  const m = /^e(\d+)$/.exec(String(ref ?? ''))
  if (!m) throw new Error(`${JSON.stringify(ref)} isn't a ref; refs look like e12 (see snapshot).`)
  return Number(m[1])
}

const staleRef = (ref: string) => () => {
  throw new Error(`Element ${ref} is gone (the page changed); take a new snapshot.`)
}

function area(q: number[]): number {
  let a = 0
  for (let i = 0; i < 8; i += 2) a += q[i] * q[(i + 3) % 8] - q[(i + 2) % 8] * q[i + 1]
  return Math.abs(a) / 2
}

function withScheme(url: string): string {
  if (url.includes('://') || /^(about|data|javascript|chrome|file|blob|view-source):/i.test(url)) return url
  return /^(localhost|127\.|\[::1\])/.test(url) ? `http://${url}` : `https://${url}`
}

function timed<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what}: no answer from the page in ${ms / 1000}s`)), ms)))
  ]).finally(() => clearTimeout(timer))
}
