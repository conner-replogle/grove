// Organize: Workers AI sorts a workspace's loose tabs into folders, on the
// user's own Cloudflare account (host/workers-ai.ts). It's off until they
// give Grove a Workers AI key. Unlike sync, this is NOT end-to-end
// encrypted: the tabs' titles and URLs (no query or fragment) go to
// Cloudflare. Ids are the caller's own; short ones read better to the
// models.

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
