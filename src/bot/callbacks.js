/**
 * Inline-button taps.
 *
 * Callback data is "<action>:<payload…>". Taps on product and size buttons
 * carry the screen they came from as trailing context, so after a change the
 * same screen can be redrawn in place.
 */
import { answerCallback } from '../telegram.js'
import { requirePincode, askPincode } from './pincode.js'
import { showStart } from './home.js'
import { showSearch, showFamily, showCategories, showCategory, watchAllSizes } from './browse.js'
import { showWatchlist, showCheck, setWatching } from './watchlist.js'
import { showHistory } from './history.js'

/**
 * Callback formats used by earlier versions of this bot.
 *
 * Messages already sitting in a chat keep whatever buttons they were sent
 * with, so a deploy that renames callbacks silently breaks every menu still on
 * screen: the tap is answered, nothing happens, and the button appears dead.
 * Old names are mapped forward rather than dropped.
 */
const LEGACY_ACTIONS = {
  trk: 't',
  untrk: 'u',
  track: 't',
  untrack: 'u',
  cat: 'c',
  picks: 'cats',
  pick: 'cats'
  // 'trkall' is deliberately absent: its payload was a category id, but the
  // current bulk-watch action keys off an anchor SKU. Mapping it would look
  // like it worked and quietly track nothing, so it self-heals instead.
}

/** Redraw whichever screen the tap came from, so context is never lost. */
function redraw(env, chatId, messageId, user, ctx) {
  const [kind, a, b] = ctx.split(':')
  if (kind === 'f') return showFamily(env, chatId, messageId, user, a, ctx.split(':').slice(2).join(':'))
  if (kind === 'q') return showSearch(env, chatId, messageId, user, a, 0)
  if (kind === 'c') return showCategory(env, chatId, messageId, user, a, Number(b) || 0)
  // 'l' is the watchlist. Buttons from older versions carried a category name
  // here instead; the watchlist is where they land.
  return showWatchlist(env, chatId, messageId, user)
}

export async function handleCallback(env, cq, user) {
  const chatId = cq.message.chat.id
  const messageId = cq.message.message_id
  const [rawAction, ...parts] = cq.data.split(':')
  const action = LEGACY_ACTIONS[rawAction] ?? rawAction

  switch (action) {
    case 'home':
      await answerCallback(env, cq.id)
      return showStart(env, chatId, user)
    case 'tracked':
      await answerCallback(env, cq.id)
      return showWatchlist(env, chatId, messageId, user)
    case 'hist':
      await answerCallback(env, cq.id)
      return showHistory(env, chatId, messageId, user)
    case 'check':
      await answerCallback(env, cq.id, 'Checking…')
      return showCheck(env, chatId, user)
    case 'cats':
      await answerCallback(env, cq.id, 'Loading…')
      if (!(await requirePincode(env, chatId, user))) return
      return showCategories(env, chatId, messageId, user)
    case 'c':
      await answerCallback(env, cq.id)
      return showCategory(env, chatId, messageId, user, parts[0], Number(parts[1]) || 0)
    case 's':
      await answerCallback(env, cq.id)
      return showSearch(env, chatId, messageId, user, parts.slice(1).join(':'), Number(parts[0]) || 0)
    case 'f':
      await answerCallback(env, cq.id)
      return showFamily(env, chatId, messageId, user, parts[0], parts.slice(1).join(':'))

    case 'A': {
      const added = await watchAllSizes(env, chatId, user, parts[0])
      if (added === null) {
        await answerCallback(env, cq.id, 'That product is no longer listed', true)
        return showWatchlist(env, chatId, messageId, user)
      }
      await answerCallback(env, cq.id, `🔔 Watching ${added} more`)
      return showFamily(env, chatId, messageId, user, parts[0], parts.slice(1).join(':'))
    }

    case 't':
    case 'u': {
      const [sku, ...ctx] = parts
      // Answered after the change, because Telegram takes only one answer per
      // tap and it has to say what actually happened. This is quick: the
      // catalogue is read from cache, not fetched.
      const done = await setWatching(env, chatId, user, sku, action === 't')
      await answerCallback(
        env,
        cq.id,
        done ? (action === 't' ? '🔔 Added' : 'Removed') : 'That product is no longer listed',
        !done
      )
      return redraw(env, chatId, messageId, user, ctx.join(':'))
    }

    default:
      // An unrecognised tap means this menu predates a format change. Say so
      // and hand over a working one instead of leaving a dead button.
      await answerCallback(env, cq.id, 'This menu is out of date — opening a fresh one', true)
      return user.substore ? showCategories(env, chatId, null, user) : askPincode(env, chatId)
  }
}
