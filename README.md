# amul-watch

Your own Amul stock-notification bot on Telegram. Runs entirely on Cloudflare's
free tier. No server, no database to babysit, no dependency on anyone else's
uptime.

Built after the public `@AmulOSSBot` stopped responding — see
[WHY.md](WHY.md) for what actually broke and what this does differently.

## What it does

- `/setpincode 380015` — resolves your pincode to an Amul substore. Stock is
  regional, so this matters.
- `/products` — browse Protein, Chocolates, Organic, Ghee and Milk. Tap ➕ to
  track anything. In-stock items sort to the top.
- Checks every minute. When something you track flips from out-of-stock to
  in-stock, you get a message with a direct buy link.
- `/check` for stock right now, `/tracked` to manage your list, `/pause` to mute
  without losing anything.

Multi-user from day one: family and friends each get their own pincode and
watchlist, and the bot can be opened to the public by flipping one setting.

## Setup

### 1. Create your Telegram bot

Message [@BotFather](https://t.me/BotFather), send `/newbot`, follow the
prompts. He gives you a token like `123456789:AAH...`.

**Keep that token out of chat windows and commits.** It goes in via
`wrangler secret put`, which never writes it to disk.

### 2. Create the database

```bash
npx wrangler d1 create amul-watch
```

Copy the `database_id` it prints into `wrangler.toml`, then create the tables:

```bash
npm run db:init
```

### 3. Add your secrets

```bash
npx wrangler secret put BOT_TOKEN        # from BotFather
npx wrangler secret put WEBHOOK_SECRET   # any long random string
npx wrangler secret put SETUP_KEY        # any long random string
```

Generate the random ones with `openssl rand -hex 32`.

### 4. Set yourself as admin

Message [@userinfobot](https://t.me/userinfobot) to get your numeric Telegram
ID, then store it as a secret so it never lands in the repo:

```bash
npx wrangler secret put ADMIN_CHAT_ID
```

### 5. Deploy

```bash
npm run deploy
```

### 6. Connect Telegram to the worker

Open this once in a browser, substituting your worker URL and `SETUP_KEY`:

```
https://amul-watch.<your-subdomain>.workers.dev/setup?key=<SETUP_KEY>
```

That registers the webhook and the command menu. Now message your bot `/start`.

## Access control

`ACCESS_MODE` in `wrangler.toml`:

| Mode | Who can use it |
| --- | --- |
| `private` | only `ADMIN_CHAT_ID` |
| `allowlist` | admin, plus anyone you add with `/allow <id>` (**default**) |
| `public` | anyone who finds the bot |

Going public is a one-word change plus `npm run deploy`. Everything else —
per-user pincodes, per-substore batching, the indexes — is already built for it.

Admin commands: `/stats`, `/allow <id>`, `/disallow <id>`.

## Development

```bash
node scripts/probe.mjs 380015 protein   # hit Amul directly, no Cloudflare
npm run dev                             # local worker
npm run tail                            # live production logs
curl "https://<worker>/check?key=<SETUP_KEY>"   # force a sweep
```

## Cost

Free, with room to spare. Cron runs 1,440 times/day against Workers' 100k/day
limit. D1 allows 100k writes/day; snapshots are written only when stock actually
changes.

The one thing that scales with users is Telegram sends, and those are free.
Product fetches are batched **per substore, not per user** — a thousand users in
Gujarat cost exactly one Amul request per sweep.
