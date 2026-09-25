/**
 * One Telegram update in: who is it, are they allowed, and which screen
 * handles it. Each screen lives in its own module alongside this one.
 */
import { AmulError } from '../amul.js'
import * as db from '../db.js'
import { send } from '../telegram.js'
import { NAV } from './ui.js'
import { askPincode, requirePincode, setPincode, pincodeFromLocation } from './pincode.js'
import { showSearch, showCategories } from './browse.js'
import { showWatchlist, showCheck } from './watchlist.js'
import { handleCommand } from './commands.js'
import { handleCallback } from './callbacks.js'

export { COMMANDS } from './commands.js'

export async function handleUpdate(env, update) {
  const msg = update.message ?? update.edited_message
  const cq = update.callback_query
  const from = msg?.from ?? cq?.from
  const chat = msg?.chat ?? cq?.message?.chat
  if (!from || !chat || chat.type !== 'private') return

  const chatId = chat.id
  if (!(await db.isAllowed(env, chatId))) {
    // Best effort: there is no one to report a failed refusal to.
    await send(env, chatId, `🔒 This bot is invite-only.\n\nYour Telegram ID is <code>${chatId}</code> — ask the owner to add you.`).catch(() => {})
    return
  }

  const user = await db.upsertUser(env, from)

  try {
    if (cq) return await handleCallback(env, cq, user)
    if (msg.location) return await handleLocation(env, chatId, msg.location)

    const text = msg.text?.trim()
    if (!text) return

    if (text.startsWith('/')) return await handleCommand(env, msg, user)
    if (/^\d{6}$/.test(text)) return await setPincode(env, chatId, text)

    // Persistent keyboard taps arrive as ordinary text.
    if (text === NAV.list) return await showWatchlist(env, chatId, null, user)
    if (text === NAV.area) return await askPincode(env, chatId)
    if (!(await requirePincode(env, chatId, user))) return
    if (text === NAV.check) return await showCheck(env, chatId, user)
    if (text === NAV.browse) return await showCategories(env, chatId, null, user)

    // Anything else is a product search. This is the fast path.
    return await showSearch(env, chatId, null, user, text)
  } catch (err) {
    console.error('handleUpdate failed:', err?.stack ?? err)
    // Best effort again: if Telegram itself is what failed, this fails too.
    await send(
      env,
      chatId,
      err instanceof AmulError ? '⚠️ Amul is not responding right now. Try again in a minute.' : '⚠️ Something went wrong on my side.'
    ).catch(() => {})
  }
}

async function handleLocation(env, chatId, location) {
  const pincode = await pincodeFromLocation(location.latitude, location.longitude)
  return pincode
    ? setPincode(env, chatId, pincode)
    : send(env, chatId, "I couldn't read a pincode from that. Please type your 6 digits.")
}
