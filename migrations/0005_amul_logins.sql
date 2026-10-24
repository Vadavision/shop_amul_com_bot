-- Migration number: 0005 	 per-user Amul logins for auto add-to-cart
--
-- Each user who sends /amullogin gets their own row, so the bot fills each
-- user's own Amul cart. `jsessionid` is AES-GCM ciphertext (src/crypto.js) bound
-- to the chat_id; the key is a Worker secret and never in this database.
CREATE TABLE IF NOT EXISTS amul_logins (
  chat_id    INTEGER PRIMARY KEY,
  jsessionid TEXT    NOT NULL,
  saved_at   INTEGER NOT NULL,
  checked_at INTEGER NOT NULL,
  expired    INTEGER NOT NULL DEFAULT 0
);

-- The keep-alive picks the live login checked longest ago.
CREATE INDEX IF NOT EXISTS idx_amul_logins_due ON amul_logins (expired, checked_at);
