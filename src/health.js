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

// A single 504 from Amul is routine and the next minute fixes it. Five
// failing firings in a row is a real outage, and the point at which a restock
// could be going unseen.
const FAILURES_BEFORE_ALERT = 5

// While an outage drags on, say so again now and then rather than once.
const REMIND_EVERY_MS = 6 * 60 * 60 * 1000

export const FRESH_HEALTH = { failures: 0, since: 0, lastError: '', alertedAt: 0 }

/** The stored streak, tolerating a missing or damaged row. */
export function parseHealth(row) {
  try {
    return { ...FRESH_HEALTH, ...JSON.parse(row?.value) }
  } catch {
    return { ...FRESH_HEALTH }
  }
}

/**
 * Fold one firing into the failure streak.
 *
 * `failed` is the list of substores whose check produced no stock data. A
 * firing that threw those errors away while still writing its heartbeat is how
 * a dead Amul connection used to look healthy for days.
 *
 * Returns the new state, whether it needs saving, and what (if anything) the
 * admin should hear: 'failing' once the streak is long enough, 'recovered'
 * when it ends after an alert was sent.
 */
export function nextHealth(previous, failed, now) {
  if (!failed.length) {
    if (!previous.failures) return { state: previous, changed: false, notify: null }
    return {
      state: { ...FRESH_HEALTH },
      changed: true,
      notify: previous.alertedAt ? 'recovered' : null
    }
  }

  const state = {
    failures: previous.failures + 1,
    since: previous.failures ? previous.since : now,
    lastError: failed.map((f) => `${f.substore}: ${f.error}`).join('; ').slice(0, 300),
    alertedAt: previous.alertedAt
  }
  const due = state.failures >= FAILURES_BEFORE_ALERT && now - previous.alertedAt >= REMIND_EVERY_MS
  if (due) state.alertedAt = now
  return { state, changed: true, notify: due ? 'failing' : null }
}

export async function reportHealth(env, kind, previous, state, now) {
  if (!env.ADMIN_CHAT_ID) {
    console.error(`stock checks ${kind} and no ADMIN_CHAT_ID is set to tell`)
    return
  }
  const lines =
    kind === 'failing'
      ? [
          '🚨 <b>Stock checks are failing</b>',
          '',
          `${state.failures} checks in a row have failed, since ${esc(formatIst(state.since))}.`,
          `Last error: <code>${esc(state.lastError)}</code>`,
          '',
          'Restocks are not being detected until this clears. You will hear when it does.'
        ]
      : [
          '✅ <b>Stock checks recovered</b>',
          '',
          `They were failing from ${esc(formatIst(previous.since))} to ${esc(formatIst(now))} (${esc(formatDuration(now - previous.since))}).`,
          'A restock during that time may have been missed.'
        ]
  await send(env, env.ADMIN_CHAT_ID, lines.join('\n'))
}
