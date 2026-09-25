/**
 * Typed /commands.
 */
import * as db from '../db.js'
import { send, esc } from '../telegram.js'
import { mainKeyboard } from './ui.js'
import { requirePincode, setPincode } from './pincode.js'
import { showStart, showHelp } from './home.js'
import { showSearch, showCategories } from './browse.js'
import { showWatchlist, showCheck, sendTestAlert } from './watchlist.js'
import { showHistory } from './history.js'

/** The menu Telegram shows. Admin and diagnostic commands stay off it. */
export const COMMANDS = [
  { command: 'start', description: 'Start the bot' },
  { command: 'search', description: 'Find a product by name' },
  { command: 'products', description: 'Browse everything' },
  { command: 'tracked', description: 'Show everything you are watching' },
  { command: 'check', description: 'Check stock right now' },
  { command: 'history', description: 'When your items were last in stock' },
  { command: 'setpincode', description: 'Set your delivery area' },
  { command: 'pause', description: 'Pause alerts without losing your list' },
  { command: 'resume', description: 'Resume alerts' },
  { command: 'help', description: 'How this bot works' }
]

const isAdmin = (env, chatId) => String(env.ADMIN_CHAT_ID) === String(chatId)

// Commands that need an area before they can show anything.
const NEEDS_AREA = new Set(['search', 'products', 'check', 'history', 'testalert'])

export async function handleCommand(env, msg, user) {
  const chatId = msg.chat.id
  const [raw, ...rest] = msg.text.trim().split(/\s+/)
  const command = raw.split('@')[0].slice(1).toLowerCase()
  const args = rest.join(' ')

  if (NEEDS_AREA.has(command) && !(await requirePincode(env, chatId, user))) return

  switch (command) {
    case 'start': return showStart(env, chatId, user)
    case 'help': return showHelp(env, chatId)
    case 'setpincode': return setPincode(env, chatId, args)
    case 'pincode':
      return send(env, chatId, user.substore ? `📍 <b>${esc(user.pincode)}</b> · ${esc(user.substore)} store` : 'No area set yet.', { reply_markup: mainKeyboard() })
    case 'search':
      if (!args) return send(env, chatId, 'Type what you are looking for, like <code>whey</code>.', { reply_markup: mainKeyboard() })
      return showSearch(env, chatId, null, user, args)
    case 'products': return showCategories(env, chatId, null, user)
    case 'tracked': return showWatchlist(env, chatId, null, user)
    case 'history': return showHistory(env, chatId, null, user)
    case 'check': return showCheck(env, chatId, user)
    case 'pause':
      await db.setPaused(env, chatId, true)
      return send(env, chatId, '⏸ Alerts paused. Your list is untouched.', { reply_markup: mainKeyboard() })
    case 'resume':
      await db.setPaused(env, chatId, false)
      return send(env, chatId, '▶️ Alerts back on.', { reply_markup: mainKeyboard() })
    case 'whoami': return send(env, chatId, `Your Telegram chat ID is <code>${chatId}</code>`)
    case 'testalert': return sendTestAlert(env, chatId, user)

    case 'stats': {
      if (!isAdmin(env, chatId)) return
      const s = await db.stats(env)
      return send(env, chatId, `👥 Users: <b>${s.users}</b>\n🔔 Tracks: <b>${s.tracks}</b>\n🏬 Substores: <b>${s.substores}</b>\n🔐 Mode: <b>${esc(env.ACCESS_MODE)}</b>`)
    }
    case 'allow':
    case 'disallow': {
      if (!isAdmin(env, chatId)) return
      const id = Number(args.trim())
      if (!id) return send(env, chatId, `Usage: <code>/${command} 123456789</code>`)
      await (command === 'allow' ? db.allow(env, id) : db.disallow(env, id))
      return send(env, chatId, `${command === 'allow' ? '✅ Allowed' : '🚫 Removed'} <code>${id}</code>`)
    }
    default:
      return send(env, chatId, "I don't know that one — /help explains everything.", { reply_markup: mainKeyboard() })
  }
}
