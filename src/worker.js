import { openSession, isInStock } from './amul.js'
import * as db from './db.js'
import { handleUpdate, COMMANDS } from './bot.js'
import { send, setCommands, isUnreachable } from './telegram.js'
import { restockMessage, buyButtons } from './alert.js'

/**
 * How stale the browse/search catalogue may get before a sweep refreshes it.
 *
 * This used to be its own "*\/10" cron, but alongside the every-minute cron
 * Cloudflare never ran it — the branch was provably never entered — so the
 * sweep now decides when the catalogue is due and does it in-line.
 */
const CATALOG_EVERY_MS = 10 * 60 * 1000

/**
 * One stock sweep.
 *
 * Fetches once per substore, not once per user, so cost stays flat as the user
 * count grows. Only out-of-stock -> in-stock transitions notify; steady-state
 * availability stays quiet.
 */
async function runCheck(env, sessions = new Map(), { refreshCatalog = false } = {}) {
  const substores = await db.activeSubstores(env)
  const storeVersion = Number(await db.getMeta(env, 'store_version')) || null
  const summary = { substores: substores.length, checked: 0, alerts: 0, catalog: false, errors: [] }

  for (const substore of substores) {
    try {
      // Only what someone is actually watching. Pulling the whole catalogue
      // here cost 114KB and ~10ms of CPU per sweep, which on the free plan
      // meant over half of all sweeps were killed mid-run.
      const skus = await db.trackedSkus(env, substore)
      if (!skus.length) continue

      let products
      if (refreshCatalog) {
        // The full catalogue, fetched once and used twice: browse/search get
        // a fresh cache, and restock detection reads the watched subset out of
        // the same response instead of making a second request. This also
        // does the full bootstrap, which is where the store version is
        // rediscovered for the cheap sweeps to reuse.
        const session = await openSession(substore)
        sessions.set(substore, session)
        await db.putMeta(env, 'store_version', session.version)

        const all = await session.products()
        await db.putCatalog(env, substore, all)
        summary.catalog = true

        const wanted = new Set(skus)
        products = all.filter((p) => wanted.has(p.sku))
      } else {
        let session = sessions.get(substore)
        if (!session) {
          session = await openSession(substore, { storeVersion })
          sessions.set(substore, session)
        }
        products = await session.products({ skus })
      }
      if (!products.length) {
        summary.errors.push(`${substore}: no products returned for ${skus.length} skus`)
        continue
      }
      summary.checked += products.length

      const previous = (await db.getSnapshot(env, substore)) ?? {}
      const current = {}
      for (const p of products) current[p.sku] = isInStock(p) ? 1 : 0

      // A sku seen for the first time is recorded, never announced — otherwise
      // adding something already in stock would page you immediately.
      const restocked = products.filter(
        (p) => current[p.sku] === 1 && previous[p.sku] === 0
      )

      if (restocked.length) {
        const bySku = new Map(restocked.map((p) => [p.sku, p]))
        const watchers = await db.watchersFor(env, substore, [...bySku.keys()])

        const perUser = new Map()
        for (const { chat_id, sku } of watchers) {
          if (!perUser.has(chat_id)) perUser.set(chat_id, [])
          perUser.get(chat_id).push(bySku.get(sku))
        }

        for (const [chatId, items] of perUser) {
          try {
            await send(env, chatId, restockMessage(items), buyButtons(items))
            summary.alerts++
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
      }

      const merged = { ...previous, ...current }
      const changed = Object.keys(merged).some((sku) => merged[sku] !== previous[sku])
      if (changed) await db.putSnapshot(env, substore, merged)
    } catch (err) {
      sessions.delete(substore)
      summary.errors.push(`${substore}: ${err.message}`)
    }
  }

  return summary
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Several sweeps per cron firing.
 *
 * Cloudflare will not schedule a cron more often than once a minute, but a
 * single invocation may keep working after it starts. Sweeping a few times
 * inside one firing takes the effective polling interval below that floor
 * without costing another invocation: the run stays one request, and the
 * sweeps after the first skip the session bootstrap entirely.
 */
async function runSweeps(env) {
  const sweeps = Math.max(1, Math.min(6, Number(env.SWEEPS_PER_RUN ?? 3)))

  // Finish comfortably inside the minute. If a firing ran long it would still
  // be sweeping when the next one starts, and two overlapping runs can read
  // the same snapshot and send the same restock alert twice.
  const WINDOW_MS = 45000
  const spacing = Math.floor(WINDOW_MS / sweeps)
  const startedAt = Date.now()

  const sessions = new Map()
  const totals = { sweeps: 0, substores: 0, alerts: 0, catalog: false, errors: [] }

  const catalogRow = await db.getMetaRow(env, 'last_catalog_ok')
  const catalogDue = !catalogRow || Date.now() - catalogRow.updated_at > CATALOG_EVERY_MS

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
    totals.errors.push(...result.errors)
  }

  totals.elapsedMs = Date.now() - startedAt

  // Heartbeat. A killed invocation never reaches this line, so a stale
  // timestamp is direct evidence that sweeps are dying rather than something
  // inferred from aggregate CPU numbers.
  await db.putMeta(env, 'last_sweep_ok', totals.elapsedMs)

  return totals
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    if (url.pathname === '/health') {
      return Response.json({ ok: true, ts: Date.now() })
    }

    // One-time helper: register the webhook and the command menu.
    if (url.pathname === '/setup' && url.searchParams.get('key') === env.SETUP_KEY) {
      const hook = `${url.origin}/webhook`
      const res = await fetch(
        `https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            url: hook,
            secret_token: env.WEBHOOK_SECRET,
            allowed_updates: ['message', 'callback_query'],
            drop_pending_updates: true
          })
        }
      )
      // Telegram clients cache the command menu per scope, and a default-scope
      // registration alone often will not refresh an already-open chat. Set the
      // private-chat scope too, and report failures rather than hiding them.
      const commandResults = {}
      for (const scope of [undefined, { type: 'all_private_chats' }]) {
        const label = scope?.type ?? 'default'
        try {
          await setCommands(env, COMMANDS, scope)
          commandResults[label] = 'ok'
        } catch (err) {
          commandResults[label] = err.message
        }
      }

      return Response.json({
        webhook: hook,
        telegram: await res.json(),
        commands: commandResults
      })
    }

    // Manual sweep, handy for testing without waiting for cron.
    if (url.pathname === '/check' && url.searchParams.get('key') === env.SETUP_KEY) {
      return Response.json(await runCheck(env))
    }

    if (url.pathname === '/catalog' && url.searchParams.get('key') === env.SETUP_KEY) {
      const result = await runCheck(env, new Map(), { refreshCatalog: true })
      if (result.catalog) await db.putMeta(env, 'last_catalog_ok', 1)
      return Response.json(result)
    }

    if (url.pathname === '/webhook' && request.method === 'POST') {
      if (
        env.WEBHOOK_SECRET &&
        request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET
      ) {
        return new Response('forbidden', { status: 403 })
      }
      const update = await request.json()
      // Answer Telegram immediately; do the work after the response.
      ctx.waitUntil(handleUpdate(env, update))
      return new Response('ok')
    }

    return new Response('amul-watch', { status: 200 })
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runSweeps(env).then((s) => {
        if (s.errors.length) console.error('sweep errors:', s.errors)
        console.log(`${s.sweeps} sweeps, ${s.alerts} alerts${s.catalog ? ', catalog refreshed' : ''}`)
      })
    )
  }
}
