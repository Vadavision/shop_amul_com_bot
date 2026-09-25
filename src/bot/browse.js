/**
 * Finding products: search (the main way in), a product's sizes, and
 * category browsing.
 */
import { isInStock, labelForCategory } from '../amul.js'
import * as db from '../db.js'
import { send, esc, keyboard } from '../telegram.js'
import { fitEnd, matchesQuery, splitFamily, groupFamilies } from '../format.js'
import { PAGE, legend, mainKeyboard, show, familyRows, variantRows } from './ui.js'
import { loadProducts, deriveCategories } from './catalog.js'

const trackedSkus = async (env, chatId) => new Set((await db.listTracks(env, chatId)).map((t) => t.sku))
const inStockFirst = (a, b) => Number(isInStock(b)) - Number(isInStock(a))

export async function showSearch(env, chatId, messageId, user, query, offset = 0) {
  const q = query.trim()
  const hits = (await loadProducts(env, user)).filter((p) => matchesQuery(p, q)).sort(inStockFirst)

  if (!hits.length) {
    return send(
      env,
      chatId,
      [`🔍 Nothing matches <b>${esc(q)}</b>.`, '', 'Try a shorter word, or tap <b>Browse all</b>.'].join('\n'),
      { reply_markup: mainKeyboard() }
    )
  }

  const ctx = `q:${q.slice(0, 24)}`

  // One product with several sizes? Skip the middle step entirely.
  const families = groupFamilies(hits)
  if (families.size === 1) return showFamily(env, chatId, messageId, user, hits[0].sku, ctx)

  const trackedSet = await trackedSkus(env, chatId)
  const page = hits.slice(offset, offset + PAGE)
  const { rows, heading } = familyRows(page, trackedSet, ctx)

  const text = [
    `🔍 <b>${esc(q)}</b> — ${families.size} products, ${hits.filter(isInStock).length} in stock`,
    heading ? `<i>${esc(heading)}</i>` : '',
    '',
    legend,
    '',
    'Tap one to see its sizes.'
  ]
    .filter(Boolean)
    .join('\n')

  const remaining = hits.length - (offset + page.length)
  if (remaining > 0) {
    rows.push([{ text: `⬇️ Show ${Math.min(PAGE, remaining)} more (${remaining} left)`, callback_data: `s:${offset + PAGE}:${q.slice(0, 24)}` }])
  }
  rows.push([{ text: `🔔 My list (${trackedSet.size})`, callback_data: 'tracked' }, { text: '🗂 Browse all', callback_data: 'cats' }])

  return show(env, chatId, messageId, text, keyboard(rows))
}

/** Every size of one product, with the product named in the header. */
export async function showFamily(env, chatId, messageId, user, anchorSku, ctx) {
  const all = await loadProducts(env, user)
  const anchor = all.find((p) => p.sku === anchorSku)
  if (!anchor) return send(env, chatId, 'That product is no longer listed.')

  const { family } = splitFamily(anchor.name)
  const items = all.filter((p) => splitFamily(p.name).family === family)
  const trackedSet = await trackedSkus(env, chatId)
  const { rows, common } = variantRows(items, trackedSet, `f:${anchorSku}:${ctx}`)

  const text = [
    `<b>${esc(family)}</b>${common ? ` · ${esc(common)}` : ''}`,
    `📍 ${esc(user.pincode)} · ${items.filter(isInStock).length} of ${items.length} in stock`,
    '',
    legend,
    '',
    'Tap a size to start or stop watching it.'
  ].join('\n')

  const untracked = items.filter((p) => !trackedSet.has(p.sku))
  if (untracked.length > 1) {
    rows.push([{ text: `🔔 Watch all ${untracked.length} sizes`, callback_data: `A:${anchorSku}:${ctx}` }])
  }
  rows.push([
    { text: '‹ Back', callback_data: ctx.startsWith('q:') ? `s:0:${ctx.slice(2)}` : ctx },
    { text: `🔔 My list (${trackedSet.size})`, callback_data: 'tracked' }
  ])

  return show(env, chatId, messageId, text, keyboard(rows))
}

/**
 * Watch every size of the product `anchorSku` belongs to.
 * Returns how many were added, or null when the product is no longer listed.
 */
export async function watchAllSizes(env, chatId, user, anchorSku) {
  const all = await loadProducts(env, user)
  const anchor = all.find((p) => p.sku === anchorSku)
  if (!anchor) return null

  const { family } = splitFamily(anchor.name)
  const have = await trackedSkus(env, chatId)
  const toAdd = all.filter((p) => splitFamily(p.name).family === family && !have.has(p.sku))
  for (const p of toAdd) await db.addTrack(env, chatId, p.sku, p.name)
  return toAdd.length
}

export async function showCategories(env, chatId, messageId, user) {
  const products = await loadProducts(env, user)
  const categories = deriveCategories(products)

  const rows = categories.map((c) => [
    {
      text: fitEnd(`${c.stocked ? '✅' : '▫️'} ${c.label} · ${c.stocked} of ${c.total}`),
      callback_data: `c:${c.id}:0`
    }
  ])

  const text = [
    '🗂 <b>Browse everything</b>',
    `📍 ${esc(user.pincode)} · ${products.length} products in ${categories.length} categories`,
    '',
    '<i>Faster: just type what you want, like</i> <code>whey</code>.'
  ].join('\n')

  return show(env, chatId, messageId, text, keyboard(rows))
}

export async function showCategory(env, chatId, messageId, user, catId, offset) {
  const products = (await loadProducts(env, user, [catId])).sort(inStockFirst)
  if (!products.length) return send(env, chatId, 'Nothing in that category right now.')

  const trackedSet = await trackedSkus(env, chatId)
  const page = products.slice(offset, offset + PAGE)
  const { rows, heading } = familyRows(page, trackedSet, `c:${catId}:${offset}`)

  const text = [
    `<b>${esc(labelForCategory(catId))}</b> · ${esc(user.pincode)}`,
    `${products.filter(isInStock).length} of ${products.length} in stock`,
    heading ? `<i>${esc(heading)}</i>` : '',
    '',
    legend,
    '',
    'Tap one to see its sizes.'
  ]
    .filter(Boolean)
    .join('\n')

  const remaining = products.length - (offset + page.length)
  const nav = []
  if (offset > 0) nav.push({ text: '‹ Back', callback_data: `c:${catId}:${Math.max(0, offset - PAGE)}` })
  if (remaining > 0) nav.push({ text: `⬇️ ${Math.min(PAGE, remaining)} more (${remaining} left)`, callback_data: `c:${catId}:${offset + PAGE}` })
  if (nav.length) rows.push(nav)
  rows.push([{ text: '‹ Categories', callback_data: 'cats' }, { text: `🔔 My list (${trackedSet.size})`, callback_data: 'tracked' }])

  return show(env, chatId, messageId, text, keyboard(rows))
}
