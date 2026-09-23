/**
 * The restock alert.
 *
 * Lives here rather than in the worker so the /testalert command and the real
 * cron sweep render through exactly the same code. A test alert that merely
 * resembled the real one would be worth very little.
 */
import { inventoryQuantity, productUrl } from './amul.js'
import { esc, keyboard } from './telegram.js'

export function restockMessage(items, { test = false } = {}) {
  const lines = [
    test ? '🧪 <b>TEST ALERT</b> — this is what a restock looks like' : '',
    test ? '' : '',
    items.length === 1
      ? '🔔 <b>Back in stock!</b>'
      : `🔔 <b>${items.length} items back in stock!</b>`,
    ''
  ].filter((line, i) => !(i < 2 && !line))

  for (const p of items) {
    const qty = inventoryQuantity(p)
    lines.push(
      `<b>${esc(p.name)}</b>`,
      `₹${esc(p.price)}${qty > 0 ? ` · ${qty} available` : ''}`,
      `<a href="${productUrl(p)}">Buy now →</a>`,
      ''
    )
  }

  lines.push(
    test
      ? '<i>No action needed — your real alerts look exactly like this.</i>'
      : '<i>Amul stock goes fast — do not wait.</i>'
  )
  return lines.join('\n')
}

export function buyButtons(items) {
  return keyboard(
    items.slice(0, 5).map((p) => [
      {
        text: `🛒 ${p.name.length > 32 ? `${p.name.slice(0, 31)}…` : p.name}`,
        url: productUrl(p)
      }
    ])
  )
}
