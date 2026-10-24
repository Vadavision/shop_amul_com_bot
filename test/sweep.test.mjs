/**
 * The restock sweep, against live Amul stock.
 *
 * Nothing about Amul is faked. Instead the bot's memory is seeded with the
 * opposite of reality: a product that is in stock right now is remembered as
 * sold out, and one that is sold out is remembered as in stock. The next sweep
 * must therefore see one restock (alert + log) and one sell-out (log only).
 */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { createEnv, telegram, sentTo } from './support.mjs'
import { openSession, isInStock } from '../src/amul.js'
import { runSweeps, runCheck } from '../src/sweep.js'
import { parseJsessionid } from '../src/cart.js'
import { nextHealth, FRESH_HEALTH } from '../src/health.js'
import * as db from '../src/db.js'
import { handleUpdate } from '../src/bot/index.js'

const USER = 1000001
const ADMIN = 2000002
const SUBSTORE = 'punjab'
const { env, sqlite } = createEnv({ SWEEPS_PER_RUN: '1', ADMIN_CHAT_ID: String(ADMIN) })

let inStock, soldOut

const events = () => sqlite.prepare('SELECT sku, in_stock FROM stock_events ORDER BY id').all().map((r) => ({ ...r }))
const snapshot = () => JSON.parse(sqlite.prepare('SELECT data FROM snapshots WHERE substore = ?').get(SUBSTORE).data)
const setMeta = (key, value, updatedAt) =>
  sqlite
    .prepare('INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(key, String(value), updatedAt)

before(async () => {
  const live = await (await openSession(SUBSTORE)).products()
  inStock = live.find(isInStock)
  soldOut = live.find((p) => !isInStock(p))
  assert.ok(inStock && soldOut, 'Punjab has at least one product in stock and one sold out to test with')

  const now = Date.now()
  sqlite.prepare(`INSERT INTO users (chat_id, first_name, pincode, substore, created_at, updated_at) VALUES (?, 'Test', '143505', ?, ?, ?)`).run(USER, SUBSTORE, now, now)
  for (const p of [inStock, soldOut]) {
    sqlite.prepare('INSERT INTO tracks (chat_id, sku, name, created_at) VALUES (?, ?, ?, ?)').run(USER, p.sku, p.name, now)
  }
  sqlite.prepare('INSERT INTO snapshots (substore, data, updated_at) VALUES (?, ?, ?)').run(
    SUBSTORE,
    JSON.stringify({ [inStock.sku]: 0, [soldOut.sku]: 1 }),
    now
  )
  setMeta('store_version', 6, now)
  setMeta('last_catalog_ok', 1, now)
  // The previous successful sweep finished 10 minutes ago: an outage.
  setMeta('last_sweep_ok', 1800, now - 10 * 60 * 1000)
})

test('a sweep alerts on the restock, logs both changes, and reports the outage', async () => {
  telegram.length = 0
  const run = await runSweeps(env)

  assert.deepEqual(run.errors, [])
  assert.equal(run.alerts, 1, 'one restock alert')
  assert.equal(run.changes, 2, 'both changes counted')

  assert.equal(sentTo(USER).length, 1)
  assert.match(sentTo(USER)[0].body.text, /Back in stock/)

  assert.equal(sentTo(ADMIN).length, 1, 'the admin hears about the 10-minute gap')
  assert.match(sentTo(ADMIN)[0].body.text, /Stock checks were down/)

  assert.deepEqual(events(), [
    { sku: inStock.sku, in_stock: 1 },
    { sku: soldOut.sku, in_stock: 0 }
  ])
  assert.deepEqual(snapshot(), { [inStock.sku]: 1, [soldOut.sku]: 0 }, 'memory now matches reality')
})

test('the next sweep finds nothing new and stays quiet', async () => {
  telegram.length = 0
  const run = await runSweeps(env)

  assert.equal(run.alerts, 0)
  assert.equal(run.changes, 0)
  assert.equal(run.gap, undefined, 'no outage: the previous sweep just finished')
  assert.equal(telegram.length, 0, 'no messages at all')
  assert.equal(events().length, 2, 'nothing new logged')
})

test('/history shows what the log recorded', async () => {
  telegram.length = 0
  await handleUpdate(env, {
    update_id: 1,
    message: { message_id: 1, from: { id: USER, is_bot: false, first_name: 'Test' }, chat: { id: USER, type: 'private' }, date: 0, text: '/history' }
  })
  const text = sentTo(USER)[0].body.text
  assert.match(text, /In stock · \d+ units/, 'the restock is listed with its quantity')
  assert.match(text, /Sold out/, 'the sell-out is listed')
  assert.match(text, /Recorded since/, 'says how far back the record goes')
})

test('a catalogue refresh is logged the same way', async () => {
  // Remember the sold-out product as in stock again, and make the catalogue due.
  sqlite.prepare('UPDATE snapshots SET data = ? WHERE substore = ?').run(
    JSON.stringify({ [inStock.sku]: 1, [soldOut.sku]: 1 }),
    SUBSTORE
  )
  setMeta('last_catalog_ok', 1, Date.now() - 2 * 60 * 60 * 1000)

  const run = await runSweeps(env)

  assert.equal(run.catalog, true, 'this firing refreshed the catalogue')
  assert.ok(sqlite.prepare('SELECT 1 FROM catalog WHERE substore = ?').get(SUBSTORE), 'catalogue cached')
  assert.deepEqual(events().at(-1), { sku: soldOut.sku, in_stock: 0 })
})

test('missing SWEEPS_PER_RUN fails loudly instead of defaulting', async () => {
  const { env: unset } = createEnv({})
  await assert.rejects(runSweeps(unset), /SWEEPS_PER_RUN must be an integer/)
})

test('a check reuses the saved Amul session instead of opening a new one', async () => {
  const saved = sqlite.prepare("SELECT value FROM meta WHERE key = 'amul_session:punjab'").get()
  assert.ok(saved, 'the first sweep saved its session')

  const amulCalls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('shop.amul.com')) amulCalls.push(new URL(url).pathname)
    return realFetch(url, options)
  }
  try {
    const state = await db.loadState(env)
    await runCheck(env, state)
  } finally {
    globalThis.fetch = realFetch
  }
  assert.deepEqual(amulCalls, ['/api/1/entity/ms.products'], 'one request: no info.js, no setPreferences')
})

