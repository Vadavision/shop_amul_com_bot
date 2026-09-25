/**
 * The product catalogue as the bot's screens see it.
 */
import { openSession, isInStock, labelForCategory } from '../amul.js'
import * as db from '../db.js'

/**
 * The catalogue for this user's substore, cached.
 *
 * A live fetch is ~2.5s. Doing that inline on a button tap — twice, once to
 * resolve the product and once to redraw — meant a tap took five seconds and
 * Telegram gave up on the callback long before it finished, so taps looked
 * like they did nothing. The sweep refreshes this every ten minutes, so taps
 * almost always hit the cache.
 */
export async function loadProducts(env, user, categoryIds) {
  let products = await db.getCatalog(env, user.substore)

  if (!products) {
    products = await (await openSession(user.substore)).products()
    await db.putCatalog(env, user.substore, products)
  }

  return categoryIds?.length
    ? products.filter((p) => (p.categories ?? []).some((c) => categoryIds.includes(c)))
    : products
}

/** Categories, counted straight off whatever the store returned this minute. */
export function deriveCategories(products) {
  const counts = new Map()
  for (const product of products) {
    for (const id of product.categories ?? []) {
      const row = counts.get(id) ?? { id, total: 0, stocked: 0 }
      row.total++
      if (isInStock(product)) row.stocked++
      counts.set(id, row)
    }
  }
  return [...counts.values()]
    .map((row) => ({ ...row, label: labelForCategory(row.id) }))
    .sort((a, b) => b.stocked - a.stocked || b.total - a.total || a.label.localeCompare(b.label))
}
