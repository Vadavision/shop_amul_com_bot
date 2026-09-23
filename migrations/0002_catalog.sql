-- Short-lived per-substore product cache.
-- Fetching the catalogue costs ~2.5s; doing it inline on a button tap blew past
-- Telegram's callback timeout, so taps appeared to do nothing.
CREATE TABLE IF NOT EXISTS catalog (
  substore   TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
