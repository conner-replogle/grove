// `grove sync ...`: sets up sync between this device's Grove and others,
// through a Grove sync server (sync-worker/). Everything is sealed with a
// secret only the devices have.
//
//   grove sync setup <server-url>          a new sync account for this device
//   grove sync join <sync-code>            join the account another device set up
//   grove sync status
//   grove sync off
import { countRecords, loadSyncState, probe } from '../host/sync/client.ts'
import { readSyncConfig, removeSyncConfig, statePath, writeSyncConfig } from '../host/sync/config.ts'
import { deriveKeys, newSecret } from '../host/sync/crypto.ts'
import { checkServer, parseSyncCode, syncCode } from '../host/sync/manager.ts'

export async function syncCli(profile, args, running) {
  const [cmd, ...rest] = args
  const restart = () => running && console.log('Restart Grove for this to take effect.')
  switch (cmd) {
    case 'setup': {
      if (!rest[0]) throw new Error('usage: grove sync setup <server-url>')
      const config = { url: checkServer(rest[0]), secret: newSecret() }
      await probe(config.url, config.secret)
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
      if (!config) return console.log('Sync is off. Set it up with: grove sync setup <server-url>')
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
    default:
      console.log(`usage:
  grove sync setup <server-url>          set up sync; prints the secret for other devices
  grove sync join <sync-code>            join sync set up on another device
  grove sync status
  grove sync off`)
  }
}
