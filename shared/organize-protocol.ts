// Organize: the sync server sorts a workspace's loose tabs into folders.
// Unlike sync, this is NOT end-to-end encrypted: the tabs' titles and URLs
// (no query or fragment) reach the server, which asks Workers AI.
//
// POST <server>/v1/<account>/organize with `Authorization: Bearer <token>`
// (the account's sync token) and an OrganizeRequest. Ids are the caller's
// own, short ones read better to the models.

export interface OrganizeRequest {
  // The workspace's folders, each with a few of its tabs' titles.
  folders: { id: string; title: string; examples: string[] }[]
  tabs: { id: string; title: string; url: string }[]
}

export interface OrganizeResponse {
  // Tab id -> folder id: tabs that go in a folder that's already there.
  assign: Record<string, string>
  // New folders, each of at least two tabs.
  create: { title: string; tabs: string[] }[]
}

export const ORGANIZE_MAX_TABS = 128
export const ORGANIZE_MAX_FOLDERS = 64
