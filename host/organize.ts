// Organize as the host does it: asks Workers AI, on the user's own key
// (organize-ai.ts, workers-ai.ts), to sort a workspace's loose tabs
// (unpinned, in no folder) into folders, and files them.
// See shared/organize-protocol.ts.
import type { OrganizeRequest, OrganizeResponse } from '../shared/organize-protocol.ts'
import { ORGANIZE_MAX_FOLDERS, ORGANIZE_MAX_TABS } from '../shared/organize-protocol.ts'
import type { Entry, Workspace } from '../shared/types.ts'
import * as M from './model.ts'

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

// What a tab is called, for the model: its title, or the address without
// its query or fragment when the page has no title or its title is an
// address (Chrome titles an untitled page with its URL, and queries and
// fragments can hold tokens).
export function sendableTitle(e: Entry): string {
  const title = e.title.trim()
  const addressLike = !/\s/.test(title) && (/^[a-z][a-z0-9+.-]*:/i.test(title) || /[/?#]/.test(title))
  if (!title || addressLike) return sendableUrl(e.url) ?? ''
  return title.slice(0, 300)
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
      const examples = ws.entries.filter((e) => e.groupId === g.id).slice(0, 3).map(sendableTitle)
      return { id: `f${i}`, title: g.title.slice(0, 200), examples }
    })
  const sent = tabs.slice(-ORGANIZE_MAX_TABS).map((e, i) => {
    ids.set(`t${i}`, e.id)
    return { id: `t${i}`, title: sendableTitle(e), url: sendableUrl(e.url)! }
  })
  return { request: { folders, tabs: sent }, ids }
}

// Files the tabs as the models said, into the workspace as it is now: tabs
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
