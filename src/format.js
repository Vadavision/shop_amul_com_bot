/**
 * Turning Amul product names into button labels.
 *
 * Everything here is structural. There is no table of product names, no
 * curated abbreviations and no per-SKU special cases, because any of those
 * would be wrong the moment Amul ships something new.
 */

/** Strip the brand, flatten separators, and turn "Pack of 30" into "×30". */
export function normalizeName(raw) {
  return String(raw ?? '')
    .replace(/^Amul\s+/i, '')
    .replace(/\s*\|\s*/g, ' ')
    .replace(/Pack of\s*(\d+)\s*(sachets?)?/gi, '×$1')
    .replace(/(\d+)\s+(mL|ml|L|g|kg)\b/g, '$1$2')
    .replace(/,\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The longest run of leading words that every row shares.
 *
 * When a result set is homogeneous — eight flavours of the same milkshake —
 * that run is pure repetition in every button and pushes the one word that
 * matters off the end. Lifting it into the heading buys back the space.
 */
export function commonPrefix(names) {
  if (names.length < 2) return []
  const rows = names.map((n) => n.split(' '))
  const out = []
  for (let i = 0; i < rows[0].length - 1; i++) {
    const word = rows[0][i]
    if (rows.every((r) => r[i]?.toLowerCase() === word.toLowerCase())) out.push(word)
    else break
  }
  return out
}

/**
 * Fit a label to the width a phone actually renders, eliding the middle.
 *
 * Trailing truncation was the original bug: pack size sits at the end of every
 * Amul name, so "…Milkshake | Chocolate, 180 mL | Pack of 8" and its Pack of 30
 * sibling rendered as the same string. Cutting the middle keeps both ends.
 */
export function fit(text, max = 30) {
  if (text.length <= max) return text
  const keepTail = Math.min(12, Math.floor(max / 2))
  const head = text.slice(0, max - keepTail - 1).trimEnd()
  return `${head}…${text.slice(-keepTail).trimStart()}`
}

/** Labels for one screen of products, plus the heading they have in common. */
export function labelsFor(products) {
  const names = products.map((p) => normalizeName(p.name))
  const prefix = commonPrefix(names)
  return {
    heading: prefix.join(' '),
    labels: names.map((n) => n.split(' ').slice(prefix.length).join(' ') || n)
  }
}

/** All query words must appear somewhere in the name or SKU. */
export function matchesQuery(product, query) {
  const hay = `${product.name} ${product.sku}`.toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word))
}

/**
 * Split a product name into its family and its variant.
 *
 * Amul names are consistently "<product>, <size> | Pack of <n>". The part
 * before the first comma or pipe is the thing itself; everything after is
 * which version of it. Grouping on that split is what lets every button stay
 * short enough to read in full: the family names one screen, the variants the
 * next, and neither ever needs truncating.
 */
export function splitFamily(raw) {
  const cleaned = String(raw ?? '').replace(/^Amul\s+/i, '').trim()
  const cut = cleaned.search(/[,|]/)
  if (cut === -1) return { family: cleaned, variant: '' }
  return {
    family: cleaned.slice(0, cut).trim(),
    variant: normalizeName(cleaned.slice(cut + 1))
  }
}

/** Group products under their family, preserving the order they arrived in. */
export function groupFamilies(products) {
  const groups = new Map()
  for (const product of products) {
    const { family } = splitFamily(product.name)
    if (!groups.has(family)) groups.set(family, [])
    groups.get(family).push(product)
  }
  return groups
}

/** Trailing ellipsis. Safe for family names, where the opening words identify
 *  the product and only qualifiers sit at the end. */
export function fitEnd(text, max = 34) {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

/**
 * Pull out words shared by every variant of a family.
 *
 * If all eight milkshakes say "180mL", that word distinguishes nothing and is
 * costing eight buttons the space their price needs. Lift it into the header
 * and the labels fit. Returns the shared words and the reduced labels; if
 * reducing would blank a label, nothing is removed.
 */
export function factorCommon(variants) {
  if (variants.length < 2) return { common: '', rest: variants }
  const tokens = variants.map((v) => v.split(' ').filter(Boolean))
  const shared = tokens[0].filter((word) => tokens.every((t) => t.includes(word)))
  if (!shared.length) return { common: '', rest: variants }

  const rest = tokens.map((t) => t.filter((w) => !shared.includes(w)).join(' '))
  if (rest.some((r) => !r)) return { common: '', rest: variants }
  return { common: shared.join(' '), rest }
}
