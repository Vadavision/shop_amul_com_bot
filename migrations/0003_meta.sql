-- Small key/value store for things that rarely change, so a frequent job does
-- not have to re-derive them. storeVersion lives here: discovering it means
-- downloading a 184KB script, which dwarfed everything else in a sweep.
CREATE TABLE IF NOT EXISTS meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
