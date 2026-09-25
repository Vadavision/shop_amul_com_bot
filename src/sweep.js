/**
 * Restock sweeps.
 *
 * Fetches once per substore, not once per user, so cost stays flat as the user
 * count grows. Only out-of-stock -> in-stock transitions notify; every change
 * in either direction is logged so "did it come back?" has a recorded answer.
 */
import { openSession, isInStock } from './amul.js'
import * as db from './db.js'
import { send, isUnreachable } from './telegram.js'
import { restockMessage, buyButtons } from './alert.js'
import { sweepGap, reportGap } from './health.js'

/**
 * How stale the browse/search catalogue may get before a sweep refreshes it.
 *
 * This used to be its own "*\/10" cron, but alongside the every-minute cron
 * Cloudflare never ran it — the branch was provably never entered — so the
 * sweep now decides when the catalogue is due and does it in-line.
 */
const CATALOG_EVERY_MS = 10 * 60 * 1000

// Finish comfortably inside the minute. If a firing ran long it would still be
// sweeping when the next one starts, and two overlapping runs can read the same
// snapshot and send the same restock alert twice.
const WINDOW_MS = 45000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** One pass over every substore that has watchers. */
export async function runCheck(env, sessions = new Map(), { refreshCatalog = false } = {}) {
  const substores = await db.activeSubstores(env)
  const storeVersion = Number(await db.getMeta(env, 'store_version')) || null
  const summary = { substores: substores.length, checked: 0, alerts: 0, changes: 0, catalog: false, errors: [] }

  for (const substore of substores) {
    try {
      // Only what someone is actually watching. Pulling the whole catalogue
      // here cost 114KB and ~10ms of CPU per sweep, which on the free plan
      // meant over half of all sweeps were killed mid-run.
      const skus = await db.trackedSkus(env, substore)
      if (!skus.length) continue

      const products = refreshCatalog
        ? await fetchViaCatalog(env, substore, skus, sessions, summary)
        : await fetchWatched(substore, skus, sessions, storeVersion)

      if (!products.length) {
        summary.errors.push(`${substore}: no products returned for ${skus.length} skus`)
        continue
      }
      summary.checked += products.length

      // No snapshot yet is a real state (first sweep for this substore), not
      // missing data: everything seen is a first sighting.
      const previous = (await db.getSnapshot(env, substore)) ?? {}
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

      if (changes.length) await db.putSnapshot(env, substore, { ...previous, ...current })
    } catch (err) {
      sessions.delete(substore)
      summary.errors.push(`${substore}: ${err.message}`)
    }
  }

  return summary
}

/**
 * The full catalogue, fetched once and used twice: browse/search get a fresh
 * cache, and restock detection reads the watched subset out of the same
 * response instead of making a second request. This also does the full
 * bootstrap, which is where the store version is rediscovered for the cheap
 * sweeps to reuse.
 */
async function fetchViaCatalog(env, substore, skus, sessions, summary) {
  const session = await openSession(substore)
  sessions.set(substore, session)
  await db.putMeta(env, 'store_version', session.version)

  const all = await session.products()
  await db.putCatalog(env, substore, all)
  summary.catalog = true

  const wanted = new Set(skus)
  return all.filter((p) => wanted.has(p.sku))
}

async function fetchWatched(substore, skus, sessions, storeVersion) {
  let session = sessions.get(substore)
  if (!session) {
    session = await openSession(substore, { storeVersion })
    sessions.set(substore, session)
  }
  return session.products({ skus })
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
      await send(env, chatId, restockMessage(items), buyButtons(items))
      sent++
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
  const totals = { sweeps: 0, substores: 0, alerts: 0, changes: 0, catalog: false, errors: [] }

  // Read before this run overwrites it: the previous success is what tells us
  // whether the firings in between died.
  const lastOk = await db.getMetaRow(env, 'last_sweep_ok')
  const catalogRow = await db.getMetaRow(env, 'last_catalog_ok')
  const catalogDue = !catalogRow || startedAt - catalogRow.updated_at > CATALOG_EVERY_MS

  for (let i = 0; i < sweeps; i++) {
    if (i > 0) {
      await sleep(spacing)
      // Amul can be slow; drop the remaining sweeps rather than overrun.
      if (Date.now() - startedAt > WINDOW_MS) break
    }

    const result = await runCheck(env, sessions, { refreshCatalog: i === 0 && catalogDue })
    if (result.catalog) {
      totals.catalog = true
      await db.putMeta(env, 'last_catalog_ok', 1)
    }
    totals.sweeps++
    totals.substores = result.substores
    totals.alerts += result.alerts
    totals.changes += result.changes
    totals.errors.push(...result.errors)
  }

  totals.elapsedMs = Date.now() - startedAt

  // Heartbeat. A killed invocation never reaches this line, so a stale
  // timestamp is direct evidence that sweeps are dying.
  await db.putMeta(env, 'last_sweep_ok', totals.elapsedMs)

  const gap = sweepGap(lastOk ? lastOk.updated_at : null, startedAt)
  if (gap) {
    totals.gap = gap
    await reportGap(env, gap)
  }

  return totals
}
