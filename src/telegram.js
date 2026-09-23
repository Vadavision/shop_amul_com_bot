/** Thin Telegram Bot API wrapper. */

export class TelegramError extends Error {
  constructor(code, description, method) {
    super(`Telegram ${method} -> ${code}: ${description}`)
    this.name = 'TelegramError'
    this.code = code
    this.description = description
  }
}

/** True when Telegram says this chat can no longer be messaged. */
export function isUnreachable(err) {
  if (!(err instanceof TelegramError)) return false
  if (err.code === 403) return true
  return /chat not found|user is deactivated|bot was blocked/i.test(
    err.description ?? ''
  )
}

export async function call(env, method, payload = {}) {
  const res = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }
  )
  const json = await res.json()
  if (!json.ok) {
    throw new TelegramError(json.error_code, json.description, method)
  }
  return json.result
}

export const send = (env, chatId, text, extra = {}) =>
  call(env, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...extra
  })

export const edit = (env, chatId, messageId, text, extra = {}) =>
  call(env, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...extra
  })

export const answerCallback = (env, id, text = '', alert = false) =>
  call(env, 'answerCallbackQuery', {
    callback_query_id: id,
    text,
    show_alert: alert
  }).catch(() => {}) // expires after ~15s; never worth failing a request over

export const setCommands = (env, commands, scope) =>
  call(env, 'setMyCommands', { commands, ...(scope ? { scope } : {}) })

export const setMenuButton = (env, chatId) =>
  call(env, 'setChatMenuButton', {
    chat_id: chatId,
    menu_button: { type: 'commands' }
  })

/** Escape for Telegram's HTML parse mode. */
export const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export const keyboard = (rows) => ({ reply_markup: { inline_keyboard: rows } })
