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
import { handleUpdate } from '../src/bot.js'

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
