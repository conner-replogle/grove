// Organize as the host does it: asks the sync server to sort a workspace's
// loose tabs (unpinned, in no folder) into folders, and files them.
// See shared/organize-protocol.ts.
import type { OrganizeRequest, OrganizeResponse } from '../shared/organize-protocol.ts'
import { ORGANIZE_MAX_FOLDERS, ORGANIZE_MAX_TABS } from '../shared/organize-protocol.ts'
import type { Entry, Workspace } from '../shared/types.ts'
import * as M from './model.ts'

export interface OrganizeAuth {
  server: string
  account: string
  token: string
}

export interface Prepared {
  request: OrganizeRequest
  // Short request id -> entry or folder id.
  ids: Map<string, string>
}

// The page's address without its query or fragment, or nothing for pages
// that aren't on the web (New Tab, chrome://, files).
export function sendableUrl(url: string): string | undefined {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`.slice(0, 300)
  } catch {
    return undefined
  }
}

// Tabs Organize may move: the workspace's loose web pages.
export function looseTabs(ws: Workspace): Entry[] {
  return ws.entries.filter((e) => !e.pinned && !e.groupId && sendableUrl(e.url))
}

export function prepare(ws: Workspace, tabs: Entry[]): Prepared {
  const ids = new Map<string, string>()
  const folders = ws.groups
    .filter((g) => !g.pinned)
    .slice(0, ORGANIZE_MAX_FOLDERS)
    .map((g, i) => {
      ids.set(`f${i}`, g.id)
      const examples = ws.entries.filter((e) => e.groupId === g.id).slice(0, 3).map((e) => e.title.slice(0, 300))
      return { id: `f${i}`, title: g.title.slice(0, 200), examples }
    })
  const sent = tabs.slice(-ORGANIZE_MAX_TABS).map((e, i) => {
    ids.set(`t${i}`, e.id)
    return { id: `t${i}`, title: (e.title || e.url).slice(0, 300), url: sendableUrl(e.url)! }
  })
  return { request: { folders, tabs: sent }, ids }
}

export async function requestOrganize(auth: OrganizeAuth, request: OrganizeRequest, timeoutMs = 30_000): Promise<OrganizeResponse> {
  const res = await fetch(`${auth.server.replace(/\/+$/, '')}/v1/${auth.account}/organize`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!res.ok) throw new Error(`organize: ${res.status} ${(await res.text()).trim()}`)
  return (await res.json()) as OrganizeResponse
}

// Files the tabs as the server said, into the workspace as it is now: tabs
// closed, pinned or filed meanwhile stay where they are, and so do tabs
// for a folder that's gone. A new folder needs two tabs still loose.
export function applyOrganize(ws: Workspace, answer: OrganizeResponse, ids: Map<string, string>): Workspace {
  const loose = (id: string | undefined) => {
    const e = id && ws.entries.find((x) => x.id === id)
    return e && !e.pinned && !e.groupId ? e.id : undefined
  }
  for (const [tab, folder] of Object.entries(answer.assign ?? {})) {
    const entryId = loose(ids.get(tab))
    const groupId = ids.get(folder)
    if (entryId && groupId && ws.groups.some((g) => g.id === groupId && !g.pinned)) ws = M.setEntryGroup(ws, entryId, groupId)
  }
  for (const f of answer.create ?? []) {
    const title = typeof f.title === 'string' ? f.title.trim().slice(0, 40) : ''
    const members = [...new Set((f.tabs ?? []).map((t) => loose(ids.get(t))).filter((x): x is string => !!x))]
    if (title && members.length >= 2) ws = M.createGroup(ws, members, title)[0]
  }
  return ws
}
