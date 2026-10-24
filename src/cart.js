/**
 * Auto add-to-cart, on the owner's own Amul account.
 *
 * Amul only keeps a cart for the browser that made it, so a cart the bot builds
 * as a guest can never reliably reach the owner. Instead the bot signs in as
 * the owner with their login cookie and fills the cart on their account, which
 * any browser shows once they log in. It only ever adds to the cart: paying is
 * always the owner's own step.
 *
 * The cookie is Amul's `jsessionid`. It is HttpOnly, so no page script can read
 * it; the owner pastes it with /amullogin. Amul pushes its expiry a week out
 * each time it is used, so a daily check keeps it alive for as long as the bot
 * runs, and a dead one is reported rather than silently ignored.
 */
import { AmulSession, isInStock } from './amul.js'
import { send } from './telegram.js'
import * as db from './db.js'

export const LOGIN_KEY = 'amul_login'

// Using the cookie is what keeps it alive, so use it at least this often.
const KEEP_ALIVE_MS = 12 * 60 * 60 * 1000

export class LoginExpiredError extends Error {
  constructor() {
    super('The saved Amul login is no longer signed in')
    this.name = 'LoginExpiredError'
  }
}

/** The jsessionid out of whatever was pasted: a Cookie header, "jsessionid=…", or the bare value. */
export function parseJsessionid(text) {
  const pasted = String(text ?? '').trim()
  const value = (pasted.match(/(?:^|[;\s])jsessionid=([^;\s]+)/i)?.[1] ?? pasted).replace(/^"|"$/g, '')
  return /^[\w%.+/=:-]{40,}$/.test(value) ? value : null
}

/** The saved login, or null when there is none or it is known to be dead. */
export function activeLogin(state) {
  const row = state.meta.get(LOGIN_KEY)
  if (!row) return null
  try {
    const login = JSON.parse(row.value)
    return login.jsessionid && !login.expired ? login : null
  } catch {
    return null
  }
}

const storeVersionOf = (state) => Number(state.meta.get('store_version')?.value) || 6

/** A session signed in with this cookie, or LoginExpiredError if Amul no longer accepts it. */
export async function openLogin(jsessionid, storeVersion = 6) {
  const session = await AmulSession.withLogin(jsessionid).init({ storeVersion })
  if (!session.account) throw new LoginExpiredError()
  return session
}

/**
 * Put these SKUs, if they are still in stock, into the owner's cart.
 * Returns the items that went in.
 */
export async function addToAccountCart(state, login, { substore, skus }) {
  const session = await openLogin(login.jsessionid, storeVersionOf(state))
  const { store, cartId } = session.account

  // The account shops in one store, and stock and prices are per store. Items
  // from another one would land in the cart and then fail at checkout.
  if (store !== substore) throw new Error(`your Amul account is set to ${store}, not ${substore}`)
  if (!cartId) throw new Error('your Amul account has no cart id')

  const items = (await session.products({ skus, raw: true })).filter(isInStock)
  for (const product of items) {
    const { cart } = await session.addToCart(product, { cartId })
    // A cart that is not the customer's would mean the sign-in did not hold.
    if (!cart?.items?.some((i) => i.sku === product.sku) || !(cart.email_id || cart.phone)) {
      throw new Error(`${product.sku} did not land in your account cart`)
    }
  }
  return items
}

/** Remember that the login is dead and tell the owner, once. */
export async function reportExpired(env, state, login) {
  const dead = { ...login, expired: true }
  await db.putMeta(env, LOGIN_KEY, JSON.stringify(dead))
  state.meta.set(LOGIN_KEY, { value: JSON.stringify(dead), updated_at: Date.now() })
  if (!env.ADMIN_CHAT_ID) return
  await send(
    env,
    env.ADMIN_CHAT_ID,
    [
      '🔑 <b>Amul login expired</b>',
      '',
      'Restock alerts still work, but the cart is not being filled for you.',
      'Log in at shop.amul.com, copy your <code>jsessionid</code> cookie and send <code>/amullogin &lt;cookie&gt;</code>.'
    ].join('\n')
  )
}

/**
 * Use the saved login now and then so Amul keeps extending it, and find out
 * it has died before a restock does.
 */
export async function keepLoginAlive(env, state) {
  const login = activeLogin(state)
  if (!login || Date.now() - (login.checkedAt ?? login.savedAt) < KEEP_ALIVE_MS) return false
  try {
    await openLogin(login.jsessionid, storeVersionOf(state))
  } catch (err) {
    if (!(err instanceof LoginExpiredError)) throw err
    await reportExpired(env, state, login)
    return true
  }
  await db.putMeta(env, LOGIN_KEY, JSON.stringify({ ...login, checkedAt: Date.now() }))
  return true
}
