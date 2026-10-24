/**
 * Restock sweeps.
 *
 * Fetches once per substore, not once per user, so cost stays flat as the user
 * count grows. Only out-of-stock -> in-stock transitions notify; every change
 * in either direction is logged so "did it come back?" has a recorded answer.
 *
 * The free plan gives each firing 10ms of CPU, and nearly all of that goes on
 * awaiting I/O, not on computing. So a check is built to await as little as
 * possible: one batched D1 read, one request to Amul on a session kept from an
 * earlier firing, one batched D1 write. The catalogue refresh, which is far
 * heavier, runs after the heartbeat so it can never cost a check.
 */
import { AmulSession, openSession, isInStock } from './amul.js'
import * as db from './db.js'
import { send, editButtons, isUnreachable } from './telegram.js'
import { restockMessage, buyButtons } from './alert.js'
import { sweepGap, reportGap, parseHealth, nextHealth, reportHealth } from './health.js'

/**
 * How stale the browse/search catalogue may get before a sweep refreshes it.
 *
 * The product list itself hardly changes, and it is the heaviest thing a
 * firing does, so this is hourly. It is also what browse uses to sort in-stock
 * items first, which is why it is not daily. db.js keeps the cache valid for
 * longer than this, so a late refresh never sends a tap to a live fetch.
 *
 * This used to be its own "*\/10" cron, but alongside the every-minute cron
 * Cloudflare never ran it — the branch was provably never entered — so the
 * sweep now decides when the catalogue is due and does it in-line.
 */
const CATALOG_EVERY_MS = 60 * 60 * 1000

// Amul's Cloudflare cookies last about half an hour; replace the session well
// inside that rather than discovering it has expired through a failed check.
const SESSION_TTL_MS = 15 * 60 * 1000

// The store version is rediscovered by downloading a 184KB script, so do it
// now and then instead of on every new session.
const STORE_VERSION_TTL_MS = 6 * 60 * 60 * 1000

// Finish comfortably inside the minute. If a firing ran long it would still be
// sweeping when the next one starts, and two overlapping runs can read the same
// snapshot and send the same restock alert twice.
const WINDOW_MS = 45000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// An alert is sent the moment a restock is seen; the cart behind its checkout
// button is built a beat later. A job that cannot be finished is retried each
// minute for a few minutes, then dropped: a cart that late is not worth much.
const CART_JOB_TRIES = 3
const CART_JOB_MAX_AGE_MS = 10 * 60 * 1000
const CART_JOBS_PER_RUN = 2

const sessionKey = (substore) => `amul_session:${substore}`

/** The session saved by an earlier firing, if it is still young enough. */
function savedSession(state, substore) {
  const row = state.meta.get(sessionKey(substore))
  if (!row) return null
  try {
    const data = JSON.parse(row.value)
    return Date.now() - data.at < SESSION_TTL_MS ? AmulSession.restore(data) : null
  } catch {
    return null
  }
}

/** A brand-new session, saved so the next firings can skip opening one. */
async function freshSession(env, state, substore) {
  const version = state.meta.get('store_version')
  const known = version && Date.now() - version.updated_at < STORE_VERSION_TTL_MS
  const session = await openSession(substore, { storeVersion: known ? Number(version.value) : null })

  const saved = JSON.stringify(session.export())
  const entries = [[sessionKey(substore), saved]]
  if (!known || String(session.version) !== version.value) entries.push(['store_version', session.version])
  await db.putMetas(env, entries)
  const now = Date.now()
  for (const [key, value] of entries) state.meta.set(key, { value: String(value), updated_at: now })
  return session
}

/**
 * Run `work` on a session, replacing the session once if the first attempt
 * fails. A saved session going stale is routine, and indistinguishable from
 * Amul being down until a fresh one is tried.
 */
async function withSession(env, state, substore, sessions, work) {
  const reused = sessions.get(substore) ?? savedSession(state, substore)
  if (reused) {
    try {
      const result = await work(reused)
      sessions.set(substore, reused)
      return result
    } catch {
      sessions.delete(substore)
    }
  }
  const session = await freshSession(env, state, substore)
  const result = await work(session)
  sessions.set(substore, session)
  return result
}

const parseSnapshot = (text) => {
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return {}
  }
}

/**
 * One pass over every substore that has watchers.
 *
 * `state` comes from db.loadState and is updated as the pass goes, so further
 * passes in the same firing need no more reads.
 */
