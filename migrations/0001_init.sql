CREATE TABLE IF NOT EXISTS users (
  chat_id    INTEGER PRIMARY KEY,
  username   TEXT,
  first_name TEXT,
  pincode    TEXT,
  substore   TEXT,
  is_blocked INTEGER NOT NULL DEFAULT 0,
  is_paused  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS tracks (
  chat_id    INTEGER NOT NULL,
  sku        TEXT NOT NULL,
  name       TEXT,
  created_at INTEGER,
  PRIMARY KEY (chat_id, sku)
);

CREATE TABLE IF NOT EXISTS snapshots (
  substore   TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS allowlist (
  chat_id    INTEGER PRIMARY KEY,
  note       TEXT,
  created_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_users_substore ON users (substore, is_blocked, is_paused);
CREATE INDEX IF NOT EXISTS idx_tracks_sku ON tracks (sku);
