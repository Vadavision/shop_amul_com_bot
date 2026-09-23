/**
 * Amul shop client.
 *
 * shop.amul.com is a StoreHippo storefront behind Cloudflare. Every data call
 * needs three things: the Cloudflare bot cookies, a session TID from info.js,
 * and a per-request SHA-256 `tid` signature header. Miss the signature and the
 * product endpoint returns a bare 401 "Unauthorized".
 */

const SHOP = 'https://shop.amul.com'
const STORE_ID = '62fa94df8c13af2e242eba16'
const DEFAULT_STORE_VERSION = 6

// Only what the bot actually renders. Every extra field is payload to
// download and parse on a request budget measured in milliseconds.
const PRODUCT_FIELDS = [
  'name', 'categories', 'alias', 'sku', 'price', 'available',
  'inventory_quantity', 'inventory_low_stock_quantity',
  'inventory_allow_out_of_stock'
]

const BASE_HEADERS = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.9,hi;q=0.8',
  base_url: `${SHOP}/en/browse/protein`,
  frontend: '1',
  referer: `${SHOP}/en/browse/protein`,
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'
}

/** "milk-powders" -> "Milk Powders". Derived, never looked up. */
export const labelForCategory = (id) =>
  String(id ?? '')
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')

export class AmulError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'AmulError'
    this.code = code
  }
}

export class AmulSession {
  constructor() {
    this.jar = new Map()
    this.tid = null
    this.storeVersion = DEFAULT_STORE_VERSION
    this.substore = null
  }

  #cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  async #request(url, { method = 'GET', headers = {}, body } = {}) {
    const cookie = this.#cookieHeader()
    const res = await fetch(url, {
      method,
      headers: {
        ...BASE_HEADERS,
        ...headers,
        ...(cookie ? { cookie } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'follow'
    })

    // Workers and Node 20+ both expose getSetCookie(); fall back defensively.
    const setCookies = res.headers.getSetCookie
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean)

    for (const raw of setCookies) {
      const match = raw.match(/^([^=]+)=([^;]*)/)
      if (match) this.jar.set(match[1].trim(), match[2])
    }

    if (res.status >= 400) {
      throw new AmulError(
        `Amul ${method} ${new URL(url).pathname} -> HTTP ${res.status}`,
        res.status
      )
    }
    return res
  }

