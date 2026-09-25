/**
 * The welcome screen and help.
 */
import * as db from '../db.js'
import { send, esc } from '../telegram.js'
import { normalizeName } from '../format.js'
import { mainKeyboard, legend } from './ui.js'
import { askPincode } from './pincode.js'

export async function showStart(env, chatId, user) {
  if (!user.substore) {
    await send(env, chatId, '👋 <b>Amul Stock Watcher</b>\n\nI message you the moment a product you want is back in stock.')
    return askPincode(env, chatId)
  }

  const tracks = await db.listTracks(env, chatId)
  const trending = await db.trendingSkus(env, 4)
  const lines = [
    '👋 <b>Amul Stock Watcher</b>',
    '',
    `📍 ${esc(user.pincode)} · watching <b>${tracks.length}</b> item${tracks.length === 1 ? '' : 's'}`,
    user.is_paused ? '⏸ <b>Alerts paused</b> — /resume to turn back on' : '',
    '',
    '<b>Type what you are looking for.</b>',
    'For example <code>whey</code>, <code>lassi</code>, <code>paneer</code>, <code>ghee</code>.',
    trending.length ? '\n🔥 <b>Most watched right now</b>' : '',
    ...trending.map((t) => `· ${esc(normalizeName(t.name))}`)
  ].filter(Boolean)

  return send(env, chatId, lines.join('\n'), { reply_markup: mainKeyboard() })
}

export async function showHelp(env, chatId) {
  return send(
    env,
    chatId,
    [
      '<b>How it works</b>',
      '',
      '<b>1.</b> Type what you want — <code>whey</code>, <code>lassi</code>, <code>paneer</code>. No commands needed.',
      '<b>2.</b> Tap an item to start watching it.',
      '<b>3.</b> I check every minute and message you as soon as it is back, with a buy link.',
      '',
      legend,
      '',
      'The buttons under the keyboard are always there: your list, an instant stock check, full browsing, and changing your area.',
      '',
      '/history shows when your items were last in stock.',
      '',
      '<i>Unofficial. Not affiliated with Amul.</i>'
    ].join('\n'),
    { reply_markup: mainKeyboard() }
  )
}
