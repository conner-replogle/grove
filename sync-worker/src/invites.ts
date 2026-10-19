// Invites to an invite-only sync server: codes the server's admin makes
// (`grove sync invite`), each good for starting one account. Rooms ask
// here before taking a new account's token (room.ts). An invite stays
// tied to the account it started, so a device that set up an account and
// lost the connection before ready can say hello with it again.
// Kept apart from the Durable Object so tests can run it in memory.

export interface Invite {
  code: string
  note: string
  created: number
  // The account it started, once used.
  account?: string
  used?: number
}

export interface InviteStore {
  get(code: string): Invite | undefined
  put(invite: Invite): void
  delete(code: string): void
  list(): Invite[]
}

// Crockford's base32, without the letters people misread.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

// 'XXXX-XXXX-XXXX': 60 random bits.
export function newInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  const chars = [...bytes].map((b) => ALPHABET[b & 31]).join('')
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`
}

// How people type codes: any case, with or without dashes, O for 0, I/L for 1.
export function normalizeInvite(code: string): string {
  const c = code.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  return c.length === 12 ? `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}` : c
}

export class InviteBook {
  private readonly store: InviteStore

  constructor(store: InviteStore) {
    this.store = store
  }

  create(note = '', now = Date.now()): Invite {
    const invite = { code: newInviteCode(), note: note.slice(0, 200), created: now }
    this.store.put(invite)
    return invite
  }

  // True if the code is unused (it's now this account's) or already this
  // account's.
  redeem(code: string, account: string, now = Date.now()): boolean {
    const invite = this.store.get(normalizeInvite(code))
    if (!invite) return false
    if (invite.account) return invite.account === account
    this.store.put({ ...invite, account, used: now })
    return true
  }

  list(): Invite[] {
    return this.store.list().sort((a, b) => b.created - a.created)
  }

  // Takes back an invite nobody has used.
  revoke(code: string): boolean {
    const invite = this.store.get(normalizeInvite(code))
    if (!invite || invite.account) return false
    this.store.delete(invite.code)
    return true
  }
}

// A store in memory, for tests.
export class MemoryInviteStore implements InviteStore {
  private readonly invites = new Map<string, Invite>()
  get(code: string) {
    return this.invites.get(code)
  }
  put(invite: Invite) {
    this.invites.set(invite.code, invite)
  }
  delete(code: string) {
    this.invites.delete(code)
  }
  list() {
    return [...this.invites.values()]
  }
}
