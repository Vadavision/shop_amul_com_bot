/**
 * Encryption for the secrets the database holds: users' Amul logins.
 *
 * AES-GCM with a key that lives only as a Worker secret (LOGIN_ENC_KEY), so a
 * copy of the D1 database, an export or a backup is useless without it. It does
 * not protect against someone who can read the Worker's own secrets.
 *
 * Stored as "v1.<iv>.<ciphertext>" in base64url. GCM authenticates, so a
 * tampered or wrong-key value fails to decrypt instead of yielding garbage.
 */

const VERSION = 'v1'
// Binds a ciphertext to its owner, so one user's login copied onto another
// user's row fails to decrypt rather than signing them in as someone else.
const context = (owner) => new TextEncoder().encode(`amul-watch:amul_login:${owner}`)

export class KeyMissingError extends Error {
  constructor() {
    super('LOGIN_ENC_KEY is not set: refusing to store a login unencrypted')
    this.name = 'KeyMissingError'
  }
}

const toB64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromB64 = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

async function importKey(env) {
  if (!env.LOGIN_ENC_KEY) throw new KeyMissingError()
  const raw = fromB64(String(env.LOGIN_ENC_KEY).trim().replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))
  if (raw.length !== 32) throw new Error('LOGIN_ENC_KEY must be 32 random bytes, base64 encoded (openssl rand -base64 32)')
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function encrypt(env, owner, plaintext) {
  const key = await importKey(env)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: context(owner) }, key, new TextEncoder().encode(plaintext))
  return `${VERSION}.${toB64(iv)}.${toB64(new Uint8Array(sealed))}`
}

export async function decrypt(env, owner, value) {
  const [version, iv, sealed] = String(value).split('.')
  if (version !== VERSION || !iv || !sealed) throw new Error('stored login is not in the encrypted format')
  const key = await importKey(env)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv), additionalData: context(owner) }, key, fromB64(sealed))
  return new TextDecoder().decode(plain)
}
