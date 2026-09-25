/**
 * What the user is watching: the list, an instant stock check, and adding or
 * removing a product.
 */
import { isInStock, inventoryQuantity, productUrl } from '../amul.js'
import * as db from '../db.js'
import { send, esc, keyboard } from '../telegram.js'
import { restockMessage, buyButtons } from '../alert.js'
import { normalizeName, fit, fitEnd, splitFamily } from '../format.js'
import { mainKeyboard, show } from './ui.js'
import { loadProducts } from './catalog.js'

/**
 * Start or stop watching a product.
 * Returns false when asked to watch something that is no longer listed.
 */
export async function setWatching(env, chatId, user, sku, watching) {
  if (!watching) {
    await db.removeTrack(env, chatId, sku)
    return true
  }
  const product = (await loadProducts(env, user)).find((p) => p.sku === sku)
  if (!product) return false
  await db.addTrack(env, chatId, sku, product.name)
  return true
}

export async function showWatchlist(env, chatId, messageId, user) {
  const tracks = await db.listTracks(env, chatId)
  if (!tracks.length) {
    const text = ['🔔 <b>Your list is empty</b>', '', 'Type what you want — <code>whey</code>, <code>lassi</code>, <code>paneer</code> — then tap it.'].join('\n')
    // An edited message can only carry inline buttons; a new one gets the
    // persistent keyboard.
    return messageId
      ? show(env, chatId, messageId, text, keyboard([[{ text: '🗂 Browse all', callback_data: 'cats' }]]))
      : send(env, chatId, text, { reply_markup: mainKeyboard() })
  }

  // If the catalogue cannot be loaded this throws, and the user is told Amul
  // is not responding — rather than being shown everything as "sold out".
  const bySku = new Map((await loadProducts(env, user)).map((p) => [p.sku, p]))
  const stocked = tracks.filter((t) => bySku.has(t.sku) && isInStock(bySku.get(t.sku))).length

  const rows = tracks.map((t) => {
    const product = bySku.get(t.sku)
    const { family, variant } = splitFamily(t.name)
    const name = `${family}${variant ? ` · ${variant}` : ''}`
    // Amul delisted it: say so, and keep the button so it can be removed.
    // Status goes first — a long name gets cut from the end, and the status
    // must survive that; a clipped name still reads.
    const label = product ? `${isInStock(product) ? '✅' : '▫️'} ${name}` : `⚠️ No longer sold · ${name}`
    return [{ text: fitEnd(label), callback_data: `u:${t.sku}:l` }]
  })
  rows.push([{ text: '⚡ Check now', callback_data: 'check' }, { text: '📜 History', callback_data: 'hist' }])
  rows.push([{ text: '🗂 Browse all', callback_data: 'cats' }])

  const text = [
    `🔔 <b>Watching ${tracks.length} item${tracks.length === 1 ? '' : 's'}</b>`,
    stocked ? `✅ ${stocked} available right now` : 'None available right now — I am watching.',
    '',
    'Tap one to stop watching it.'
  ].join('\n')

  return show(env, chatId, messageId, text, keyboard(rows))
}

export async function showCheck(env, chatId, user) {
  const tracks = await db.listTracks(env, chatId)
  if (!tracks.length) {
    return send(env, chatId, 'Nothing on your list yet — type what you want, like <code>whey</code>.', { reply_markup: mainKeyboard() })
  }

  const wanted = new Set(tracks.map((t) => t.sku))
  const products = (await loadProducts(env, user)).filter((p) => wanted.has(p.sku))
  const inStock = products.filter(isInStock)
  const out = products.filter((p) => !isInStock(p))

  const lines = [`⚡ <b>Right now</b> · ${esc(user.pincode)}`, '']
  if (inStock.length) {
    lines.push(`<b>✅ Available (${inStock.length})</b>`)
    for (const p of inStock) {
      const qty = inventoryQuantity(p)
      lines.push(`<a href="${productUrl(p)}">${esc(normalizeName(p.name))}</a> · ₹${esc(p.price)}${qty > 0 ? ` · only ${qty} left` : ''}`)
    }
    lines.push('')
  }
  if (out.length) {
    lines.push(`<b>▫️ Sold out (${out.length})</b>`)
    for (const p of out) lines.push(esc(normalizeName(p.name)))
    lines.push('', '<i>I will message you the moment any of these return.</i>')
  }

  const rows = inStock.slice(0, 5).map((p) => [{ text: `🛒 Buy ${fit(normalizeName(p.name), 24)}`, url: productUrl(p) }])
  return send(env, chatId, lines.join('\n'), rows.length ? keyboard(rows) : { reply_markup: mainKeyboard() })
}

/**
 * A restock alert rendered by the real alert code, using real in-stock
 * products — preferably ones the user watches, so it shows the alert they
 * will actually get.
 */
export async function sendTestAlert(env, chatId, user) {
  const products = await loadProducts(env, user)
  const watched = new Set((await db.listTracks(env, chatId)).map((t) => t.sku))
  const mine = products.filter((p) => watched.has(p.sku) && isInStock(p))
  const sample = (mine.length ? mine : products.filter(isInStock)).slice(0, 2)

  if (!sample.length) {
    return send(env, chatId, 'Nothing is in stock in your area right now, so there is no real product to demo with.')
  }
  return send(env, chatId, restockMessage(sample, { test: true }), buyButtons(sample))
}
