-- Lunch Buddy family sharing. Apply with:
--   npx wrangler d1 execute lunch-buddy --remote --file schema.sql
-- Only nicknames, lunch add-on picks and push subscriptions are stored.

CREATE TABLE IF NOT EXISTS families (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  nickname TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('parent', 'kid')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active')),
  token_hash TEXT NOT NULL UNIQUE,
  last_seen_event INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS members_family ON members(family_id);

-- One row per member per school day: the add-ons they plan to pack.
CREATE TABLE IF NOT EXISTS addons (
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL,
  day TEXT NOT NULL,
  items TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (member_id, day)
);
CREATE INDEX IF NOT EXISTS addons_family_day ON addons(family_id, day);

-- The family activity list (and what the bell counts).
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id TEXT NOT NULL,
  member_id TEXT,
  kind TEXT NOT NULL,
  day TEXT,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_family ON events(family_id, id);

CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_member ON push_subs(member_id);

-- Simple rate limiting for create/join attempts.
CREATE TABLE IF NOT EXISTS rate (
  key TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_key ON rate(key, ts);
