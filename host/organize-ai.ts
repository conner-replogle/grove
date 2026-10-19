// Organize's models (shared/organize-protocol.ts): sorts loose tabs into
// folders in two steps, to keep the bill small. Clef-flash, a decision
// model, picks each tab's folder from the ones the workspace has, or "none
// of these". Only the tabs left over go to a small LLM, which makes up new
// folders.
import type { OrganizeRequest, OrganizeResponse } from '../shared/organize-protocol.ts'

// Runs a Workers AI model (host/workers-ai.ts, with the user's own key).
export interface AiRunner {
  run(model: string, input: unknown): Promise<unknown>
}

export const CLEF = '@cf/cloudflare/clef-flash'
// Names new folders: a small mixture-of-experts model (3B active) that can
// keep to a JSON schema. Picked over Llama 3.2 3B and Granite 4.0 micro,
// which grouped real tabs badly or not at all, at Llama 3B's price.
export const NAMER = '@cf/qwen/qwen3-30b-a3b-fp8'
// Clef takes at most this many questions per request.
const QUESTIONS_PER_CALL = 64
// How sure Clef must be to put a tab in a folder; less, and it stays put.
const ASSIGN_AT = 0.6
const NEW = 'new'

export async function organize(ai: AiRunner, req: OrganizeRequest): Promise<OrganizeResponse> {
  const assign: Record<string, string> = {}
  let leftover = req.tabs
  if (req.folders.length) {
    leftover = []
    const picks = await pickFolders(ai, req)
    for (const tab of req.tabs) {
      const pick = picks.get(tab.id)
      if (pick === NEW) leftover.push(tab)
      else if (pick) assign[tab.id] = pick
    }
  }
  const create = leftover.length >= 2 ? await nameFolders(ai, req, leftover, assign) : []
  return { assign, create }
}

// Tab id -> folder id, or NEW. Tabs Clef isn't sure about are left out.
async function pickFolders(ai: AiRunner, req: OrganizeRequest): Promise<Map<string, string>> {
  const keyOf = new Map(req.folders.map((f, i) => [`f${i}`, f.id]))
  const criteria: Record<string, string> = {}
  req.folders.forEach((f, i) => {
    criteria[`f${i}`] = f.examples.length ? `The "${f.title}" folder, which holds tabs like: ${f.examples.join('; ')}` : `The "${f.title}" folder`
  })
  criteria[NEW] = 'None of these folders: the tab is about something else'
  const picks = new Map<string, string>()
  for (let i = 0; i < req.tabs.length; i += QUESTIONS_PER_CALL) {
    const chunk = req.tabs.slice(i, i + QUESTIONS_PER_CALL)
    const questions: Record<string, unknown> = {}
    for (const t of chunk) {
      questions[t.id] = { type: 'choice', instructions: `Which folder should browser tab ${t.id} go in?`, criteria }
    }
    const out = (await ai.run(CLEF, { model: 'clef-flash', state: { tabs: chunk }, questions })) as {
      answers?: Record<string, { choice?: string; probabilities?: Record<string, number>; confidence?: number }>
    }
    for (const t of chunk) {
      const a = out.answers?.[t.id]
      if (!a?.choice) continue
      const sure = a.probabilities?.[a.choice] ?? a.confidence ?? 0
      if (a.choice === NEW) picks.set(t.id, NEW)
      else if (sure >= ASSIGN_AT && keyOf.has(a.choice)) picks.set(t.id, keyOf.get(a.choice)!)
    }
  }
  return picks
}

const SCHEMA = {
  type: 'object',
  properties: {
    folders: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, tabs: { type: 'array', items: { type: 'string' } } },
        required: ['title', 'tabs']
      }
    }
  },
  required: ['folders']
}

// New folders for the tabs no folder fit. A name the workspace already has
// joins that folder instead.
async function nameFolders(
  ai: AiRunner,
  req: OrganizeRequest,
  tabs: OrganizeRequest['tabs'],
  assign: Record<string, string>
): Promise<OrganizeResponse['create']> {
  const existing = req.folders.map((f) => f.title)
  const system = [
    'You sort browser tabs into folders.',
    'Put tabs that share a clear topic, project, or task in a folder together; every folder needs at least 2 tabs.',
    'Name each folder in 1 to 3 words, in Title Case, without emoji.',
    'Leave out any tab that goes with no other tab.',
    existing.length ? `The workspace already has these folders, so don't reuse their names: ${existing.join(', ')}.` : '',
    'Answer with JSON: {"folders": [{"title": "...", "tabs": ["<tab id>", ...]}]}.'
  ]
    .filter(Boolean)
    .join(' ')
  const user = tabs.map((t) => `${t.id}: ${t.title} — ${t.url}`).join('\n')
  const out = (await ai.run(NAMER, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    response_format: { type: 'json_schema', json_schema: SCHEMA },
    max_tokens: 4096
  })) as { response?: unknown }
  let parsed = out.response
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return []
    }
  }
  const folders = (parsed as { folders?: unknown })?.folders
  if (!Array.isArray(folders)) return []

  const open = new Set(tabs.map((t) => t.id))
  const byTitle = new Map(req.folders.map((f) => [f.title.trim().toLowerCase(), f.id]))
  // New folders by lowercase name, so two of the same name become one.
  const made = new Map<string, OrganizeResponse['create'][number]>()
  for (const f of folders as { title?: unknown; tabs?: unknown }[]) {
    if (typeof f?.title !== 'string' || !Array.isArray(f.tabs)) continue
    const title = f.title.trim().slice(0, 40)
    const key = title.toLowerCase()
    const ids = [...new Set(f.tabs)].filter((id): id is string => typeof id === 'string' && open.has(id))
    if (!title) continue
    const same = byTitle.get(key)
    if (same) {
      for (const id of ids) assign[id] = same
    } else if (made.has(key)) {
      made.get(key)!.tabs.push(...ids)
    } else if (ids.length >= 2) {
      made.set(key, { title, tabs: ids })
    } else continue
    for (const id of ids) open.delete(id)
  }
  return [...made.values()]
}
