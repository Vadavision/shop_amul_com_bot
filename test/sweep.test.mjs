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
import { runSweeps } from '../src/sweep.js'
import { handleUpdate } from '../src/bot.js'

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
  setMeta('last_catalog_ok', 1, Date.now() - 60 * 60 * 1000)

  const run = await runSweeps(env)

  assert.equal(run.catalog, true, 'this firing refreshed the catalogue')
  assert.ok(sqlite.prepare('SELECT 1 FROM catalog WHERE substore = ?').get(SUBSTORE), 'catalogue cached')
  assert.deepEqual(events().at(-1), { sku: soldOut.sku, in_stock: 0 })
})

test('missing SWEEPS_PER_RUN fails loudly instead of defaulting', async () => {
  const { env: unset } = createEnv({})
  await assert.rejects(runSweeps(unset), /SWEEPS_PER_RUN must be an integer/)
})
