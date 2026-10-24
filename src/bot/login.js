/**
 * /amullogin and /amullogout: a user gives the bot their own Amul login so it
 * can fill their cart when something they watch is back. The message holding
 * the cookie is deleted as soon as it is read.
 */
import * as db from '../db.js'
import { call, send, esc } from '../telegram.js'
import { parseJsessionid, saveLogin, LoginExpiredError } from '../cart.js'
import { KeyMissingError } from '../crypto.js'

const HOW = [
  '<b>How</b> (on a computer):',
  '1. Log in at shop.amul.com.',
  '2. Press F12 → <b>Network</b>, reload, click the first <code>shop.amul.com</code> request.',
  '3. Under <b>Request Headers</b> copy the whole <code>cookie</code> value.',
  '4. Send it here: <code>/amullogin &lt;paste&gt;</code>',
  '',
  'I only ever add to your cart, never pay. The cookie is stored encrypted, I delete your message, and /amullogout forgets it. Logging out on shop.amul.com also makes it useless.'
].join('\n')

export async function showLogin(env, msg, args) {
  const chatId = msg.chat.id
  if (!args.trim()) {
    const row = await db.getLogin(env, chatId)
    const status = !row ? 'You have not given me a login yet.' : row.expired ? '⚠️ Your saved login has expired.' : '✅ Your login is saved and working.'
    const off = env.AUTO_CART === '1' ? '' : '\n\n<i>Auto cart is switched off on this bot right now.</i>'
    return send(env, chatId, `🛒 <b>Auto add to cart</b>\n\nWhen something you watch is back, I can put it straight in your Amul cart.\n\n${status}\n\n${HOW}${off}`)
  }

  // Whatever happens next, the cookie should not stay in the chat.
  await call(env, 'deleteMessage', { chat_id: chatId, message_id: msg.message_id }).catch(() => {})

  const jsessionid = parseJsessionid(args)
  if (!jsessionid) return send(env, chatId, `That does not look like the cookie.\n\n${HOW}`)

  let account
  try {
    account = await saveLogin(env, chatId, jsessionid)
  } catch (err) {
    if (err instanceof KeyMissingError) {
      console.error(err.message)
      return send(env, chatId, '⚠️ Logins cannot be stored safely on this bot yet, so I did not save it.')
    }
    if (err instanceof LoginExpiredError) {
      return send(env, chatId, '⚠️ Amul does not see that cookie as logged in. Log in at shop.amul.com first, then copy it again.')
    }
    throw err
  }

  const user = await db.getUser(env, chatId)
  const mismatch = user?.substore && account.store && user.substore !== account.store
    ? `\n\n⚠️ Your Amul account is set to the <b>${esc(account.store)}</b> store but you watch <b>${esc(user.substore)}</b>. Set the same pincode on shop.amul.com, or nothing can go in the cart.`
    : ''
  return send(
    env,
    chatId,
    `✅ <b>Logged in${account.firstName ? ` as ${esc(account.firstName)}` : ''}</b>\n\nWhen something you watch is back in stock I will add it to your Amul cart and put an <b>Open cart</b> button on the alert.${mismatch}\n\nI deleted your message with the cookie.`
  )
}

export async function removeLogin(env, chatId) {
  await db.deleteLogin(env, chatId)
  return send(env, chatId, '🔑 Your Amul login is forgotten. Nothing will be added to your cart.')
}