test('a saved session that stopped working is replaced, not reported as a failure', async () => {
  sqlite
    .prepare("UPDATE meta SET value = json_set(value, '$.tid', 'stale') WHERE key = 'amul_session:punjab'")
    .run()
  const run = await runCheck(env, await db.loadState(env))
  assert.deepEqual(run.failed, [])
  assert.ok(run.checked > 0, 'still got stock')
})

test('repeated Amul failures alert the admin once, then announce recovery', async () => {
  const { env: down, sqlite: dbDown } = createEnv({ SWEEPS_PER_RUN: '1', ADMIN_CHAT_ID: String(ADMIN) })
  const now = Date.now()
  dbDown.prepare(`INSERT INTO users (chat_id, first_name, pincode, substore, created_at, updated_at) VALUES (?, 'T', '143505', 'punjab', ?, ?)`).run(USER, now, now)
  dbDown.prepare('INSERT INTO tracks (chat_id, sku, name, created_at) VALUES (?, ?, ?, ?)').run(USER, 'WPCCP02_01', 'whey', now)
  dbDown.prepare("INSERT INTO meta (key, value, updated_at) VALUES ('last_catalog_ok', '1', ?)").run(now)

  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, options) =>
    String(url).includes('shop.amul.com') ? new Response('bad gateway', { status: 504 }) : realFetch(url, options)
  try {
    telegram.length = 0
    for (let i = 1; i <= 4; i++) {
      const run = await runSweeps(down)
      assert.equal(run.failedChecks, i)
      assert.match(run.errors[0], /punjab: .*504/, 'the cause is reported')
    }
    assert.equal(sentTo(ADMIN).length, 0, 'four failures in a row is still just noise')

    await runSweeps(down)
    assert.equal(sentTo(ADMIN).length, 1, 'the fifth raises the alarm')
    assert.match(sentTo(ADMIN)[0].body.text, /Stock checks are failing/)
    assert.match(sentTo(ADMIN)[0].body.text, /504/)

    await runSweeps(down)
    assert.equal(sentTo(ADMIN).length, 1, 'and does not repeat every minute')
  } finally {
    globalThis.fetch = realFetch
  }

  const run = await runSweeps(down)
  assert.deepEqual(run.errors, [], 'Amul is back')
  assert.equal(sentTo(ADMIN).length, 2)
  assert.match(sentTo(ADMIN)[1].body.text, /recovered/)
  assert.equal(JSON.parse(dbDown.prepare("SELECT value FROM meta WHERE key = 'check_health'").get().value).failures, 0)
})

