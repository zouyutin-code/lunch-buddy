-- Lunch Buddy family sharing. Apply with:
--   npx wrangler d1 execute lunch-buddy --remote --file schema.sql
-- Stored: nicknames, lunch add-on picks, push subscriptions, each member's own app backup
-- (ideas, badges, game points), and personal backups for phones not in a family (no name,
-- just a random key). The API also creates the backup tables on first use.

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

-- One backup per member: the app's saved data as JSON, replaced on each save.
CREATE TABLE IF NOT EXISTS backups (
  member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL,
  data TEXT NOT NULL,
  size INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One-time codes (stored hashed) that move a member to a new phone.
CREATE TABLE IF NOT EXISTS move_codes (
  code_hash TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS move_codes_member ON move_codes(member_id);

-- Personal backups for phones that aren't in a family. Deleted after 400 days without use.
CREATE TABLE IF NOT EXISTS vaults (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS vaults_updated ON vaults(updated_at);

-- One-time codes (stored hashed) that move a personal backup to a new phone.
CREATE TABLE IF NOT EXISTS vault_codes (
  code_hash TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS vault_codes_vault ON vault_codes(vault_id);

-- Simple rate limiting for create/join attempts and backups.
CREATE TABLE IF NOT EXISTS rate (
  key TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_key ON rate(key, ts);
CREATE INDEX IF NOT EXISTS rate_ts ON rate(ts);
