# Why this exists

The public `@AmulOSSBot` is genuinely good software and is still actively
maintained. This is not a fork out of spite — it is a fork out of not wanting a
single point of failure between me and whey protein.

## What I verified

Running the upstream code locally against live Amul on 2026-09-20:

- The repo is **not** abandoned — last commit 2026-08-30.
- The hosted bot is **up** — its status endpoint queries MongoDB and answers.
- Amul's API is **not** broken — the upstream client fetched 88 products and
  real inventory without a single change.

So the bot being silent for one user was never a code or upstream problem.

## The design flaw worth avoiding

In `withCatchAsync.util.ts` and again in `broadcast.queue.ts`, upstream reacts to
a single Telegram 403 like this:

```js
const deleteUser = await UserModel.findOneAndDelete({ tgId: ctx.from?.id })
await ProductModel.deleteMany({ trackedBy: deleteUser?._id })
```

Telegram returns 403 for a blocked bot, a stopped bot, a deactivated account —
and transiently for reasons outside your control. When it happens, the user row
**and every tracked product** are destroyed. There is no soft-delete, no
recovery, and no way to tell the user, because the channel used to tell them is
the one that just failed.

The result: the bot goes quiet forever, and looks broken rather than empty.

**Here:** a 403 sets `is_blocked = 1` and nothing else. Unblock the bot, send any
message, and your entire watchlist is exactly where you left it.

## Other differences

| | upstream | here |
| --- | --- | --- |
| Infra | MongoDB + Redis + Bull + Express | one Worker + D1 |
| Scope | 28k users, payments, admin console | you and whoever you invite |
| Data loss on 403 | user + watchlist deleted | flag flipped, nothing lost |
| Baseline alerting | — | first sweep of a substore records silently, no alert storm |

## Credit

The hard part — the Cloudflare cookie dance, the session TID, and the SHA-256
`tid` signature that Amul's product endpoint demands — was reverse-engineered by
[SwapnilSoni1999](https://github.com/SwapnilSoni1999/amul-notify). This
reimplements that protocol knowledge on different infrastructure. If you want
the full-featured public bot, use [@AmulOSSBot](https://t.me/AmulOSSBot).
