// End-to-end encryption for sync. One random secret, copied to every
// device, gives three things by HKDF: the account id (which log on the
// server), the token that proves a device may use it, and the AES-GCM key
// that seals every batch. The server only ever sees sealed blobs.
const subtle = globalThis.crypto.subtle
const text = new TextEncoder()

export interface SyncKeys {
  account: string
  token: string
  key: CryptoKey
}

const b64url = (bytes: ArrayBuffer | Uint8Array): string => Buffer.from(bytes as Uint8Array).toString('base64url')

export function newSecret(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)))
}

export async function deriveKeys(secret: string): Promise<SyncKeys> {
  const raw = Buffer.from(secret.trim(), 'base64url')
  if (raw.length !== 32) throw new Error('not a Grove sync secret (expected 32 bytes, base64url)')
  const base = await subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits', 'deriveKey'])
  const hkdf = (info: string) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: text.encode(info) })
  const account = Buffer.from(await subtle.deriveBits(hkdf('grove-sync account'), base, 128)).toString('hex')
  const token = b64url(await subtle.deriveBits(hkdf('grove-sync token'), base, 256))
  const key = await subtle.deriveKey(hkdf('grove-sync key'), base, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt'
  ])
  return { account, token, key }
}

// base64(iv || ciphertext); the account id is bound in as associated data.
export async function seal(keys: SyncKeys, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: text.encode(keys.account) },
    keys.key,
    text.encode(plain)
  )
  return Buffer.concat([iv, new Uint8Array(sealed)]).toString('base64')
}

export async function unseal(keys: SyncKeys, blob: string): Promise<string> {
  const bytes = Buffer.from(blob, 'base64')
  const plain = await subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: text.encode(keys.account) },
    keys.key,
    bytes.subarray(12)
  )
  return new TextDecoder().decode(plain)
}
