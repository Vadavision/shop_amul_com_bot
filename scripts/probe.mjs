/** Verifies the Amul layer end-to-end without Cloudflare. Usage: node scripts/probe.mjs 380015 */
import { openSession, isInStock, inventoryQuantity, productUrl, CATEGORIES } from '../src/amul.js'

const pincode = process.argv[2] ?? '380015'
const wanted = (process.argv[3] ?? 'protein').split(',')

console.log(`\nProbing pincode ${pincode} · categories: ${wanted.join(', ')}\n`)

const bootstrap = await openSession()
const record = await bootstrap.lookupPincode(pincode)
console.log(`✓ pincode ${pincode} -> substore "${record.substore}"`)

const session = await openSession(record.substore)
console.log('✓ session bound to substore')

const products = await session.products(wanted)
const inStock = products.filter(isInStock)
console.log(`✓ fetched ${products.length} products — ${inStock.length} in stock\n`)

for (const p of products.sort((a, b) => Number(isInStock(b)) - Number(isInStock(a)))) {
  const qty = inventoryQuantity(p)
  console.log(
    `${isInStock(p) ? '✅' : '❌'} ${p.name.padEnd(56).slice(0, 56)} ₹${String(p.price).padStart(5)}${isInStock(p) && qty ? `  (${qty})` : ''}`
  )
}
console.log(`\nExample buy link: ${productUrl(products[0])}`)
