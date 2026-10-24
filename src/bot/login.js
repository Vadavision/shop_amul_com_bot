/**
 * /amullogin and /amullogout: give the bot the owner's Amul login so it can
 * fill their cart. Owner only, and the message holding the cookie is deleted
 * as soon as it is read.
 */
import * as db from '../db.js'
import { call, send, esc } from '../telegram.js'
import { LOGIN_KEY, parseJsessionid, openLogin, activeLogin, LoginExpiredError } from '../cart.js'

const HOW = [
  '1. Log in at shop.amul.com on a computer.',
  '2. Press F12 → <b>Network</b>, reload, click the first <code>shop.amul.com</code> request.',
  '3. Under <b>Request Headers</b> copy the whole <code>cookie</code> value.',
  '4. Send it here: <code>/amullogin &lt;paste&gt;</code>'
].join('\n')

export async function showLogin(env, msg, args) {
  const chatId = msg.chat.id
  if (!args.trim()) {
    const state = await db.loadState(env)
    const login = activeLogin(state)
    const status = login
      ? '✅ A login is saved.'
      : state.meta.has(LOGIN_KEY)
        ? '⚠️ The saved login has expired.'
        : 'No login saved yet.'
    return send(env, chatId, `🔑 <b>Amul login</b>\n\n${status}\n\n${HOW}`)
  }

  // Whatever happens next, the cookie should not stay in the chat.
  await call(env, 'deleteMessage', { chat_id: chatId, message_id: msg.message_id }).catch(() => {})

  const jsessionid = parseJsessionid(args)
  if (!jsessionid) return send(env, chatId, `That does not look like a cookie.\n\n${HOW}`)

  let session
  try {
    session = await openLogin(jsessionid)
  } catch (err) {
    if (err instanceof LoginExpiredError) {
      return send(env, chatId, '⚠️ Amul does not see that cookie as logged in. Log in at shop.amul.com first, then copy it again.')
    }
    throw err
  }

  const now = Date.now()
  await db.putMeta(env, LOGIN_KEY, JSON.stringify({ jsessionid, savedAt: now, checkedAt: now }))
  const auto = env.AUTO_CART === '1' ? 'Your cart will be filled when something you watch is back in stock.' : 'Auto cart is switched off (AUTO_CART), so nothing will be added yet.'
  return send(
    env,
    chatId,
    `✅ <b>Logged in${session.account.firstName ? ` as ${esc(session.account.firstName)}` : ''}</b> · ${esc(session.account.store)} store\n\n${auto}\n\nI deleted your message with the cookie.`
  )
}

export async function removeLogin(env, chatId) {
  await env.DB.prepare('DELETE FROM meta WHERE key = ?').bind(LOGIN_KEY).run()
  return send(env, chatId, '🔑 Amul login removed. Nothing is added to your cart now.')
}