test('health streak: a lone failure is silent and a clean run resets it', () => {
  const now = Date.now()
  const one = nextHealth(FRESH_HEALTH, [{ substore: 'punjab', error: 'HTTP 504' }], now)
  assert.equal(one.notify, null)
  const clear = nextHealth(one.state, [], now + 60000)
  assert.equal(clear.notify, null, 'no alert was sent, so no recovery either')
  assert.equal(clear.state.failures, 0)
})

// --- auto cart --------------------------------------------------------------
// Stock is live Amul. What is faked is the owner's account: the sign-in and the
// cart write, so a test run never touches anyone's real cart.

const LOGIN = 's%3Atest' + 'x'.repeat(40)

/** Stands in for the owner's logged-in Amul session. */
async function fakeAccount({ signedIn = true, cart = () => Response.json({ cart: { _id: 'acct1', email_id: 'o@example.com', items: [{ sku: inStock.sku, quantity: 1 }] } }) } = {}) {
  // A real Punjab-bound session supplies stock, standing in for the account's store.
  const real = await openSession(SUBSTORE)
  const realCookie = [...real.jar].map(([k, v]) => `${k}=${v}`).join('; ')
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url)
    const asOwner = String(options.headers?.cookie ?? '').includes(`jsessionid=${LOGIN}`)
    // Only the owner's cookie is answered here; the bot's ordinary guest sessions reach real Amul.
    if (asOwner && href.includes('/user/info.js')) {
      const data = signedIn ? { isLoggedIn: true, first_name: 'Pankil', store: 'punjab', cart_id: 'acct1' } : { isBot: false }
      return new Response('session = ' + JSON.stringify({ data, tid: real.tid }))
    }
    if (href.includes('/entity/ms.carts/')) {
      calls.push({ url: href, body: JSON.parse(options.body) })
      return cart(calls)
    }
    if (asOwner && href.includes('/entity/ms.products')) {
      return realFetch(url, { ...options, headers: { ...options.headers, cookie: realCookie } })
    }
    return realFetch(url, options)
  }
  return { calls, restore: () => { globalThis.fetch = realFetch } }
}

/** The owner (ADMIN) watching a product that is remembered as sold out. */
function cartScenario({ login = { jsessionid: LOGIN, savedAt: Date.now(), checkedAt: Date.now() }, autoCart = '1', watcher = ADMIN } = {}) {
  const { env: cartEnv, sqlite: db2 } = createEnv({ SWEEPS_PER_RUN: '1', ADMIN_CHAT_ID: String(ADMIN), AUTO_CART: autoCart })
  const now = Date.now()
  db2.prepare(`INSERT INTO users (chat_id, first_name, pincode, substore, created_at, updated_at) VALUES (?, 'T', '143505', ?, ?, ?)`).run(watcher, SUBSTORE, now, now)
  db2.prepare('INSERT INTO tracks (chat_id, sku, name, created_at) VALUES (?, ?, ?, ?)').run(watcher, inStock.sku, inStock.name, now)
  db2.prepare('INSERT INTO snapshots (substore, data, updated_at) VALUES (?, ?, ?)').run(SUBSTORE, JSON.stringify({ [inStock.sku]: 0 }), now)
  db2.prepare("INSERT INTO meta (key, value, updated_at) VALUES ('last_catalog_ok', '1', ?)").run(now)
  if (login) db2.prepare("INSERT INTO meta (key, value, updated_at) VALUES ('amul_login', ?, ?)").run(JSON.stringify(login), now)
  telegram.length = 0
  return { cartEnv, db2 }
}

