// grove-workspaces.json in the profile dir: loaded once, saved debounced, written
// to a temp file and renamed over the old one so a crash never leaves half
// a file.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { COLORS, type Entry, type Model, type Workspace } from '../shared/types.ts'
import { emptyModel, normalize } from './model.ts'

const SAVE_DELAY_MS = 500

export class Store {
  private timer: NodeJS.Timeout | undefined
  private pending: Model | undefined
  private writing: Promise<void> = Promise.resolve()

  readonly path: string

  constructor(path: string) {
    this.path = path
  }

  load(): Model {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`grove: can't read ${this.path}, starting fresh:`, err)
        this.backUpBroken()
      }
      return emptyModel()
    }
    const model = parseModel(raw)
    if (!model) {
      console.error(`grove: ${this.path} is not a workspace model, starting fresh`)
      this.backUpBroken()
      return emptyModel()
    }
    return model
  }

  save(model: Model): void {
    this.pending = model
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flushAsync(), SAVE_DELAY_MS)
  }

  // Synchronous: for quitting, when there is no later.
  flush(): void {
    clearTimeout(this.timer)
    if (!this.pending) return
    const tmp = `${this.path}.tmp`
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(tmp, serialize(this.pending))
    renameSync(tmp, this.path)
    this.pending = undefined
  }

  private flushAsync(): void {
    const model = this.pending
    if (!model) return
    this.pending = undefined
    const tmp = `${this.path}.tmp`
    this.writing = this.writing
      .then(async () => {
        mkdirSync(dirname(this.path), { recursive: true })
        await writeFile(tmp, serialize(model))
        await rename(tmp, this.path)
      })
      .catch((err) => console.error('grove: saving workspaces failed:', err))
  }

  private backUpBroken(): void {
    try {
      renameSync(this.path, `${this.path}.broken-${Date.now()}`)
    } catch {
      // Nothing to keep.
    }
  }
}

function serialize(model: Model): string {
  return JSON.stringify(model, null, 1)
}

// Accepts a stored model, dropping anything malformed rather than failing:
// a bad entry costs one tab, not every workspace.
export function parseModel(raw: unknown): Model | undefined {
  if (!isObject(raw) || raw.version !== 1 || !Array.isArray(raw.workspaces)) return undefined
  const workspaces = raw.workspaces.map(parseWorkspace).filter((w): w is Workspace => !!w)
  if (workspaces.length === 0) return undefined
  const last = workspaces.find((w) => w.id === raw.lastActiveWorkspaceId) ?? workspaces[0]
  return { version: 1, workspaces, lastActiveWorkspaceId: last.id }
}

function parseWorkspace(raw: unknown): Workspace | undefined {
  if (!isObject(raw) || !isString(raw.id) || !Array.isArray(raw.entries)) return undefined
  const groups = Array.isArray(raw.groups)
    ? raw.groups.filter(isObject).flatMap((g) =>
        isString(g.id)
          ? [
              {
                id: g.id,
                title: isString(g.title) ? g.title : 'Folder',
                color: color(g.color),
                collapsed: g.collapsed === true
              }
            ]
          : []
      )
    : []
  const entries = raw.entries.map(parseEntry).filter((e): e is Entry => !!e)
  return normalize({
    id: raw.id,
    name: isString(raw.name) && raw.name ? raw.name : 'Workspace',
    color: color(raw.color),
    entries,
    groups,
    activeEntryId: isString(raw.activeEntryId) ? raw.activeEntryId : undefined
  })
}

function parseEntry(raw: unknown): Entry | undefined {
  if (!isObject(raw) || !isString(raw.id) || !isString(raw.url)) return undefined
  const history = Array.isArray(raw.history)
    ? raw.history
        .filter(isObject)
        .filter((h) => isString(h.url))
        .map((h) => ({
          url: h.url as string,
          title: isString(h.title) ? h.title : '',
          ...(isString(h.pageState) ? { pageState: h.pageState } : {})
        }))
    : []
  const index = typeof raw.historyIndex === 'number' ? raw.historyIndex : history.length - 1
  return {
    id: raw.id,
    url: raw.url,
    title: isString(raw.title) ? raw.title : '',
    favicon: isString(raw.favicon) ? raw.favicon : undefined,
    pinned: raw.pinned === true,
    groupId: isString(raw.groupId) ? raw.groupId : undefined,
    history,
    historyIndex: Math.min(Math.max(index, -1), history.length - 1),
    lastActive: typeof raw.lastActive === 'number' ? raw.lastActive : 0
  }
}

function color(raw: unknown): Workspace['color'] {
  return COLORS.includes(raw as Workspace['color']) ? (raw as Workspace['color']) : 'gray'
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isString(v: unknown): v is string {
  return typeof v === 'string'
}
