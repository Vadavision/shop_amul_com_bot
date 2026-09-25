/**
 * Pieces every screen shares: navigation, the legend, product and size rows,
 * and showing a screen in place.
 */
import { isInStock, inventoryQuantity } from '../amul.js'
import { send, edit } from '../telegram.js'
import { commonPrefix, fitEnd, splitFamily, groupFamilies, factorCommon } from '../format.js'

export const PAGE = 12

// What a phone actually renders on an inline button before it clips.
const BUTTON_WIDTH = 34

export const legend = '✅ available now · ▫️ sold out · 🔔 you are watching it'

/**
 * Always-visible navigation.
 *
 * Inline buttons scroll away with the message that carried them, so the way
 * forward kept disappearing up the chat history. A persistent reply keyboard
 * stays pinned above the input, and the placeholder tells people the fastest
 * route is simply typing what they want.
 */
export const NAV = {
  list: '🔔 My list',
  check: '⚡ Check now',
  browse: '🗂 Browse all',
  area: '📍 Change area'
}

export const mainKeyboard = () => ({
  keyboard: [
    [{ text: NAV.list }, { text: NAV.check }],
    [{ text: NAV.browse }, { text: NAV.area }]
  ],
  resize_keyboard: true,
  is_persistent: true,
  input_field_placeholder: 'Type a product, e.g. whey'
})

/** Redraw the message a button was tapped on, or send a new one for a typed command. */
export const show = (env, chatId, messageId, text, extra) =>
  messageId ? edit(env, chatId, messageId, text, extra) : send(env, chatId, text, extra)

/**
 * Products, grouped into families.
 *
 * A Telegram button cannot hold "Amul Chocolate Whey Protein, 34 g | Pack of
 * 60 sachets", and every attempt to squeeze it in — cutting the tail, then
 * cutting the middle — produced labels nobody could read. So the choice is
 * split in two: this screen names the products, the next names the sizes.
 * Nothing is ever truncated into nonsense because nothing needs to be.
 */
export function familyRows(products, trackedSet, ctx) {
  const groups = groupFamilies(products)
  const names = [...groups.keys()]
  const prefix = commonPrefix(names)

  const rows = [...groups.entries()].map(([family, items]) => {
    const short = family.split(' ').slice(prefix.length).join(' ') || family
    const stocked = items.filter(isInStock).length
    const watching = items.filter((i) => trackedSet.has(i.sku)).length
    const mark = watching ? '🔔' : stocked ? '✅' : '▫️'

    // The product name must survive intact; the trailing note is the part we
    // can afford to lose, so drop it rather than cut into the name.
    const label = (note) => {
      const full = `${mark} ${short} · ${note}`
      return full.length <= BUTTON_WIDTH ? full : fitEnd(`${mark} ${short}`)
    }

    // A family with one size has nothing to drill into — toggle it right here.
    if (items.length === 1) {
      const p = items[0]
      return [
        {
          text: label(`₹${p.price}`),
          callback_data: `${trackedSet.has(p.sku) ? 'u' : 't'}:${p.sku}:${ctx}`
        }
      ]
    }

    return [
      {
        text: label(stocked ? `${items.length} sizes · ${stocked} in stock` : `${items.length} sizes`),
        callback_data: `f:${items[0].sku}:${ctx}`
      }
    ]
  })

  return { rows, heading: prefix.join(' ') }
}

/** One family's sizes. Short labels, because the family name is in the header. */
export function variantRows(items, trackedSet, ctx) {
  const { common, rest } = factorCommon(items.map((p) => splitFamily(p.name).variant))
  const rows = items.map((p, i) => {
    const mark = trackedSet.has(p.sku) ? '🔔' : isInStock(p) ? '✅' : '▫️'
    const qty = inventoryQuantity(p)
    const tail = isInStock(p) && qty > 0 && qty < 20 ? ` · ${qty} left` : ''
    return [
      {
        text: fitEnd(`${mark} ${rest[i] || 'Standard'} · ₹${p.price}${tail}`),
        callback_data: `${trackedSet.has(p.sku) ? 'u' : 't'}:${p.sku}:${ctx}`
      }
    ]
  })
  return { rows, common }
}
