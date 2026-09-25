/**
 * Entry point: HTTP routes (Telegram webhook, setup, manual checks) and the
 * cron trigger. The work itself lives in sweep.js and bot.js.
 */
import * as db from './db.js'
import { handleUpdate, COMMANDS } from './bot.js'
import { setCommands } from './telegram.js'
import { runCheck, runSweeps } from './sweep.js'

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
