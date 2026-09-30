// `grove sync ...`: sets up sync between this device's Grove and others,
// through a Grove sync server (sync-worker/). Everything is sealed with a
// secret only the devices have.
//
//   grove sync setup <server-url>          a new sync account for this device
//   grove sync join <server-url> <secret>  join the account another device set up
//   grove sync status
//   grove sync off
import { SYNC_PROTOCOL } from '../shared/sync-protocol.ts'
import { loadSyncState, socketUrl } from '../host/sync/client.ts'
import { readSyncConfig, removeSyncConfig, statePath, writeSyncConfig } from '../host/sync/config.ts'
import { deriveKeys, newSecret } from '../host/sync/crypto.ts'

export async function syncCli(profile, args, running) {
  const [cmd, ...rest] = args
  const restart = () => running && console.log('Restart Grove for this to take effect.')
  switch (cmd) {
    case 'setup': {
      const url = checkUrl(rest[0])
      const secret = newSecret()
      await check(url, secret)
      writeSyncConfig(profile, { url, secret })
      console.log(`Sync is set up. On your other devices, run:\n\n  grove sync join ${url} ${secret}\n`)
      console.log('Keep the secret safe: it opens everything Grove syncs.')
      return restart()
    }
    case 'join': {
      const url = checkUrl(rest[0])
      const secret = rest[1]
      if (!secret) throw new Error('usage: grove sync join <server-url> <secret>')
      await check(url, secret)
      writeSyncConfig(profile, { url, secret })
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
      const alive = s.records.filter(([, r]) => r.f.alive?.[0] === true)
      const count = (kind) => alive.filter(([, r]) => r.kind === kind).length
      console.log(`device   ${s.device}`)
      console.log(`synced   ${count('workspace')} workspaces, ${count('entry')} tabs, ${count('group')} folders`)
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
  grove sync join <server-url> <secret>  join sync set up on another device
  grove sync status
  grove sync off`)
  }
}

function checkUrl(url) {
  if (!url || !/^https?:\/\//.test(url)) throw new Error('give the sync server as a URL, e.g. https://grove-ui-sync.<you>.workers.dev')
  return url.replace(/\/$/, '')
}

// Says hello to the server with the secret's account and token.
async function check(url, secret) {
  const keys = await deriveKeys(secret)
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(socketUrl(url, keys.account))
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`no answer from ${url}`))
    }, 10_000)
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', v: SYNC_PROTOCOL, token: keys.token, cursor: 0 }))
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.t === 'error') reject(new Error(`the server says: ${msg.message}`))
      else if (msg.t !== 'ready') return
      clearTimeout(timer)
      ws.close()
      resolve()
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error(`can't reach ${url}`))
    }
  })
}
