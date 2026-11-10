#!/usr/bin/env node
// Signs a release's SHA256SUMS with Grove's release key, for the updater
// (host/updates.ts) to check:
//
//   GROVE_RELEASE_KEY="$(cat release-key.pem)" node scripts/sign.mjs release/SHA256SUMS
//
// Writes <file>.sig (the ed25519 signature, base64). The key is the private
// half of host/updates.ts's RELEASE_KEY; a key that isn't is refused, so a
// release can't go out signed with a key the updater won't take.
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const file = process.argv[2]
const pem = process.env.GROVE_RELEASE_KEY
if (!file || !pem) {
  console.error('usage: GROVE_RELEASE_KEY=<private key PEM> node scripts/sign.mjs <file>')
  process.exit(1)
}
const updates = readFileSync(fileURLToPath(new URL('../host/updates.ts', import.meta.url)), 'utf8')
const expected = /export const RELEASE_KEY = '([^']+)'/.exec(updates)?.[1]
const key = createPrivateKey(pem)
const pub = createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64')
if (pub !== expected) {
  console.error("GROVE_RELEASE_KEY isn't the key host/updates.ts's RELEASE_KEY belongs to")
  process.exit(1)
}
const data = readFileSync(file)
const signature = sign(null, data, key)
if (!verify(null, data, createPublicKey(key), signature)) throw new Error("the signature doesn't verify")
writeFileSync(`${file}.sig`, signature.toString('base64') + '\n')
console.log(`signed ${file}`)
