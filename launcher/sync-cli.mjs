// `grove sync ...`: sets up sync between this device's Grove and others,
// through a Grove sync server (sync-worker/). Everything is sealed with a
// secret only the devices have.
//
//   grove sync setup --invite <code> [server-url]   a new sync account for this device
//   grove sync join <sync-code>            join the account another device set up
//   grove sync status
//   grove sync off
//
// For the admin of an invite-only server (GROVE_SYNC_ADMIN_TOKEN = its
// ADMIN_TOKEN secret; --server picks it, default the public one):
//
//   grove sync invite [note]               a new invite code
//   grove sync invites                     every invite, and whether it's used
//   grove sync revoke <code>               takes back an unused one
import { countRecords, loadSyncState, probe } from '../host/sync/client.ts'
import { readSyncConfig, removeSyncConfig, statePath, writeSyncConfig } from '../host/sync/config.ts'
import { deriveKeys, newSecret } from '../host/sync/crypto.ts'
import { checkServer, parseSyncCode, syncCode } from '../host/sync/manager.ts'
import { DEFAULT_SYNC_SERVER } from '../shared/sync-protocol.ts'

// Takes `--name value` out of args.
function option(args, name) {
  const at = args.indexOf(name)
  if (at < 0) return undefined
  const [, value] = args.splice(at, 2)
  if (!value) throw new Error(`${name} needs a value`)
  return value
}

async function admin(server, method, path, body) {
  const token = process.env.GROVE_SYNC_ADMIN_TOKEN
  if (!token) throw new Error("set GROVE_SYNC_ADMIN_TOKEN to the server's ADMIN_TOKEN")
  const res = await fetch(`${server}/admin/invites${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`${server}: ${res.status} ${(await res.text()).trim()}`)
  return res.status === 204 ? undefined : res.json()
}

export async function syncCli(profile, args, running) {
  const [cmd, ...rest] = args
  // The server the admin commands go to.
  const adminServer = () => checkServer(option(rest, '--server') ?? DEFAULT_SYNC_SERVER)
  const restart = () => running && console.log('Restart Grove for this to take effect.')
  switch (cmd) {
    case 'setup': {
      const invite = option(rest, '--invite')
      const config = { url: checkServer(rest[0] ?? DEFAULT_SYNC_SERVER), secret: newSecret() }
      await probe(config.url, config.secret, invite)
      writeSyncConfig(profile, config)
      console.log(`Sync is set up. On your other devices, paste this sync code into Grove's settings, or run:\n\n  grove sync join ${syncCode(config)}\n`)
      console.log('Keep the code safe: it opens everything Grove syncs.')
      return restart()
    }
    case 'join': {
      if (!rest.length) throw new Error('usage: grove sync join <sync-code>')
      const config = parseSyncCode(rest.join(' '))
      await probe(config.url, config.secret)
      writeSyncConfig(profile, config)
      console.log("Joined. This device's workspaces merge with the synced ones (same names become one).")
      return restart()
    }
    case 'status': {
      const config = readSyncConfig(profile)
      if (!config) return console.log('Sync is off. Set it up with: grove sync setup --invite <code>')
      const { account } = await deriveKeys(config.secret)
      const s = loadSyncState(statePath(profile))
      console.log(`server   ${config.url}`)
      console.log(`account  ${account}`)
      if (!s) return console.log('Not synced yet: start Grove.')
      const c = countRecords(s.records)
      console.log(`device   ${s.device}`)
      console.log(`synced   ${c.workspaces} workspaces, ${c.tabs} tabs, ${c.folders} folders`)
      console.log(`waiting  ${s.pending.length} change(s) not on the server yet`)
      console.log(`last     ${s.lastSync ? new Date(s.lastSync).toLocaleString() : 'never'}`)
      return
    }
    case 'off':
      removeSyncConfig(profile)
      console.log('Sync is off on this device. Its workspaces stay as they are.')
      return restart()
    case 'invite': {
      const server = adminServer()
      const invite = await admin(server, 'POST', '', { note: rest.join(' ') })
      return console.log(invite.code)
    }
    case 'invites': {
      const list = await admin(adminServer(), 'GET', '')
      for (const i of list) {
        const state = i.account ? `used ${new Date(i.used).toLocaleDateString()} by ${i.account}` : 'unused'
        console.log(`${i.code}  ${state}${i.note ? `  (${i.note})` : ''}`)
      }
      return
    }
    case 'revoke': {
      const server = adminServer()
      if (!rest[0]) throw new Error('usage: grove sync revoke <code>')
      await admin(server, 'DELETE', `/${encodeURIComponent(rest[0])}`)
      return console.log('Revoked.')
    }
    default:
      console.log(`usage:
  grove sync setup --invite <code> [server-url]
                                         set up sync (on the public server unless
                                         given another); prints the code for other devices
  grove sync join <sync-code>            join sync set up on another device
  grove sync status
  grove sync off

for a sync server's admin (GROVE_SYNC_ADMIN_TOKEN; --server <url>):
  grove sync invite [note]               make an invite code
  grove sync invites                     list invites
  grove sync revoke <code>               take back an unused invite`)
  }
}
