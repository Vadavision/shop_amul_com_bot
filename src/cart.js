/**
 * Auto add-to-cart, on each user's own Amul account.
 *
 * Amul only keeps a guest cart for the browser that made it, and clears it when
 * the store is chosen, so a cart the bot builds as a guest cannot reliably reach
 * anyone. Instead each user who wants it gives the bot their Amul login with
 * /amullogin, and the bot fills the cart on their account, which every browser
 * they log in on shows. It only ever adds to a cart: paying is always theirs.
 *
 * The login is Amul's `jsessionid` cookie. It is HttpOnly, so no page script or
 * link can read it; the user pastes it. It is stored encrypted and bound to the
 * user (crypto.js). Amul pushes its expiry a week out each time it is used, so a
 * keep-alive uses every login at least every 12 hours, and a login that has died
 * is reported to its owner rather than silently ignored.
 */
import { AmulSession, isInStock } from './amul.js'
import { send } from './telegram.js'
import * as db from './db.js'
import { encrypt, decrypt } from './crypto.js'

export class LoginExpiredError extends Error {
  constructor() {
    super('The saved Amul login is no longer signed in')
    this.name = 'LoginExpiredError'
  }
}

/** Something the user has to fix on Amul's side; retrying will not help. */
export class CartSkipError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CartSkipError'
  }
}

/** The jsessionid out of whatever was pasted: a Cookie header, "jsessionid=…", or the bare value. */
export function parseJsessionid(text) {
  const pasted = String(text ?? '').trim()
  const value = (pasted.match(/(?:^|[;\s])jsessionid=([^;\s]+)/i)?.[1] ?? pasted).replace(/^"|"$/g, '')
  return /^[\w%.+/=:-]{40,}$/.test(value) ? value : null
}

const storeVersionOf = (state) => Number(state?.meta.get('store_version')?.value) || 6

/** A session signed in with this cookie, or LoginExpiredError if Amul no longer accepts it. */
export async function openLogin(jsessionid, storeVersion = 6) {
  const session = await AmulSession.withLogin(jsessionid).init({ storeVersion })
  if (!session.account) throw new LoginExpiredError()
  return session
}

/** Check a pasted cookie and, if it is signed in, store it encrypted for this chat. */
export async function saveLogin(env, chatId, jsessionid) {
  const session = await openLogin(jsessionid)
  await db.putLogin(env, chatId, await encrypt(env, chatId, jsessionid))
  return session.account
}

/** This user's signed-in session, or null if they have no working login saved. */
async function sessionFor(env, state, chatId) {
  const row = await db.getLogin(env, chatId)
  if (!row || row.expired) return null
  return openLogin(await decrypt(env, chatId, row.jsessionid), storeVersionOf(state))
}

/**
 * Put these SKUs, if they are still in stock, into this user's Amul cart.
 * Returns the items that went in, or null if the user has no working login.
 */
export async function addToAccountCart(env, state, { chatId, substore, skus }) {
  const session = await sessionFor(env, state, chatId)
  if (!session) return null
  const { store, cartId } = session.account

  // An account shops in one store, and stock and prices are per store. Items
  // from another would sit in the cart and then fail at checkout.
  if (store !== substore) {
    throw new CartSkipError(`Your Amul account is set to the <b>${store}</b> store, but you watch <b>${substore}</b>. Set the same pincode on shop.amul.com and the cart will fill next time.`)
  }
  if (!cartId) throw new Error('the Amul account has no cart id')

  const items = (await session.products({ skus, raw: true })).filter(isInStock)
  for (const product of items) {
    const { cart } = await session.addToCart(product, { cartId })
    // A cart that is not the customer's would mean the sign-in did not hold.
    if (!cart?.items?.some((i) => i.sku === product.sku) || !(cart.email_id || cart.phone)) {
      throw new Error(`${product.sku} did not land in the account cart`)
    }
  }
  return items
}

/** Mark a login dead and tell its owner, once. */
export async function reportExpired(env, chatId) {
  await db.markLogin(env, chatId, { expired: true })
  await send(
    env,
    chatId,
    [
      '🔑 <b>Your Amul login expired</b>',
      '',
      'Restock alerts still come, but I can no longer add things to your Amul cart.',
      'Send /amullogin to see how to give me a fresh one.'
    ].join('\n')
  )
}

/**
 * Use the login checked longest ago, if it is due, so Amul keeps extending it
 * and a dead one is found before a restock needs it. One per firing keeps the
 * cost flat however many users there are.
 */
export async function keepLoginAlive(env, state) {
  const chatId = state.loginDue
  if (chatId === null || chatId === undefined) return false
  try {
    if (!(await sessionFor(env, state, chatId))) return false
  } catch (err) {
    if (!(err instanceof LoginExpiredError)) throw err
    await reportExpired(env, chatId)
    return true
  }
  await db.markLogin(env, chatId, { checkedAt: Date.now() })
  return true
}
