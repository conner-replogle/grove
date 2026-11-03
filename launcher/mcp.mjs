// `grove mcp`: an MCP server over stdio for local agents (Claude Code and
// the like), which joins the agent to the Grove running on this profile
// (host/agents.ts serves the tools). Grove starts if it isn't running.
//
//   claude mcp add --scope user grove -- grove mcp
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { agentSocket } from '../host/agents.ts'

const connectTo = (path) =>
  new Promise((resolve, reject) => {
    const socket = connect(path)
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })

// start: how to start Grove ({ cmd, args }).
export async function mcpShim(profile, start) {
  const path = agentSocket(profile)
  let socket = await connectTo(path).catch(() => undefined)
  if (!socket) {
    process.stderr.write('grove mcp: starting Grove\n')
    spawn(start.cmd, start.args, { detached: true, stdio: 'ignore', env: process.env }).unref()
    for (let i = 0; i < 150 && !socket; i++) {
      await new Promise((r) => setTimeout(r, 200))
      if (process.platform === 'win32' || existsSync(path)) socket = await connectTo(path).catch(() => undefined)
    }
    if (!socket) {
      process.stderr.write(`grove mcp: Grove didn't open ${path}\n`)
      process.exit(1)
    }
  }
  process.stdin.pipe(socket)
  socket.pipe(process.stdout)
  socket.on('close', () => process.exit(0))
  socket.on('error', (e) => {
    process.stderr.write(`grove mcp: ${e.message}\n`)
    process.exit(1)
  })
  process.stdin.on('end', () => socket.end())
  // Until the agent or Grove goes.
  await new Promise(() => {})
}