const edits = () => telegram.filter((c) => c.method === 'editMessageReplyMarkup')
const jobs = (db2) => JSON.parse(db2.prepare("SELECT value FROM meta WHERE key = 'cart_jobs'").get().value)

test('parseJsessionid takes a whole Cookie header, a pair, or the bare value', () => {
  assert.equal(parseJsessionid(`_ga=GA1.1.2; jsessionid=${LOGIN}; _cfuvid=abc`), LOGIN)
  assert.equal(parseJsessionid(`jsessionid=${LOGIN}`), LOGIN)
  assert.equal(parseJsessionid(LOGIN), LOGIN)
  assert.equal(parseJsessionid('hello there'), null)
  assert.equal(parseJsessionid(''), null)
})

test('/amullogin checks the cookie, saves it, and deletes the message that held it', async () => {
  const { env: e, sqlite: db2 } = createEnv({ SWEEPS_PER_RUN: '1', ADMIN_CHAT_ID: String(ADMIN), AUTO_CART: '1' })
  const account = await fakeAccount()
  const say = (text, id) => handleUpdate(e, { update_id: id, message: { message_id: id, from: { id: ADMIN, is_bot: false, first_name: 'Owner' }, chat: { id: ADMIN, type: 'private' }, date: 0, text } })
  try {
    telegram.length = 0
    await say(`/amullogin _ga=1; jsessionid=${LOGIN}; _cfuvid=x`, 11)
    assert.ok(telegram.some((c) => c.method === 'deleteMessage' && c.body.message_id === 11), 'the cookie is not left in the chat')
    assert.match(sentTo(ADMIN).at(-1).body.text, /Logged in as Pankil/)
    assert.equal(JSON.parse(db2.prepare("SELECT value FROM meta WHERE key = 'amul_login'").get().value).jsessionid, LOGIN)

    telegram.length = 0
    await say('/amullogin jsessionid=s%3Adead' + 'y'.repeat(40), 12)
    assert.match(sentTo(ADMIN).at(-1).body.text, /does not see that cookie as logged in/)
    assert.equal(JSON.parse(db2.prepare("SELECT value FROM meta WHERE key = 'amul_login'").get().value).jsessionid, LOGIN, 'a bad cookie does not replace a good one')

    telegram.length = 0
    await handleUpdate(e, { update_id: 13, message: { message_id: 13, from: { id: USER, is_bot: false, first_name: 'Other' }, chat: { id: USER, type: 'private' }, date: 0, text: `/amullogin ${LOGIN}` } })
    assert.equal(sentTo(USER).length, 0, 'only the owner can set a login')
  } finally {
    account.restore()
  }
})

test('a restock puts the item in the owner\'s account cart and adds an Open cart button', async () => {
  const { cartEnv, db2 } = cartScenario()
  const account = await fakeAccount()
  try {
    const run = await runSweeps(cartEnv)
    assert.equal(run.alerts, 1)
    assert.equal(run.carts, 1)
    assert.deepEqual(run.errors, [])
  } finally {
    account.restore()
  }
  assert.equal(account.calls.length, 1)
  assert.match(account.calls[0].url, /\/entity\/ms\.carts\/acct1\/_\/addItem$/, "added to the account's own cart")
  assert.equal(account.calls[0].body.data.sku, inStock.sku)
  assert.ok(account.calls[0].body.data.product_id, 'the cart needs the product id')

  assert.equal(sentTo(ADMIN).length, 1, 'one alert message')
  assert.equal(edits().length, 1)
  assert.equal(edits()[0].body.message_id, 555, 'the button goes on the alert that was sent')
  const [top] = edits()[0].body.reply_markup.inline_keyboard
  assert.equal(top[0].url, 'https://shop.amul.com/en/cart')
  assert.ok(edits()[0].body.reply_markup.inline_keyboard.length > 1, 'the buy-now links are still there')
  assert.deepEqual(jobs(db2), [])
})

