-- Lunch Buddy family sharing. Apply with:
--   npx wrangler d1 execute lunch-buddy --remote --file schema.sql
-- Stored: nicknames, lunch add-on picks, kids' after-school plans, parents' notes and kids' replies, push subscriptions, each member's own app backup
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

-- Kids' after-school plans (Flight Plan tab), shared with their family's parents. Kept 120 days.
CREATE TABLE IF NOT EXISTS plans (
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL,
  day TEXT NOT NULL,
  blocks TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (member_id, day)
);
CREATE INDEX IF NOT EXISTS plans_family_day ON plans(family_id, day);

-- A parent's note of encouragement to a kid for one day, and the kid's reply. Kept 120 days.
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  kid_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  parent_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  text TEXT NOT NULL,
  reply TEXT,
  reply_at INTEGER,
  kid_seen INTEGER NOT NULL DEFAULT 0,
  parent_seen INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (kid_id, parent_id, day)
);
CREATE INDEX IF NOT EXISTS notes_kid_day ON notes(kid_id, day);
CREATE INDEX IF NOT EXISTS notes_parent ON notes(parent_id, parent_seen);

-- Simple rate limiting for create/join attempts and backups.
CREATE TABLE IF NOT EXISTS rate (
  key TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_key ON rate(key, ts);
CREATE INDEX IF NOT EXISTS rate_ts ON rate(ts);

-- Family Rhythm (the shared day on the Plan tab and the weekly review in the Nest). The API also creates
-- these on first use. Day-based rows are kept 120 days; the board keeps each family's latest 50 posts.
CREATE TABLE IF NOT EXISTS tasks (          -- the day's schedule: plans, family events, after-school activities
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  title TEXT NOT NULL,
  tm TEXT NOT NULL DEFAULT '',              -- start time HH:MM, or '' for flexible
  est INTEGER NOT NULL DEFAULT 30,          -- planned minutes
  actual INTEGER NOT NULL DEFAULT 0,        -- minutes it really took
  priority TEXT NOT NULL DEFAULT 'must',    -- must | like
  kind TEXT NOT NULL DEFAULT 'plan',        -- plan | family | activity
  pinned INTEGER NOT NULL DEFAULT 0,        -- the day's highlight (one per family per day)
  goal_id TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_family_day ON tasks(family_id, day);

CREATE TABLE IF NOT EXISTS meals (          -- breakfast and dinner ideas, votes and the chosen dish
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  day TEXT NOT NULL,
  slot TEXT NOT NULL,                       -- breakfast | dinner
  title TEXT NOT NULL,
  chosen INTEGER NOT NULL DEFAULT 0,
  votes TEXT NOT NULL DEFAULT '[]',         -- JSON array of member ids
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS meals_family_day ON meals(family_id, day);

CREATE TABLE IF NOT EXISTS credits (        -- points a parent gives a kid for a day, −3 to +3 with a reason
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  kid_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  item TEXT NOT NULL DEFAULT '',            -- breakfast | dinner | sleep | plan | '' (custom)
  reason TEXT NOT NULL,
  points INTEGER NOT NULL,
  by_id TEXT NOT NULL,                      -- the parent who gave it
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS credits_family_day ON credits(family_id, day);
CREATE INDEX IF NOT EXISTS credits_kid_day ON credits(kid_id, day);

CREATE TABLE IF NOT EXISTS goals (          -- a kid's goals for one week (week = its Monday)
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  week TEXT NOT NULL,
  title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS goals_family_week ON goals(family_id, week);

CREATE TABLE IF NOT EXISTS reflections (    -- what went well / what to adjust, about a kid's week, by the kid or a parent
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  week TEXT NOT NULL,
  win TEXT NOT NULL DEFAULT '',
  adjust TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (member_id, author_id, week)
);
CREATE INDEX IF NOT EXISTS reflections_family_week ON reflections(family_id, week);

CREATE TABLE IF NOT EXISTS board (          -- the family board
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS board_family ON board(family_id, created_at);