export async function runCheck(env, state, sessions = new Map()) {
  const summary = { substores: state.watched.size, checked: 0, alerts: 0, changes: 0, catalog: false, errors: [], failed: [], cartJobs: [] }

  for (const [substore, skus] of state.watched) {
    try {
      // Only what someone is actually watching: two products cost ~1.5KB, the
      // whole catalogue 114KB.
      const products = await withSession(env, state, substore, sessions, async (session) => {
        const found = await session.products({ skus })
        if (!found.length) throw new Error(`no products returned for ${skus.length} skus`)
        return found
      })
      summary.checked += products.length

      // No snapshot yet is a real state (first sweep for this substore), not
      // missing data: everything seen is a first sighting.
      const previous = parseSnapshot(state.snapshots.get(substore))
      const current = {}
      for (const p of products) current[p.sku] = isInStock(p) ? 1 : 0

      // Log every change, including first sightings, so history has a
      // starting point for each product rather than beginning mid-story.
      const changes = products.filter((p) => previous[p.sku] !== current[p.sku])
      await db.recordStockEvents(
        env,
        changes.map((p) => ({
          substore,
          sku: p.sku,
          name: p.name,
          inStock: current[p.sku] === 1,
          quantity: p.inventory_quantity
        }))
      )
      summary.changes += changes.length

      // Alert only on sold out -> in stock. A first sighting is logged but
      // never announced, or adding something already in stock would page you.
      const restocked = changes.filter((p) => current[p.sku] === 1 && previous[p.sku] === 0)
      if (restocked.length) summary.alerts += await notifyWatchers(env, substore, restocked, summary)

      if (changes.length) {
        const merged = { ...previous, ...current }
        await db.putSnapshot(env, substore, merged)
        state.snapshots.set(substore, JSON.stringify(merged))
      }
    } catch (err) {
      sessions.delete(substore)
      summary.errors.push(`${substore}: ${err.message}`)
      summary.failed.push({ substore, error: err.message })
    }
  }

  return summary
}

/**
 * Refresh the browse/search catalogue of every watched substore.
 *
 * Heavy — the whole product list is downloaded, parsed and written back — so
 * it runs on its own, after the stock check and its heartbeat are safe.
 */
export async function refreshCatalogs(env, state, sessions = new Map()) {
  const summary = { catalog: false, errors: [] }
  for (const substore of state.watched.keys()) {
    try {
      const all = await withSession(env, state, substore, sessions, (session) => session.products())
      await db.putCatalog(env, substore, all)
      summary.catalog = true
    } catch (err) {
      summary.errors.push(`${substore} catalogue: ${err.message}`)
    }
  }
  if (summary.catalog) await db.putMeta(env, 'last_catalog_ok', 1)
  return summary
}

/** One message per user, however many of their items came back together. */
async function notifyWatchers(env, substore, restocked, summary) {
  const bySku = new Map(restocked.map((p) => [p.sku, p]))
  const watchers = await db.watchersFor(env, substore, [...bySku.keys()])

  const perUser = new Map()
  for (const { chat_id, sku } of watchers) {
    if (!perUser.has(chat_id)) perUser.set(chat_id, [])
    perUser.get(chat_id).push(bySku.get(sku))
  }

  let sent = 0
  for (const [chatId, items] of perUser) {
    try {
      const message = await send(env, chatId, restockMessage(items), buyButtons(items))
      sent++
      if (env.AUTO_CART === '1') {
        summary.cartJobs.push({
          chatId,
          messageId: message?.message_id ?? null,
          substore,
          skus: items.slice(0, 5).map((p) => p.sku),
          at: Date.now(),
          tries: 0
        })
      }
    } catch (err) {
      if (isUnreachable(err)) {
        // Mark, never delete. The upstream bot deletes the user and every
        // product they tracked here, which silently destroys watchlists.
        await db.setBlocked(env, chatId, true)
      } else {
        summary.errors.push(`chat ${chatId}: ${err.message}`)
      }
    }
  }
  return sent
}

const parseJobs = (row) => {
  try {
    const jobs = JSON.parse(row?.value)
    return Array.isArray(jobs) ? jobs : []
  } catch {
    return []
  }
}

/**
 * Put what just came back in stock into a guest cart, and give the alert a
 * button that opens it.
 *
 * Amul carts are records addressed by id, so the cart the bot builds here can
 * be opened from any browser (see cartUrl). Nothing is paid for and no account
 * is involved; the owner signs in at checkout like any other order.
 */
async function buildCart(env, state, sessions, job) {
  const { cartId, items } = await withSession(env, state, job.substore, sessions, async (session) => {
    const items = (await session.products({ skus: job.skus, raw: true })).filter(isInStock)
    let id = null
    for (const product of items) id = (await session.addToCart(product, { cartId: id })).cart._id
    return { cartId: id, items }
  })
  // Gone again before the cart could be built: the alert still has its buy links.
  if (!cartId) return false

  const buttons = buyButtons(items, cartId)
  if (job.messageId) {
    try {
      await editButtons(env, job.chatId, job.messageId, buttons)
      return true
    } catch {
      // The message was deleted or is too old to edit; fall through to a new one.
    }
  }
  await send(env, job.chatId, '🛒 <b>Your cart is ready</b>\n\nTap to review it and check out.', buttons)
  return true
}

