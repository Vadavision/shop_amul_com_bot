/**
 * "When was my stuff last in stock?"
 *
 * Reads the change log the sweep writes. Where nothing has changed it says so
 * against a stated start time, so an empty history reads as "nothing happened
 * since X" rather than implying a record that does not exist.
 */
import * as db from './db.js'
import { send, edit, keyboard, esc } from './telegram.js'
import { normalizeName } from './format.js'
import { formatIst } from './time.js'

const EVENTS_PER_ITEM = 5

export async function showHistory(env, chatId, messageId, user) {
  const tracks = await db.listTracksWithSince(env, chatId)
  const rows = keyboard([[{ text: '🔔 My list', callback_data: 'tracked' }]])

  if (!tracks.length) {
    const text = '📜 <b>Stock history</b>\n\nYou are not watching anything yet.'
    return messageId ? edit(env, chatId, messageId, text, rows) : send(env, chatId, text, rows)
  }

  const events = await db.stockHistory(env, user.substore, tracks.map((t) => t.sku))
  const snapshot = (await db.getSnapshot(env, user.substore)) ?? {}
  const loggingSince = Number((await db.getMetaRow(env, 'history_since')).value)

  const lines = [`📜 <b>Stock history</b> · ${esc(user.pincode)}`, '']

  for (const track of tracks) {
    const own = events.filter((e) => e.sku === track.sku).slice(0, EVENTS_PER_ITEM)
    lines.push(`<b>${esc(normalizeName(track.name))}</b>`)

    if (own.length) {
      for (const e of own) {
        const state = e.in_stock ? `✅ In stock · ${e.quantity} units` : '▫️ Sold out'
        lines.push(`${state} — ${esc(formatIst(e.at))}`)
      }
    } else {
      const since = Math.max(track.created_at, loggingSince)
      const state = snapshot[track.sku] === 1 ? '✅ In stock' : '▫️ Sold out'
      lines.push(`${state} — no change since ${esc(formatIst(since))}`)
    }
    lines.push('')
  }

  lines.push(`<i>Checked every minute. Recorded since ${esc(formatIst(loggingSince))}.</i>`)

  const text = lines.join('\n')
  return messageId ? edit(env, chatId, messageId, text, rows) : send(env, chatId, text, rows)
}
