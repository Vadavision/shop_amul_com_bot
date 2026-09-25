/**
 * Times as people here read them.
 *
 * Amul only sells in India, so every user of this bot is on IST. Workers run
 * in UTC, so the zone has to be explicit or every time shown is 5½ hours off.
 */
const IST = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
})

/** 1790152889280 -> "23 Sept, 14:01" */
export const formatIst = (ms) => IST.format(new Date(ms))

/** 185000 -> "3 min", 7500000 -> "2 h 5 min" */
export function formatDuration(ms) {
  const minutes = Math.round(ms / 60000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} h ${rest} min` : `${hours} h`
}
