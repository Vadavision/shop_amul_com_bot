-- Migration number: 0004 	 stock change log
--
-- The bot used to keep only the latest state of each product, so "did it come
-- back while I wasn't looking?" had no answer. Every change a sweep sees is now
-- written here. Rows are only written on change, so this stays small.
CREATE TABLE IF NOT EXISTS stock_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  substore  TEXT    NOT NULL,
  sku       TEXT    NOT NULL,
  name      TEXT    NOT NULL,
  in_stock  INTEGER NOT NULL,
  quantity  INTEGER NOT NULL,
  at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stock_events_lookup ON stock_events (substore, sku, at);

-- When recording began, so the history screen can say how far back it reaches
-- instead of implying nothing happened before it.
INSERT OR IGNORE INTO meta (key, value, updated_at)
VALUES ('history_since', CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