  /** Signature header Amul requires on every data endpoint. */
  async #tidHeader() {
    if (!this.tid) throw new AmulError('Session not initialised', 'NO_SESSION')
    const ts = Date.now().toString()
    const rand = Math.floor(Math.random() * 1000)
    const payload = `${STORE_ID}:${ts}:${rand}:${this.tid}`
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(payload)
    )
    const hash = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    return `${ts}:${rand}:${hash}`
  }

  /**
   * Open a session.
   *
   * `/user/info.js` hands back the Cloudflare cookies and the session TID in
   * one ~1KB response, so the browse page is not needed. Passing a known
   * `storeVersion` also skips `storeinfo.js`, a 184KB script fetched purely to
   * regex one number out of it — together those were 99% of the bytes a
   * restock sweep moved.
   */
  async init({ storeVersion = null } = {}) {
    const res = await this.#request(`${SHOP}/user/info.js?_v=${Date.now()}`)
    if (!this.jar.size) {
      throw new AmulError('Amul issued no cookies', 'NO_COOKIES')
    }
    const text = await res.text()
    const session = JSON.parse(text.replace('session = ', ''))
    if (!session.tid) throw new AmulError('No TID in session info', 'NO_TID')
    this.tid = session.tid

    if (storeVersion) this.storeVersion = storeVersion
    else await this.#loadStoreVersion()
    return this
  }

  get version() {
    return this.storeVersion
  }

  async #loadStoreVersion() {
    try {
      const res = await this.#request(
        `${SHOP}/ms/store/amul/auto/EN/storeinfo.js`
      )
      const match = (await res.text()).match(
        /req\.query\.v\s*=\s*['"]?([^'";\s]+)['"]?/
      )
      const version = Number(match?.[1])
      if (Number.isFinite(version) && version > 0) this.storeVersion = version
    } catch {
      // Non-fatal: the default version has been stable for a long time.
    }
  }

  /** Resolve a 6-digit pincode to its substore, e.g. 380015 -> "gujarat". */
  async lookupPincode(pincode) {
    const url =
      `${SHOP}/entity/pincode?limit=50&filters[0][field]=pincode` +
      `&filters[0][value]=${encodeURIComponent(pincode)}` +
      `&filters[0][operator]=regex&cf_cache=1h`
    const res = await this.#request(url, {
      headers: { tid: await this.#tidHeader() }
    })
    const records = (await res.json()).records ?? []
    if (!records.length) {
      throw new AmulError(`No Amul substore serves ${pincode}`, 'PINCODE_NOT_FOUND')
    }
    return records[0]
  }

  /** Bind this session to a substore. Inventory is per-substore. */
  async setSubstore(substore) {
    await this.#request(`${SHOP}/entity/ms.settings/_/setPreferences`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        tid: await this.#tidHeader()
      },
      body: { data: { store: substore } }
    })
    this.substore = substore
  }

  /**
   * Every product the store will return.
   *
   * No category filter by default. Filtering to a known list meant the bot
   * only ever saw the categories it was told about at build time — on this
   * store that was 5 of 16, hiding roughly half the catalogue. Amul exposes
   * no category endpoint and no facets, so the honest source of truth is the
   * products themselves.
   */
  async products(options = {}) {
    // Back-compat: an array argument used to mean category ids.
    const { categories = null, skus = null } = Array.isArray(options)
      ? { categories: options }
      : options

    const collected = []
    let start = 0

    for (let guard = 0; guard < 20; guard++) {
      const params = new URLSearchParams()
      for (const field of PRODUCT_FIELDS) params.append(`fields[${field}]`, '1')

      // Filtering by sku is what keeps the cron sweep small: checking two
      // watched products costs ~1.5KB instead of the 114KB full catalogue.
      const filter = skus?.length
        ? { field: 'sku', values: skus }
        : categories?.length
          ? { field: 'categories', values: categories }
          : null

      if (filter) {
        params.append('filters[0][field]', filter.field)
        filter.values.forEach((v, i) => params.append(`filters[0][value][${i}]`, v))
        params.append('filters[0][operator]', 'in')
        params.append('filters[0][original]', '1')
      }

      params.append('limit', '250')
      params.append('total', '1')
      params.append('start', String(start))
      params.append('v', String(this.storeVersion))
      params.append('device_type', 'other')

      // StoreHippo returns different inventory when the nested brackets are
      // percent-encoded, so send them raw.
      const query = params.toString().replace(/%5B/g, '[').replace(/%5D/g, ']')
      const res = await this.#request(`${SHOP}/api/1/entity/ms.products?${query}`, {
        headers: { tid: await this.#tidHeader() }
      })

      const json = await res.json()
      if (!Array.isArray(json.data)) {
        throw new AmulError('Product response had no data array', 'BAD_SHAPE')
      }

      collected.push(...json.data)
      const total = json.paging?.total ?? collected.length
      if (!json.data.length || collected.length >= total) break
      start += json.data.length
    }

    return collected
  }

  /**
   * Categories actually present in the catalogue, derived from the products.
   * New Amul ranges appear on their own; retired ones disappear.
   */
  async categories() {
    const counts = new Map()
    for (const product of await this.products()) {
      for (const id of product.categories ?? []) {
        counts.set(id, (counts.get(id) ?? 0) + 1)
      }
    }
    return [...counts.entries()]
      .map(([id, count]) => ({ id, label: labelForCategory(id), count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  }
}

/** Open a session already bound to a substore. */
export async function openSession(substore, options = {}) {
  const session = await new AmulSession().init(options)
  if (substore) await session.setSubstore(substore)
  return session
}

const allowsOutOfStock = (p) =>
  'inventory_allow_out_of_stock' in p &&
  p.inventory_allow_out_of_stock !== '0' &&
  p.inventory_allow_out_of_stock !== 0

/** Mirrors the upstream bot's stock maths so alerts agree with the website. */
export function inventoryQuantity(p) {
  if (p.inventory_low_stock_quantity > p.inventory_quantity && !allowsOutOfStock(p)) {
    return 0
  }
  return p.inventory_quantity < 0
    ? 0
    : p.inventory_quantity - p.inventory_low_stock_quantity
}

export function isInStock(p) {
  if (allowsOutOfStock(p)) return true
  if (p.available <= 0) return false
  if (inventoryQuantity(p) <= 0) return false
  return p.inventory_quantity >= p.inventory_low_stock_quantity
}

export function productUrl(p) {
  return `${SHOP}/en/product/${String(p.alias ?? '').replace(/ /g, '')}`
}
