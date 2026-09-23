import {
  openSession,
  isInStock,
  inventoryQuantity,
  productUrl,
  labelForCategory,
  AmulError
} from './amul.js'
import * as db from './db.js'
import { send, edit, answerCallback, keyboard, esc } from './telegram.js'
import { restockMessage, buyButtons } from './alert.js'
import {
  normalizeName,
  labelsFor,
  commonPrefix,
  fit,
  fitEnd,
  matchesQuery,
  splitFamily,
  groupFamilies,
  factorCommon
} from './format.js'

const PAGE = 12

// What a phone actually renders on an inline button before it clips.
const BUTTON_WIDTH = 34

export const COMMANDS = [
  { command: 'start', description: 'Start the bot' },
  { command: 'search', description: 'Find a product by name' },
  { command: 'products', description: 'Browse everything' },
  { command: 'tracked', description: 'Show everything you are watching' },
  { command: 'check', description: 'Check stock right now' },
  { command: 'setpincode', description: 'Set your delivery area' },
  { command: 'pause', description: 'Pause alerts without losing your list' },
  { command: 'resume', description: 'Resume alerts' },
  { command: 'help', description: 'How this bot works' }
]

const isAdmin = (env, chatId) => String(env.ADMIN_CHAT_ID ?? '') === String(chatId)
/** Categories, counted straight off whatever the store returned this minute. */
function deriveCategories(products) {
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

/**
 * Always-visible navigation.
 *
 * Inline buttons scroll away with the message that carried them, so the way
 * forward kept disappearing up the chat history. A persistent reply keyboard
 * stays pinned above the input, and the placeholder tells people the fastest
 * route is simply typing what they want.
 */
const NAV = {
  list: '🔔 My list',
  check: '⚡ Check now',
  browse: '🗂 Browse all',
  area: '📍 Change area'
}

const mainKeyboard = () => ({
  keyboard: [
    [{ text: NAV.list }, { text: NAV.check }],
    [{ text: NAV.browse }, { text: NAV.area }]
  ],
  resize_keyboard: true,
  is_persistent: true,
  input_field_placeholder: 'Type a product, e.g. whey'
})

/**
 * The catalogue for this user's substore, cached.
 *
 * A live fetch is ~2.5s. Doing that inline on a button tap — twice, once to
 * resolve the product and once to redraw — meant a tap took five seconds and
 * Telegram gave up on the callback long before it finished, so taps looked
 * like they did nothing. The cron sweep refreshes this every two minutes, so
 * taps almost always hit the cache.
 */
async function loadProducts(env, user, categoryIds) {
  let products = await db.getCatalog(env, user.substore)

  if (!products) {
    products = await (await openSession(user.substore)).products()
    await db.putCatalog(env, user.substore, products)
  }

  return categoryIds?.length
    ? products.filter((p) => (p.categories ?? []).some((c) => categoryIds.includes(c)))
    : products
}

/**
 * Products, grouped into families.
 *
 * A Telegram button cannot hold "Amul Chocolate Whey Protein, 34 g | Pack of
 * 60 sachets", and every attempt to squeeze it in — cutting the tail, then
 * cutting the middle — produced labels nobody could read. So the choice is
 * split in two: this screen names the products, the next names the sizes.
 * Nothing is ever truncated into nonsense because nothing needs to be.
 */
function familyRows(products, trackedSet, ctx) {
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
function variantRows(items, trackedSet, ctx) {
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

const legend = '✅ available now · ▫️ sold out · 🔔 you are watching it'

// ---------------------------------------------------------------- pincode

async function askPincode(env, chatId) {
  return send(
    env,
    chatId,
    [
      '📍 <b>Which area should I check?</b>',
      '',
      'Amul stocks different things in different regions.',
      '',
      'Type your <b>6-digit pincode</b>, or tap the button to share your location.'
    ].join('\n'),
    {
      reply_markup: {
        keyboard: [[{ text: '📍 Share my location', request_location: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
        input_field_placeholder: 'e.g. 380015'
      }
    }
  )
}

async function pincodeFromLocation(lat, lon) {
  const res = await fetch(
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=18&addressdetails=1`,
    { headers: { 'user-agent': 'amul-watch/1.0 (personal Amul restock notifier)', 'accept-language': 'en' } }
  )
  if (!res.ok) return null
  const postcode = (await res.json())?.address?.postcode?.replace(/\s+/g, '')
  return /^\d{6}$/.test(postcode ?? '') ? postcode : null
}

async function requirePincode(env, chatId, user) {
  if (user?.substore) return true
  await askPincode(env, chatId)
  return false
}

async function cmdSetPincode(env, chatId, args) {
  const pincode = (args ?? '').trim()
  if (!pincode) return askPincode(env, chatId)
  if (!/^\d{6}$/.test(pincode)) {
    return send(env, chatId, `❌ <b>${esc(pincode)}</b> is not a 6-digit pincode.`)
  }

  try {
    const record = await (await openSession()).lookupPincode(pincode)
    await db.setPincode(env, chatId, pincode, record.substore)
    return send(
      env,
      chatId,
      [
        `✅ Set to <b>${esc(pincode)}</b> · ${esc(record.substore)} store.`,
        '',
        '<b>Now just type what you want.</b>',
        'For example <code>whey</code>, <code>lassi</code> or <code>paneer</code>.'
      ].join('\n'),
      { reply_markup: mainKeyboard() }
    )
  } catch (err) {
    if (err instanceof AmulError && err.code === 'PINCODE_NOT_FOUND') {
      return send(env, chatId, `❌ Amul does not deliver to <b>${esc(pincode)}</b>. Try a nearby pincode.`)
    }
    throw err
  }
}

// ---------------------------------------------------------------- screens

async function cmdStart(env, chatId, user) {
  const tracks = await db.listTracks(env, chatId)
  if (!user.substore) {
    await send(env, chatId, '👋 <b>Amul Stock Watcher</b>\n\nI message you the moment a product you want is back in stock.')
    return askPincode(env, chatId)
  }

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

async function cmdHelp(env, chatId) {
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
      '<i>Unofficial. Not affiliated with Amul.</i>'
    ].join('\n'),
    { reply_markup: mainKeyboard() }
  )
}

/** Search results — the main way in. */
async function showSearch(env, chatId, messageId, user, query, offset = 0) {
  const q = query.trim()
  const all = await loadProducts(env, user)
  const hits = all
    .filter((p) => matchesQuery(p, q))
    .sort((a, b) => Number(isInStock(b)) - Number(isInStock(a)))

  if (!hits.length) {
    return send(
      env,
      chatId,
      [`🔍 Nothing matches <b>${esc(q)}</b>.`, '', 'Try a shorter word, or tap <b>Browse all</b>.'].join('\n'),
      { reply_markup: mainKeyboard() }
    )
  }

  const trackedSet = new Set((await db.listTracks(env, chatId)).map((t) => t.sku))

  // One product with several sizes? Skip the middle step entirely.
  const families = groupFamilies(hits)
  if (families.size === 1) {
    return showFamily(env, chatId, messageId, user, hits[0].sku, `q:${q.slice(0, 24)}`)
  }

  const page = hits.slice(offset, offset + PAGE)
  const stocked = hits.filter(isInStock).length
  const ctx = `q:${q.slice(0, 24)}`
  const { rows, heading } = familyRows(page, trackedSet, ctx)

  const text = [
    `🔍 <b>${esc(q)}</b> — ${families.size} product${families.size === 1 ? '' : 's'}, ${stocked} in stock`,
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

  return messageId ? edit(env, chatId, messageId, text, keyboard(rows)) : send(env, chatId, text, keyboard(rows))
}

/** Every size of one product, with the product named in the header. */
async function showFamily(env, chatId, messageId, user, anchorSku, ctx) {
  const all = await loadProducts(env, user)
  const anchor = all.find((p) => p.sku === anchorSku)
  if (!anchor) return send(env, chatId, 'That product is no longer listed.')

  const { family } = splitFamily(anchor.name)
  const items = all.filter((p) => splitFamily(p.name).family === family)
  const trackedSet = new Set((await db.listTracks(env, chatId)).map((t) => t.sku))
  const stocked = items.filter(isInStock).length

  const { rows, common } = variantRows(items, trackedSet, `f:${anchorSku}:${ctx}`)

  const text = [
    `<b>${esc(family)}</b>${common ? ` · ${esc(common)}` : ''}`,
    `📍 ${esc(user.pincode)} · ${stocked} of ${items.length} in stock`,
    '',
    legend,
    '',
    'Tap a size to start or stop watching it.'
  ].join('\n')

  const untracked = items.filter((p) => !trackedSet.has(p.sku))
  if (untracked.length > 1) {
    rows.push([{ text: `🔔 Watch all ${untracked.length} sizes`, callback_data: `A:${anchorSku}:${ctx}` }])
  }
  rows.push([{ text: '‹ Back', callback_data: ctx.startsWith('q:') ? `s:0:${ctx.slice(2)}` : `${ctx}` }, { text: `🔔 My list (${trackedSet.size})`, callback_data: 'tracked' }])

  return messageId ? edit(env, chatId, messageId, text, keyboard(rows)) : send(env, chatId, text, keyboard(rows))
}

async function showCategories(env, chatId, messageId, user) {
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

  return messageId ? edit(env, chatId, messageId, text, keyboard(rows)) : send(env, chatId, text, keyboard(rows))
}

async function showCategory(env, chatId, messageId, user, catId, offset) {
  const products = (await loadProducts(env, user, [catId])).sort(
    (a, b) => Number(isInStock(b)) - Number(isInStock(a))
  )
  if (!products.length) return send(env, chatId, 'Nothing in that category right now.')
  const category = { label: labelForCategory(catId) }
  const trackedSet = new Set((await db.listTracks(env, chatId)).map((t) => t.sku))
  const page = products.slice(offset, offset + PAGE)

  const stocked = products.filter(isInStock).length
  const { rows, heading } = familyRows(page, trackedSet, `c:${catId}:${offset}`)

  const text = [
    `<b>${esc(category.label)}</b> · ${esc(user.pincode)}`,
    `${stocked} of ${products.length} in stock`,
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

  return messageId ? edit(env, chatId, messageId, text, keyboard(rows)) : send(env, chatId, text, keyboard(rows))
}

async function cmdTracked(env, chatId, messageId, user) {
  const tracks = await db.listTracks(env, chatId)
  if (!tracks.length) {
    const text = ['🔔 <b>Your list is empty</b>', '', 'Type what you want — <code>whey</code>, <code>lassi</code>, <code>paneer</code> — then tap it.'].join('\n')
    return messageId ? edit(env, chatId, messageId, text, keyboard([[{ text: '🗂 Browse all', callback_data: 'cats' }]])) : send(env, chatId, text, { reply_markup: mainKeyboard() })
  }

  let live = []
  try {
    const wanted = new Set(tracks.map((t) => t.sku))
    live = (await loadProducts(env, user)).filter((p) => wanted.has(p.sku))
  } catch {
    /* fall back to stored names below */
  }

  const bySku = new Map(live.map((p) => [p.sku, p]))
  const items = tracks.map((t) => bySku.get(t.sku) ?? { sku: t.sku, name: t.name, price: '', available: 0, inventory_quantity: 0, inventory_low_stock_quantity: 0 })
  const trackedSet = new Set(tracks.map((t) => t.sku))
  const stocked = items.filter(isInStock).length

  const text = [`🔔 <b>Watching ${tracks.length} item${tracks.length === 1 ? '' : 's'}</b>`, stocked ? `✅ ${stocked} available right now` : 'None available right now — I am watching.', '', 'Tap one to stop watching it.'].join('\n')

  const rows = items.map((p) => {
    const { family, variant } = splitFamily(p.name)
    const mark = isInStock(p) ? '✅' : '▫️'
    return [
      {
        text: fitEnd(`${mark} ${family}${variant ? ` · ${variant}` : ''}`),
        callback_data: `u:${p.sku}:l`
      }
    ]
  })
  rows.push([{ text: '⚡ Check now', callback_data: 'check' }, { text: '🗂 Browse all', callback_data: 'cats' }])
  return messageId ? edit(env, chatId, messageId, text, keyboard(rows)) : send(env, chatId, text, keyboard(rows))
}

async function cmdCheck(env, chatId, user) {
  const tracks = await db.listTracks(env, chatId)
  if (!tracks.length) return send(env, chatId, 'Nothing on your list yet — type what you want, like <code>whey</code>.', { reply_markup: mainKeyboard() })

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

// ---------------------------------------------------------------- routing

async function handleCommand(env, msg, user) {
  const chatId = msg.chat.id
  const [raw, ...rest] = msg.text.trim().split(/\s+/)
  const command = raw.split('@')[0].slice(1).toLowerCase()
  const args = rest.join(' ')

  switch (command) {
    case 'start': return cmdStart(env, chatId, user)
    case 'help': return cmdHelp(env, chatId)
    case 'setpincode': return cmdSetPincode(env, chatId, args)
    case 'pincode':
      return send(env, chatId, user.substore ? `📍 <b>${esc(user.pincode)}</b> · ${esc(user.substore)} store` : 'No area set yet.', { reply_markup: mainKeyboard() })
    case 'search':
      if (!(await requirePincode(env, chatId, user))) return
      if (!args) return send(env, chatId, 'Type what you are looking for, like <code>whey</code>.', { reply_markup: mainKeyboard() })
      return showSearch(env, chatId, null, user, args)
    case 'products':
      if (!(await requirePincode(env, chatId, user))) return
      return showCategories(env, chatId, null, user)
    case 'tracked': return cmdTracked(env, chatId, null, user)
    case 'check':
      if (!(await requirePincode(env, chatId, user))) return
      return cmdCheck(env, chatId, user)
    case 'pause':
      await db.setPaused(env, chatId, true)
      return send(env, chatId, '⏸ Alerts paused. Your list is untouched.', { reply_markup: mainKeyboard() })
    case 'resume':
      await db.setPaused(env, chatId, false)
      return send(env, chatId, '▶️ Alerts back on.', { reply_markup: mainKeyboard() })
    case 'whoami': return send(env, chatId, `Your Telegram chat ID is <code>${chatId}</code>`)

    case 'testalert': {
      if (!(await requirePincode(env, chatId, user))) return
      const products = await loadProducts(env, user)

      // Prefer something the user actually watches, so the test reflects the
      // alert they will really get. Fall back to anything in stock.
      const watched = new Set((await db.listTracks(env, chatId)).map((t) => t.sku))
      const mine = products.filter((p) => watched.has(p.sku) && isInStock(p))
      const sample = (mine.length ? mine : products.filter(isInStock)).slice(0, 2)

      if (!sample.length) {
        return send(env, chatId, 'Nothing is in stock in your area right now, so there is no real product to demo with.')
      }

      return send(env, chatId, restockMessage(sample, { test: true }), buyButtons(sample))
    }
    case 'stats': {
      if (!isAdmin(env, chatId)) return
      const s = await db.stats(env)
      return send(env, chatId, `👥 Users: <b>${s.users}</b>\n🔔 Tracks: <b>${s.tracks}</b>\n🏬 Substores: <b>${s.substores}</b>\n🔐 Mode: <b>${esc(env.ACCESS_MODE ?? 'allowlist')}</b>`)
    }
    case 'allow': case 'disallow': {
      if (!isAdmin(env, chatId)) return
      const id = Number(args.trim())
      if (!id) return send(env, chatId, `Usage: <code>/${command} 123456789</code>`)
      await (command === 'allow' ? db.allow(env, id) : db.disallow(env, id))
      return send(env, chatId, `${command === 'allow' ? '✅ Allowed' : '🚫 Removed'} <code>${id}</code>`)
    }
    default: return send(env, chatId, "I don't know that one — /help explains everything.", { reply_markup: mainKeyboard() })
  }
}

/** Redraw whichever screen the tap came from, so context is never lost. */
async function redraw(env, chatId, messageId, user, ctx) {
  const [kind, a, b] = ctx.split(':')
  if (kind === 'f') return showFamily(env, chatId, messageId, user, a, ctx.split(':').slice(2).join(':'))
  if (kind === 'q') return showSearch(env, chatId, messageId, user, a ?? '', 0)
  if (kind === 'c') return showCategory(env, chatId, messageId, user, a, Number(b) || 0)
  return cmdTracked(env, chatId, messageId, user)
}

/**
 * Callback formats used by earlier versions of this bot.
 *
 * Messages already sitting in a chat keep whatever buttons they were sent
 * with, so a deploy that renames callbacks silently breaks every menu still on
 * screen: the tap is answered, nothing happens, and the button appears dead.
 * Old names are mapped forward rather than dropped.
 */
const LEGACY_ACTIONS = {
  trk: 't',
  untrk: 'u',
  track: 't',
  untrack: 'u',
  cat: 'c',
  picks: 'cats',
  pick: 'cats'
  // 'trkall' is deliberately absent: its payload was a category id, but the
  // current bulk-watch action keys off an anchor SKU. Mapping it would look
  // like it worked and quietly track nothing, so it self-heals instead.
}

async function handleCallback(env, cq, user) {
  const chatId = cq.message.chat.id
  const messageId = cq.message.message_id
  const data = cq.data ?? ''
  const [rawAction, ...parts] = data.split(':')
  const action = LEGACY_ACTIONS[rawAction] ?? rawAction

  switch (action) {
    case 'tracked':
      await answerCallback(env, cq.id)
      return cmdTracked(env, chatId, messageId, user)
    case 'check':
      await answerCallback(env, cq.id, 'Checking…')
      return cmdCheck(env, chatId, user)
    case 'cats':
      await answerCallback(env, cq.id, 'Loading…')
      if (!(await requirePincode(env, chatId, user))) return
      return showCategories(env, chatId, messageId, user)
    case 'c':
      await answerCallback(env, cq.id)
      return showCategory(env, chatId, messageId, user, parts[0], Number(parts[1]) || 0)
    case 's':
      await answerCallback(env, cq.id)
      return showSearch(env, chatId, messageId, user, parts.slice(1).join(':'), Number(parts[0]) || 0)
    case 'f':
      await answerCallback(env, cq.id)
      return showFamily(env, chatId, messageId, user, parts[0], parts.slice(1).join(':'))
    case 'A': {
      const all = await loadProducts(env, user)
      const anchor = all.find((p) => p.sku === parts[0])
      const family = anchor ? splitFamily(anchor.name).family : null
      const have = new Set((await db.listTracks(env, chatId)).map((t) => t.sku))
      let added = 0
      for (const p of all.filter((x) => splitFamily(x.name).family === family)) {
        if (!have.has(p.sku)) {
          await db.addTrack(env, chatId, p.sku, p.name)
          added++
        }
      }
      await answerCallback(env, cq.id, `🔔 Watching ${added} more`)
      return showFamily(env, chatId, messageId, user, parts[0], parts.slice(1).join(':'))
    }
    case 't': case 'u': {
      const sku = parts[0]
      const ctx = parts.slice(1).join(':')

      // Clear the spinner before doing anything slow. Telegram abandons a
      // callback after a few seconds, and an unanswered tap looks like a
      // broken button, which invites the frustrated re-tapping this caused.
      await answerCallback(env, cq.id, action === 't' ? '🔔 Added' : 'Removed')

      if (action === 't') {
        const product = (await loadProducts(env, user)).find((p) => p.sku === sku)
        await db.addTrack(env, chatId, sku, product?.name ?? sku)
      } else {
        await db.removeTrack(env, chatId, sku)
      }
      return redraw(env, chatId, messageId, user, ctx)
    }
    case 'home':
      await answerCallback(env, cq.id)
      return cmdStart(env, chatId, user)

    default: {
      // An unrecognised tap means this menu predates a format change. Say so
      // and hand over a working one instead of leaving a dead button.
      await answerCallback(env, cq.id, 'This menu is out of date — opening a fresh one', true)
      return user.substore
        ? showCategories(env, chatId, null, user)
        : askPincode(env, chatId)
    }
  }
}

export async function handleUpdate(env, update) {
  const msg = update.message ?? update.edited_message
  const cq = update.callback_query
  const from = msg?.from ?? cq?.from
  const chat = msg?.chat ?? cq?.message?.chat
  if (!from || !chat || chat.type !== 'private') return

  const chatId = chat.id
  if (!(await db.isAllowed(env, chatId))) {
    await send(env, chatId, `🔒 This bot is invite-only.\n\nYour Telegram ID is <code>${chatId}</code> — ask the owner to add you.`).catch(() => {})
    return
  }

  const user = await db.upsertUser(env, from)

  try {
    if (cq) return await handleCallback(env, cq, user)

    if (msg?.location) {
      const found = await pincodeFromLocation(msg.location.latitude, msg.location.longitude)
      return found
        ? await cmdSetPincode(env, chatId, found)
        : await send(env, chatId, "I couldn't read a pincode from that. Please type your 6 digits.")
    }

    const text = msg?.text?.trim()
    if (!text) return

    if (text.startsWith('/')) return await handleCommand(env, msg, user)
    if (/^\d{6}$/.test(text)) return await cmdSetPincode(env, chatId, text)

    // Persistent keyboard taps arrive as ordinary text.
    if (text === NAV.list) return await cmdTracked(env, chatId, null, user)
    if (text === NAV.area) return await askPincode(env, chatId)
    if (!(await requirePincode(env, chatId, user))) return
    if (text === NAV.check) return await cmdCheck(env, chatId, user)
    if (text === NAV.browse) return await showCategories(env, chatId, null, user)

    // Anything else is a product search. This is the fast path.
    return await showSearch(env, chatId, null, user, text)
  } catch (err) {
    console.error('handleUpdate failed:', err?.stack ?? err)
    await send(
      env,
      chatId,
      err instanceof AmulError ? '⚠️ Amul is not responding right now. Try again in a minute.' : '⚠️ Something went wrong on my side.'
    ).catch(() => {})
  }
}
