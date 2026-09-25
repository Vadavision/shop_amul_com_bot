/**
 * Inline-button behaviour, including buttons left in chats by older versions.
 *
 * Messages keep the buttons they were sent with, so a deploy that renames a
 * callback breaks every menu already on screen. This guards the two ways that
 * went wrong: dead buttons that silently did nothing, and taps that tracked
 * nothing while appearing to work.
 */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { createEnv, telegram } from './support.mjs'
import { handleUpdate } from '../src/bot/index.js'

const USER = { id: 1000001, is_bot: false, first_name: 'Test' }
const CHAT = { id: 1000001, type: 'private' }
const { env, sqlite } = createEnv({ ADMIN_CHAT_ID: String(USER.id) })

const message = (text) =>
  handleUpdate(env, { update_id: 1, message: { message_id: 1, from: USER, chat: CHAT, date: 0, text } })
const tap = (data) =>
  handleUpdate(env, { update_id: 1, callback_query: { id: 'cb', from: USER, data, message: { message_id: 555, chat: CHAT } } })
const tracked = () => sqlite.prepare('SELECT sku FROM tracks').all().map((r) => r.sku)
const lastCall = () => telegram[telegram.length - 1]
const buttons = (call) => (call?.body?.reply_markup?.inline_keyboard ?? []).flat()

before(async () => {
  await message('143505')
})

test('tapping a size tracks it on the first tap and edits the menu in place', async () => {
  await message('whey')
  const family = buttons(lastCall()).find((b) => b.callback_data.startsWith('f:'))
  assert.ok(family, 'search shows at least one product family')

  await tap(family.callback_data)
  assert.equal(lastCall().method, 'editMessageText', 'opening a family edits, never sends a new menu')
  const size = buttons(lastCall()).find((b) => b.callback_data.startsWith('t:'))

  telegram.length = 0
  await tap(size.callback_data)
  assert.deepEqual(telegram.map((c) => c.method), ['answerCallbackQuery', 'editMessageText'])
  assert.ok(tracked().includes(size.callback_data.split(':')[1]), 'the tapped size is tracked after one tap')
})

test('buttons from older versions still work', async () => {
  sqlite.prepare('DELETE FROM tracks').run()
  await tap('trk:WPCCP06_01:protein:0')
  assert.deepEqual(tracked(), ['WPCCP06_01'], 'legacy "trk" tracks')

  await tap('untrk:WPCCP06_01::-1')
  assert.deepEqual(tracked(), [], 'legacy "untrk" untracks')

  for (const legacy of ['cat:protein:0', 'picks']) {
    telegram.length = 0
    await tap(legacy)
    assert.equal(lastCall().method, 'editMessageText', `legacy "${legacy}" redraws in place`)
  }
})

test('an unrecognised button says it is out of date and opens a working menu', async () => {
  for (const unknown of ['trkall:protein:0', 'bogus:xyz']) {
    telegram.length = 0
    await tap(unknown)
    const answer = telegram.find((c) => c.method === 'answerCallbackQuery')
    assert.match(answer.body.text, /out of date/, `"${unknown}" is explained, not silently ignored`)
    assert.equal(lastCall().method, 'sendMessage', `"${unknown}" hands over a fresh menu`)
  }
})

test('a watched product Amul delisted shows as no longer listed, not as sold out', async () => {
  sqlite.prepare('DELETE FROM tracks').run()
  sqlite.prepare('INSERT INTO tracks (chat_id, sku, name, created_at) VALUES (?, ?, ?, ?)').run(USER.id, 'GONE000001', 'Amul Discontinued Thing, 1 kg', Date.now())

  telegram.length = 0
  await message('/tracked')
  const labels = buttons(lastCall()).map((b) => b.text)
  assert.ok(labels.some((l) => l.startsWith('⚠️ No longer sold')), 'delisted item is labelled as such, visibly')
  assert.ok(labels.every((l) => !l.startsWith('▫️ Discontinued')), 'and not dressed up as sold out')
})

test('tapping to watch a delisted product says so and tracks nothing', async () => {
  sqlite.prepare('DELETE FROM tracks').run()
  telegram.length = 0
  await tap('t:GONE000001:l')
  const answers = telegram.filter((c) => c.method === 'answerCallbackQuery')
  assert.equal(answers.length, 1, 'Telegram accepts exactly one answer per tap')
  assert.match(answers[0].body.text, /no longer listed/)
  assert.deepEqual(tracked(), [])
})

test('the catalogue cache survives until the next ten-minute refresh', async () => {
  const { getCatalog, putCatalog } = await import('../src/db.js')
  await putCatalog(env, 'punjab', [{ sku: 'X' }])
  sqlite.prepare('UPDATE catalog SET fetched_at = ? WHERE substore = ?').run(Date.now() - 11 * 60 * 1000, 'punjab')
  assert.deepEqual(await getCatalog(env, 'punjab'), [{ sku: 'X' }], '11 minutes old is still served')
})

test('ACCESS_MODE is required', async () => {
  const { env: unset } = createEnv({ ACCESS_MODE: undefined })
  await assert.rejects(
    handleUpdate(unset, { update_id: 1, message: { message_id: 1, from: USER, chat: CHAT, date: 0, text: '/start' } }),
    /ACCESS_MODE must be one of/
  )
})
