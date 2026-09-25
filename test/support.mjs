/**
 * Test environment: a real SQLite database behind a D1-shaped binding, built
 * from every migration so the schema cannot drift from production, and a
 * fetch that records Telegram calls while letting Amul requests through.
 * Amul is never faked — the sweep under test reads live stock.
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'

const MIGRATIONS = new URL('../migrations/', import.meta.url)

// node:sqlite returns rows with a null prototype; D1 returns plain objects.
// Match D1, or strict equality in tests fails on a difference D1 never has.
const plain = (row) => (row ? { ...row } : null)

function d1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...next) => statement(sql, next),
    first: () => plain(sqlite.prepare(sql).get(...args)),
    all: () => ({ results: sqlite.prepare(sql).all(...args).map(plain) }),
    run: () => sqlite.prepare(sql).run(...args)
  })
  return {
    prepare: (sql) => statement(sql),
    batch: async (statements) => statements.map((s) => s.run())
  }
}

/** Every Telegram call made during the test, in order. */
export const telegram = []

const realFetch = globalThis.fetch
globalThis.fetch = async (url, options) => {
  if (String(url).includes('api.telegram.org')) {
    telegram.push({
      method: String(url).split('/').pop(),
      body: options?.body ? JSON.parse(options.body) : {}
    })
    return Response.json({ ok: true, result: { message_id: 555 } })
  }
  return realFetch(url, options)
}

export function createEnv(vars = {}) {
  const sqlite = new DatabaseSync(':memory:')
  for (const file of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'))
  }
  return { sqlite, env: { DB: d1(sqlite), BOT_TOKEN: 'test', ACCESS_MODE: 'public', ...vars } }
}

export const sentTo = (chatId) =>
  telegram.filter((c) => c.method === 'sendMessage' && String(c.body.chat_id) === String(chatId))
