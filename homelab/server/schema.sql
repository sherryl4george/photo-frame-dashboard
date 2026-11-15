-- SQLite schema shared by server.mjs and importer.py. Safe to run repeatedly.
-- photos: the images live on disk under photos/{full,small,bg}/<id>.jpg.
CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  o TEXT NOT NULL,                -- 'p' portrait, 'l' landscape (after rotating upright)
  date TEXT NOT NULL,             -- YYYY-MM-DD taken (EXIF), else file time
  place TEXT NOT NULL DEFAULT '', -- approximate place, e.g. "Issaquah, WA"
  from_id TEXT,
  fav INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  taken_ts INTEGER,               -- seconds since epoch (local EXIF time read as UTC), for neighbours
  lat REAL,                       -- rounded to ~1 km, never shown to the page
  lon REAL,
  place_from TEXT,                -- 'gps', 'neighbour' or ''
  src_hash TEXT UNIQUE,           -- SHA-256 of the original, so a re-run skips what it has
  src_name TEXT,
  proc_ver INTEGER NOT NULL DEFAULT 0 -- importer pipeline version that made the copies; older ones are redone
);
CREATE TABLE IF NOT EXISTS src_files (  -- remembers hashes so a 5-minute run doesn't re-read every original
  path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime_ns INTEGER NOT NULL, hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS photos_date ON photos (date);

CREATE TABLE IF NOT EXISTS groceries (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, cat TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 1,
  store TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0,
  cleared INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY, text TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL DEFAULT 'all',
  created INTEGER NOT NULL, expires INTEGER, cleared INTEGER
);
CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL
);