/** Work through waiting cart jobs, returning the ones still to retry. */
async function runCartJobs(env, state, sessions, jobs, totals) {
  const now = Date.now()
  const keep = []
  let done = 0
  for (const job of jobs) {
    if (now - job.at > CART_JOB_MAX_AGE_MS || job.tries >= CART_JOB_TRIES) continue
    if (done >= CART_JOBS_PER_RUN) {
      keep.push(job)
      continue
    }
    done++
    try {
      await buildCart(env, state, sessions, job)
      totals.carts++
    } catch (err) {
      totals.errors.push(`cart for ${job.chatId}: ${err.message}`)
      keep.push({ ...job, tries: job.tries + 1 })
    }
  }
  return keep
}

/**
 * Everything one cron firing does.
 *
 * SWEEPS_PER_RUN is required configuration. It used to default to 3 when
 * unset — the exact value that got a quarter of all firings killed on the free
 * plan — so a missing setting now fails loudly instead of quietly choosing it.
 */
export async function runSweeps(env) {
  const sweeps = Number(env.SWEEPS_PER_RUN)
  if (!Number.isInteger(sweeps) || sweeps < 1 || sweeps > 6) {
    throw new Error(`SWEEPS_PER_RUN must be an integer from 1 to 6, got ${JSON.stringify(env.SWEEPS_PER_RUN)}`)
  }

  const startedAt = Date.now()
  const spacing = Math.floor(WINDOW_MS / sweeps)
  const sessions = new Map()
  const totals = { sweeps: 0, substores: 0, alerts: 0, changes: 0, carts: 0, catalog: false, errors: [] }

  // Read before this run overwrites it: the previous success is what tells us
  // whether the firings in between died.
  const state = await db.loadState(env)
  const lastOk = state.meta.get('last_sweep_ok')
  const catalogRow = state.meta.get('last_catalog_ok')
  const catalogDue = !catalogRow || startedAt - catalogRow.updated_at > CATALOG_EVERY_MS

  const failed = []
  const newJobs = []
  for (let i = 0; i < sweeps; i++) {
    if (i > 0) {
      await sleep(spacing)
      // Amul can be slow; drop the remaining sweeps rather than overrun.
      if (Date.now() - startedAt > WINDOW_MS) break
    }

    const result = await runCheck(env, state, sessions)
    totals.sweeps++
    totals.substores = result.substores
    totals.alerts += result.alerts
    totals.changes += result.changes
    totals.errors.push(...result.errors)
    failed.push(...result.failed)
    newJobs.push(...result.cartJobs)
  }

  totals.elapsedMs = Date.now() - startedAt

  // A check that got no stock data is not a healthy firing, however cleanly
  // the worker itself ran. Count them, and tell the admin when it keeps
  // happening; the heartbeat below only proves the firing was not killed.
  const previousHealth = parseHealth(state.meta.get('check_health'))
  const health = nextHealth(previousHealth, failed, startedAt)
  if (failed.length) totals.failedChecks = health.state.failures

  const gap = sweepGap(lastOk ? lastOk.updated_at : null, startedAt)
  if (gap) totals.gap = gap

  // Telling the admin is the one step that talks to Telegram for a reason
  // other than a restock, so a failure there must not stop the heartbeat.
  const tell = async (message, notify) => {
    try {
      await notify()
    } catch (err) {
      totals.errors.push(`${message}: ${err.message}`)
      return false
    }
    return true
  }
  if (gap) await tell('gap report', () => reportGap(env, gap))
  if (health.notify) {
    const sent = await tell('health report', () => reportHealth(env, health.notify, previousHealth, health.state, startedAt))
    // Unsent means unannounced: leave the alert due so the next firing retries.
    if (!sent) health.state.alertedAt = previousHealth.alertedAt
  }

  // Heartbeat. A killed invocation never reaches this line, so a stale
  // timestamp is direct evidence that sweeps are dying.
  const writes = [['last_sweep_ok', totals.elapsedMs]]
  if (health.changed) writes.push(['check_health', JSON.stringify(health.state)])
  const waiting = [...parseJobs(state.meta.get('cart_jobs')), ...newJobs]
  // Saved with the heartbeat, so a firing killed before the cart is built still
  // leaves the job for the next one.
  if (newJobs.length) writes.push(['cart_jobs', JSON.stringify(waiting)])
  await db.putMetas(env, writes)

  // Straight after the heartbeat: the alert is already out, and a cart that is
  // ready within a few seconds is worth more than a fresh catalogue.
  if (waiting.length) {
    const remaining = await runCartJobs(env, state, sessions, waiting, totals)
    if (JSON.stringify(remaining) !== JSON.stringify(waiting)) {
      await db.putMeta(env, 'cart_jobs', JSON.stringify(remaining))
    }
  }

  // Last, and on its own: the heaviest thing a firing does.
  if (catalogDue) {
    const refreshed = await refreshCatalogs(env, state, sessions)
    totals.catalog = refreshed.catalog
    totals.errors.push(...refreshed.errors)
  }

  return totals
}
