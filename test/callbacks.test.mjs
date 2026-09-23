import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { handleUpdate } from '../src/bot.js'

// ---- faithful-enough D1 shim over real SQLite
const sqlite = new DatabaseSync(':memory:')
// Every migration, in order, so the test schema never drifts from production.
const MIGRATIONS = new URL('../migrations/', import.meta.url)
for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
  sqlite.exec(readFileSync(new URL(f, MIGRATIONS), 'utf8'))
}
const DB = {
  prepare(sql) {
    const mk = (args) => ({
      bind: (...a) => mk(a),
      first: () => { try { return sqlite.prepare(sql).get(...args) ?? null } catch (e) { throw new Error(`${e.message} :: ${sql}`) } },
      all: () => ({ results: sqlite.prepare(sql).all(...args) }),
      run: () => sqlite.prepare(sql).run(...args)
    })
    return mk([])
  }
}

// ---- capture Telegram traffic, let Amul through
const sent = []
const realFetch = globalThis.fetch
globalThis.fetch = async (url, opts) => {
  const u = String(url)
  if (u.includes('api.telegram.org')) {
    const method = u.split('/').pop()
    const body = opts?.body ? JSON.parse(opts.body) : {}
    sent.push({ method, body })
    return new Response(JSON.stringify({ ok: true, result: { message_id: 555 } }), { headers: { 'content-type': 'application/json' } })
  }
  return realFetch(url, opts)
}

const env = { DB, BOT_TOKEN: 'x', ADMIN_CHAT_ID: '1000001', ACCESS_MODE: 'public' }
const FROM = { id: 1000001, is_bot: false, first_name: 'Test' }
const CHAT = { id: 1000001, type: 'private' }
const msg = (text) => handleUpdate(env, { update_id: 1, message: { message_id: 1, from: FROM, chat: CHAT, date: 0, text } })
const tap = (data) => handleUpdate(env, { update_id: 1, callback_query: { id: 'cb', from: FROM, data, message: { message_id: 555, chat: CHAT } } })
const last = () => sent[sent.length - 1]
const buttons = (m) => (m?.body?.reply_markup?.inline_keyboard ?? []).flat()
const tracks = () => sqlite.prepare('SELECT sku FROM tracks').all().map(r => r.sku)

await msg('143505')
sent.length = 0


console.log('--- current format: tap x60 from family screen ---')
await msg('whey')
const fam = buttons(last()).find(b => b.callback_data?.startsWith('f:'))
sent.length = 0; await tap(fam.callback_data)
const v60 = buttons(last()).find(b => b.text.includes('60'))
sent.length = 0; await tap(v60.callback_data)
console.log('  tapped', JSON.stringify(v60.text), '->', v60.callback_data)
console.log('  methods:', sent.map(x=>x.method).join(' + '), '| tracks:', tracks().join(',') || 'NONE')

console.log()
console.log('--- LEGACY formats still sitting in the chat ---')
for (const legacy of ['trk:WPCCP06_01:protein:0','untrk:WPCCP06_01::-1','cat:protein:0','picks','trkall:protein:0','bogus:xyz']) {
  sqlite.prepare('DELETE FROM tracks').run()
  sent.length = 0
  await tap(legacy)
  const alert = sent.find(x=>x.method==='answerCallbackQuery')?.body?.text ?? ''
  console.log('  ' + legacy.padEnd(28), '->', (sent.map(x=>x.method).join('+') || 'NOTHING').padEnd(34), 'tracks:', tracks().join(',') || '-', alert ? '| toast: '+alert : '')
}
