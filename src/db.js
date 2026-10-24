/**
 * D1 storage layer.
 *
 * Deliberate difference from the upstream bot: a Telegram 403 never deletes
 * anything. Upstream hard-deletes the user *and* every product they tracked the
 * first time Telegram returns 403 — one transient error and the watchlist is
 * gone for good, silently. Here we only flip `is_blocked`, so unblocking the
 * bot restores everything intact.
 */

export async function getUser(env, chatId) {
  return env.DB.prepare('SELECT * FROM users WHERE chat_id = ?')
    .bind(chatId)
    .first()
}

export async function upsertUser(env, from) {
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO users (chat_id, username, first_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       username = excluded.username,
       first_name = excluded.first_name,
       is_blocked = 0,
       updated_at = excluded.updated_at`
  )
    .bind(from.id, from.username ?? null, from.first_name ?? '', now, now)
    .run()
  return getUser(env, from.id)
}

export async function setPincode(env, chatId, pincode, substore) {
  await env.DB.prepare(
    'UPDATE users SET pincode = ?, substore = ?, updated_at = ? WHERE chat_id = ?'
  )
    .bind(pincode, substore, Date.now(), chatId)
    .run()
}

export async function setBlocked(env, chatId, blocked) {
  await env.DB.prepare('UPDATE users SET is_blocked = ? WHERE chat_id = ?')
    .bind(blocked ? 1 : 0, chatId)
    .run()
}

export async function setPaused(env, chatId, paused) {
  await env.DB.prepare('UPDATE users SET is_paused = ? WHERE chat_id = ?')
    .bind(paused ? 1 : 0, chatId)
    .run()
}

export async function listTracks(env, chatId) {
  const { results } = await env.DB.prepare(
    'SELECT sku, name FROM tracks WHERE chat_id = ? ORDER BY created_at DESC'
  )
    .bind(chatId)
    .all()
  return results ?? []
}

export async function addTrack(env, chatId, sku, name) {
  await env.DB.prepare(
    `INSERT INTO tracks (chat_id, sku, name, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(chat_id, sku) DO NOTHING`
  )
    .bind(chatId, sku, name, Date.now())
    .run()
}

export async function removeTrack(env, chatId, sku) {
  await env.DB.prepare('DELETE FROM tracks WHERE chat_id = ? AND sku = ?')
    .bind(chatId, sku)
    .run()
}

/** Everyone tracking any of `skus` within one substore. */
export async function watchersFor(env, substore, skus) {
  if (!skus.length) return []
  const placeholders = skus.map(() => '?').join(',')
  const { results } = await env.DB.prepare(
    `SELECT u.chat_id, t.sku FROM tracks t
     JOIN users u ON u.chat_id = t.chat_id
     WHERE u.substore = ? AND u.is_blocked = 0 AND u.is_paused = 0
       AND t.sku IN (${placeholders})`
  )
    .bind(substore, ...skus)
    .all()
  return results ?? []
}

export async function getSnapshot(env, substore) {
  const row = await env.DB.prepare(
    'SELECT data FROM snapshots WHERE substore = ?'
  )
    .bind(substore)
    .first()
  if (!row?.data) return null
  try {
    return JSON.parse(row.data)
  } catch {
    return null
  }
}

export async function putSnapshot(env, substore, map) {
  await env.DB.prepare(
    `INSERT INTO snapshots (substore, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(substore) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  )
    .bind(substore, JSON.stringify(map), Date.now())
    .run()
}

const ACCESS_MODES = new Set(['private', 'allowlist', 'public'])

/**
 * Whether this chat may use the bot. ACCESS_MODE is required: a missing or
 * misspelt value used to fall back to "allowlist" silently, which for an
 * intended "public" bot means turning every new user away without a trace.
 */
export async function isAllowed(env, chatId) {
  const mode = env.ACCESS_MODE
  if (!ACCESS_MODES.has(mode)) {
    throw new Error(`ACCESS_MODE must be one of ${[...ACCESS_MODES].join(', ')}, got ${JSON.stringify(mode)}`)
  }
  if (mode === 'public') return true
  if (String(env.ADMIN_CHAT_ID) === String(chatId)) return true
  if (mode === 'private') return false
  const row = await env.DB.prepare(
    'SELECT chat_id FROM allowlist WHERE chat_id = ?'
  )
    .bind(chatId)
    .first()
  return Boolean(row)
}

export async function allow(env, chatId, note = '') {
  await env.DB.prepare(
    `INSERT INTO allowlist (chat_id, note, created_at) VALUES (?, ?, ?)
     ON CONFLICT(chat_id) DO NOTHING`
  )
    .bind(chatId, note, Date.now())
    .run()
}

export async function disallow(env, chatId) {
  await env.DB.prepare('DELETE FROM allowlist WHERE chat_id = ?')
    .bind(chatId)
    .run()
}

export async function stats(env) {
  const users = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM users WHERE is_blocked = 0'
  ).first()
  const tracks = await env.DB.prepare('SELECT COUNT(*) AS n FROM tracks').first()
  const subs = await env.DB.prepare(
    'SELECT COUNT(DISTINCT substore) AS n FROM users WHERE substore IS NOT NULL'
  ).first()
  return { users: users?.n ?? 0, tracks: tracks?.n ?? 0, substores: subs?.n ?? 0 }
}

/**
 * Most-watched SKUs across all users.
 *
 * Popularity is measured, not hardcoded: a curated "popular products" list
 * would be stale the day Amul adds an SKU, and wrong for every region that
 * buys differently. This starts empty and sharpens as people use the bot.
 */
export async function trendingSkus(env, limit = 10) {
  const { results } = await env.DB.prepare(
    `SELECT sku, name, COUNT(*) AS watchers FROM tracks
     GROUP BY sku ORDER BY watchers DESC, name ASC LIMIT ?`
  )
    .bind(limit)
    .all()
  return results ?? []
}

// Longer than the sweep's hourly refresh, with room for a late one. When this
// was shorter than the refresh, each tap in the gap paid for a live 2.5s fetch
// of the whole catalogue.
const CATALOG_TTL_MS = 2 * 60 * 60 * 1000

/** Cached catalogue for a substore, or null when missing or stale. */
export async function getCatalog(env, substore, maxAgeMs = CATALOG_TTL_MS) {
  const row = await env.DB.prepare(
    'SELECT data, fetched_at FROM catalog WHERE substore = ?'
  )
    .bind(substore)
    .first()
  if (!row?.data) return null
  if (Date.now() - row.fetched_at > maxAgeMs) return null
  try {
    return JSON.parse(row.data)
  } catch {
    return null
  }
}

export async function putCatalog(env, substore, products) {
  await env.DB.prepare(
    `INSERT INTO catalog (substore, data, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(substore) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`
  )
    .bind(substore, JSON.stringify(products), Date.now())
    .run()
}

// Using an Amul login is what keeps Amul extending it, so each one is used at
// least this often.
export const LOGIN_KEEP_ALIVE_MS = 12 * 60 * 60 * 1000

/**
 * Everything a check needs to read, in one round trip.
 *
 * On the free plan every awaited call costs CPU, and a check used to make
 * seven of them before it had looked at Amul. All three reads are batched
 * here: the meta rows (heartbeat, store version, cached sessions), what each
 * active substore is watching, and the remembered stock of each substore.
 */
export async function loadState(env, now = Date.now()) {
  const [metaRows, watchedRows, snapshotRows, dueRows] = await env.DB.batch([
    env.DB.prepare('SELECT key, value, updated_at FROM meta'),
    env.DB.prepare(
      `SELECT DISTINCT u.substore, t.sku FROM users u
       JOIN tracks t ON t.chat_id = u.chat_id
       WHERE u.substore IS NOT NULL AND u.is_blocked = 0 AND u.is_paused = 0`
    ),
    env.DB.prepare('SELECT substore, data FROM snapshots'),
    // At most one Amul login due its keep-alive; the ciphertext stays behind.
    env.DB.prepare(
      'SELECT chat_id FROM amul_logins WHERE expired = 0 AND checked_at < ? ORDER BY checked_at LIMIT 1'
    ).bind(now - LOGIN_KEEP_ALIVE_MS)
  ])

  const meta = new Map((metaRows.results ?? []).map((r) => [r.key, r]))

  // Substores that at least one active user is watching, with the SKUs wanted.
  const watched = new Map()
  for (const { substore, sku } of watchedRows.results ?? []) {
    if (!watched.has(substore)) watched.set(substore, [])
    watched.get(substore).push(sku)
  }

  const snapshots = new Map((snapshotRows.results ?? []).map((r) => [r.substore, r.data]))
  const loginDue = dueRows.results?.[0]?.chat_id ?? null
  return { meta, watched, snapshots, loginDue }
}

/** Age of the cached catalogue, or Infinity when there is none. */
export async function catalogAge(env, substore) {
  const row = await env.DB.prepare(
    'SELECT fetched_at FROM catalog WHERE substore = ?'
  )
    .bind(substore)
    .first()
  return row?.fetched_at ? Date.now() - row.fetched_at : Infinity
}

export async function getMeta(env, key) {
  const row = await env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first()
  return row?.value ?? null
}

export async function getMetaRow(env, key) {
  return env.DB.prepare('SELECT value, updated_at FROM meta WHERE key = ?').bind(key).first()
}

export async function putMeta(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(key, String(value), Date.now())
    .run()
}

/** Several meta rows in one round trip. `entries` is [[key, value], ...]. */
export async function putMetas(env, entries) {
  if (!entries.length) return
  const now = Date.now()
  const upsert = env.DB.prepare(
    `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
  await env.DB.batch(entries.map(([key, value]) => upsert.bind(key, String(value), now)))
}

/**
 * Append stock changes. `events` is [{ substore, sku, name, inStock, quantity }].
 * Batched so one sweep costs one round trip however many products moved.
 */
export async function recordStockEvents(env, events, at = Date.now()) {
  if (!events.length) return
  const insert = env.DB.prepare(
    `INSERT INTO stock_events (substore, sku, name, in_stock, quantity, at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  await env.DB.batch(
    events.map((e) => insert.bind(e.substore, e.sku, e.name, e.inStock ? 1 : 0, e.quantity, at))
  )
}

/** Most recent changes for some SKUs in one substore, newest first. */
export async function stockHistory(env, substore, skus, limit = 50) {
  if (!skus.length) return []
  const placeholders = skus.map(() => '?').join(',')
  const { results } = await env.DB.prepare(
    `SELECT sku, name, in_stock, quantity, at FROM stock_events
     WHERE substore = ? AND sku IN (${placeholders})
     ORDER BY at DESC LIMIT ?`
  )
    .bind(substore, ...skus, limit)
    .all()
  return results ?? []
}

/** Tracks with the time each one started, for "since you started watching". */
export async function listTracksWithSince(env, chatId) {
  const { results } = await env.DB.prepare(
    'SELECT sku, name, created_at FROM tracks WHERE chat_id = ? ORDER BY created_at DESC'
  )
    .bind(chatId)
    .all()
  return results ?? []
}

/** One user's saved Amul login (cookie still encrypted), or null. */
export async function getLogin(env, chatId) {
  return env.DB.prepare('SELECT chat_id, jsessionid, saved_at, checked_at, expired FROM amul_logins WHERE chat_id = ?')
    .bind(chatId)
    .first()
}

/** Of these chats, the ones with a login that still works. */
export async function chatsWithLogin(env, chatIds) {
  if (!chatIds.length) return new Set()
  const placeholders = chatIds.map(() => '?').join(',')
  const { results } = await env.DB.prepare(
    `SELECT chat_id FROM amul_logins WHERE expired = 0 AND chat_id IN (${placeholders})`
  )
    .bind(...chatIds)
    .all()
  return new Set((results ?? []).map((r) => String(r.chat_id)))
}

export async function putLogin(env, chatId, sealed, now = Date.now()) {
  await env.DB.prepare(
    `INSERT INTO amul_logins (chat_id, jsessionid, saved_at, checked_at, expired) VALUES (?, ?, ?, ?, 0)
     ON CONFLICT(chat_id) DO UPDATE SET jsessionid = excluded.jsessionid, saved_at = excluded.saved_at,
       checked_at = excluded.checked_at, expired = 0`
  )
    .bind(chatId, sealed, now, now)
    .run()
}

export async function markLogin(env, chatId, { expired = false, checkedAt = Date.now() } = {}) {
  await env.DB.prepare('UPDATE amul_logins SET expired = ?, checked_at = ? WHERE chat_id = ?')
    .bind(expired ? 1 : 0, checkedAt, chatId)
    .run()
}

export async function deleteLogin(env, chatId) {
  await env.DB.prepare('DELETE FROM amul_logins WHERE chat_id = ?').bind(chatId).run()
}
