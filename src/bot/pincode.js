/**
 * Where the user is. Stock is regional, so nothing works until this is set.
 */
import { openSession, AmulError } from '../amul.js'
import * as db from '../db.js'
import { send, esc } from '../telegram.js'
import { mainKeyboard } from './ui.js'

export async function askPincode(env, chatId) {
  return send(
    env,
    chatId,
    [
      '📍 <b>Which area should I check?</b>',
      '',
      'Amul stocks different things in different regions.',
      '',
      'Type your <b>6-digit pincode</b>, or tap the button to share your location.'
    ].join('\n'),
    {
      reply_markup: {
        keyboard: [[{ text: '📍 Share my location', request_location: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
        input_field_placeholder: 'e.g. 380015'
      }
    }
  )
}

/** Reverse-geocode a shared location to a pincode, or null if there is none. */
export async function pincodeFromLocation(lat, lon) {
  const res = await fetch(
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=18&addressdetails=1`,
    { headers: { 'user-agent': 'amul-watch/1.0 (personal Amul restock notifier)', 'accept-language': 'en' } }
  )
  if (!res.ok) return null
  const postcode = (await res.json()).address?.postcode?.replace(/\s+/g, '')
  return /^\d{6}$/.test(postcode ?? '') ? postcode : null
}

/** True when the user has an area; otherwise asks for one and returns false. */
export async function requirePincode(env, chatId, user) {
  if (user.substore) return true
  await askPincode(env, chatId)
  return false
}

export async function setPincode(env, chatId, input) {
  const pincode = input.trim()
  if (!pincode) return askPincode(env, chatId)
  if (!/^\d{6}$/.test(pincode)) {
    return send(env, chatId, `❌ <b>${esc(pincode)}</b> is not a 6-digit pincode.`)
  }

  try {
    const record = await (await openSession()).lookupPincode(pincode)
    await db.setPincode(env, chatId, pincode, record.substore)
    return send(
      env,
      chatId,
      [
        `✅ Set to <b>${esc(pincode)}</b> · ${esc(record.substore)} store.`,
        '',
        '<b>Now just type what you want.</b>',
        'For example <code>whey</code>, <code>lassi</code> or <code>paneer</code>.'
      ].join('\n'),
      { reply_markup: mainKeyboard() }
    )
  } catch (err) {
    if (err instanceof AmulError && err.code === 'PINCODE_NOT_FOUND') {
      return send(env, chatId, `❌ Amul does not deliver to <b>${esc(pincode)}</b>. Try a nearby pincode.`)
    }
    throw err
  }
}
