/**
 * Sweep health.
 *
 * A sweep that gets killed cannot report its own death. The next one that
 * survives can, though: it knows when the last successful sweep finished, and
 * a long gap means everything in between was lost. That gap is exactly the
 * window in which a restock could have been missed, so it goes straight to the
 * admin on Telegram instead of surfacing a day later in a Cloudflare email.
 */
import { send, esc } from './telegram.js'
import { formatIst, formatDuration } from './time.js'

// Firings are a minute apart, so a normal gap is just under 60s. Three minutes
// means at least two consecutive firings did not finish.
const GAP_ALERT_MS = 3 * 60 * 1000

/**
 * @param previousOkAt when the last successful sweep finished (ms), or null if
 *   there has never been one — a fresh deployment is not an outage.
 * @param startedAt when this sweep started (ms).
 */
export function sweepGap(previousOkAt, startedAt) {
  if (previousOkAt === null) return null
  const gapMs = startedAt - previousOkAt
  return gapMs > GAP_ALERT_MS ? { from: previousOkAt, to: startedAt, gapMs } : null
}

export async function reportGap(env, gap) {
  if (!env.ADMIN_CHAT_ID) {
    console.error(`sweeps were down for ${formatDuration(gap.gapMs)} and no ADMIN_CHAT_ID is set to tell`)
    return
  }
  await send(
    env,
    env.ADMIN_CHAT_ID,
    [
      '⚠️ <b>Stock checks were down</b>',
      '',
      `From ${esc(formatIst(gap.from))} to ${esc(formatIst(gap.to))} (${esc(formatDuration(gap.gapMs))}).`,
      'A restock during that time may have been missed.',
      '',
      'Checks are running again.'
    ].join('\n')
  )
}