test('a cart that cannot be filled is retried, and the alert is never held up for it', async () => {
  const { cartEnv, db2 } = cartScenario()
  let account = await fakeAccount({ cart: () => new Response('bad gateway', { status: 502 }) })
  try {
    const run = await runSweeps(cartEnv)
    assert.equal(run.alerts, 1, 'the alert went out regardless')
    assert.match(run.errors.join(), /cart for .*502/)
  } finally {
    account.restore()
  }
  assert.equal(edits().length, 0)
  assert.equal(jobs(db2).length, 1, 'waiting for the next firing')
  assert.ok(db2.prepare("SELECT 1 FROM meta WHERE key = 'last_sweep_ok'").get(), 'heartbeat written')

  account = await fakeAccount()
  try {
    assert.equal((await runSweeps(cartEnv)).carts, 1, 'Amul is back')
  } finally {
    account.restore()
  }
  assert.equal(edits().length, 1)
  assert.deepEqual(jobs(db2), [])
})

test('a cart reply that is not the owner\'s account cart is not reported as success', async () => {
  const { cartEnv } = cartScenario()
  const account = await fakeAccount({ cart: () => Response.json({ cart: { _id: 'guest', email_id: null, phone: null, items: [{ sku: inStock.sku }] } }) })
  try {
    const run = await runSweeps(cartEnv)
    assert.match(run.errors.join(), /did not land in your account cart/)
    assert.equal(run.carts, 0)
  } finally {
    account.restore()
  }
  assert.equal(edits().length, 0, 'no cart button on a cart the owner cannot see')
})

test('an expired login is reported once, and the alert still goes out', async () => {
  const { cartEnv, db2 } = cartScenario()
  const account = await fakeAccount({ signedIn: false })
  try {
    const run = await runSweeps(cartEnv)
    assert.equal(run.alerts, 1)
    assert.equal(run.carts, 0)
  } finally {
    account.restore()
  }
  const texts = sentTo(ADMIN).map((c) => c.body.text)
  assert.equal(texts.length, 2, 'the alert, then the notice')
  assert.match(texts[1], /Amul login expired/)
  assert.equal(JSON.parse(db2.prepare("SELECT value FROM meta WHERE key = 'amul_login'").get().value).expired, true)
  assert.equal(edits().length, 0)
})

test('a login that has gone a while unused is checked, and its death is reported before a restock', async () => {
  const stale = Date.now() - 13 * 60 * 60 * 1000
  const { cartEnv, db2 } = cartScenario({ login: { jsessionid: LOGIN, savedAt: stale, checkedAt: stale } })
  // Nothing has restocked: remembered as in stock already.
  db2.prepare('UPDATE snapshots SET data = ?').run(JSON.stringify({ [inStock.sku]: 1 }))
  let account = await fakeAccount()
  try {
    await runSweeps(cartEnv)
    assert.ok(JSON.parse(db2.prepare("SELECT value FROM meta WHERE key = 'amul_login'").get().value).checkedAt > stale, 'a live login is refreshed')
    assert.equal(sentTo(ADMIN).length, 0, 'and nothing is said about it')
  } finally {
    account.restore()
  }

  db2.prepare("UPDATE meta SET value = json_set(value, '$.checkedAt', ?) WHERE key = 'amul_login'").run(stale)
  account = await fakeAccount({ signedIn: false })
  try {
    await runSweeps(cartEnv)
  } finally {
    account.restore()
  }
  assert.match(sentTo(ADMIN).at(-1).body.text, /Amul login expired/)
})

test('no cart is touched when AUTO_CART is off, there is no login, or the watcher is not the owner', async () => {
  for (const scenario of [{ autoCart: '0' }, { login: null }, { watcher: USER }]) {
    const { cartEnv } = cartScenario(scenario)
    const account = await fakeAccount()
    try {
      const run = await runSweeps(cartEnv)
      assert.equal(run.alerts, 1, JSON.stringify(scenario))
      assert.equal(run.carts, 0, JSON.stringify(scenario))
    } finally {
      account.restore()
    }
    assert.equal(account.calls.length, 0, JSON.stringify(scenario))
    assert.equal(edits().length, 0)
  }
})
