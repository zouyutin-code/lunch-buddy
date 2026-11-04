// Lunch Buddy API (Cloudflare Pages Function, D1 binding `DB`).
// Family members hold a random member token (sent as `Authorization: Bearer ...`).
// Phones that aren't in a family hold a random personal backup ("vault") token instead.
// Only SHA-256 hashes of tokens are stored. No emails or passwords: just nicknames.
import { sendPush, isPushEndpoint } from '../../lib/webpush.js';

const MAX_MEMBERS = 12;
const MAX_PENDING = 5;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MAX_BACKUP = 300000;          // characters of JSON per member
const MOVE_TTL = 15 * 60 * 1000;    // move codes work once, for 15 minutes
const VAULT_IDLE = 400 * 86400000;  // personal backups untouched this long are deleted
const KEEP_DAYS = 120;              // after-school plans and notes older than this are deleted
const ACT_RE = /^[a-z]{2,12}$/;

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
});

const now = () => Date.now();
const uid = () => crypto.randomUUID();
function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256hex(s) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
}
function randomCode(n = 6) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map((x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('');
}

// Backup tables are created on first use, so an existing database needs no manual migration.
let tablesReady = null;
function ensureBackupTables(env) {
  if (!tablesReady) {
    tablesReady = env.DB.batch([
      env.DB.prepare('CREATE TABLE IF NOT EXISTS backups (member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE, family_id TEXT NOT NULL, data TEXT NOT NULL, size INTEGER NOT NULL, updated_at INTEGER NOT NULL)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS move_codes (code_hash TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE, created_by TEXT NOT NULL, expires_at INTEGER NOT NULL)'),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS move_codes_member ON move_codes(member_id)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS vaults (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, data TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)'),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS vaults_updated ON vaults(updated_at)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS vault_codes (code_hash TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL)'),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS vault_codes_vault ON vault_codes(vault_id)'),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS rate_ts ON rate(ts)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS plans (member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE, family_id TEXT NOT NULL, day TEXT NOT NULL, blocks TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (member_id, day))'),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS plans_family_day ON plans(family_id, day)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, family_id TEXT NOT NULL, kid_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE, parent_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE, day TEXT NOT NULL, text TEXT NOT NULL, reply TEXT, reply_at INTEGER, kid_seen INTEGER NOT NULL DEFAULT 0, parent_seen INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (kid_id, parent_id, day))'),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS notes_kid_day ON notes(kid_id, day)'),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS notes_parent ON notes(parent_id, parent_seen)')
    ]).catch((e) => { tablesReady = null; throw e; });
  }
  return tablesReady;
}
function backupText(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'bad_backup', 'Bad backup');
  const text = JSON.stringify(data);
  if (text.length > MAX_BACKUP) throw new HttpError(413, 'too_big', 'This backup is too big to save.');
  return text;
}
async function vaultAuth(env, request) {
  const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(request.headers.get('authorization') || '');
  const v = m && await env.DB.prepare('SELECT id FROM vaults WHERE token_hash = ?').bind(await sha256hex(m[1])).first();
  if (!v) throw new HttpError(401, 'no_vault', 'This backup was moved to another phone or has expired.');
  return v;
}
// Trim, collapse whitespace, drop control characters; reject empty or too long.
function clean(v, max, label) {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (!s) throw new HttpError(400, 'missing', `${label} is required`);
  if (s.length > max) throw new HttpError(400, 'too_long', `${label} must be ${max} characters or fewer`);
  return s;
}
function dayLabel(day) {
  const d = new Date(day + 'T12:00:00Z');
  return `${DOW[d.getUTCDay()]}, ${MON[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
function listText(items) {
  if (items.length <= 2) return items.join(' and ');
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}

async function limit(env, key, max, windowSec) {
  const t = now();
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM rate WHERE key = ? AND ts > ?').bind(key, t - windowSec * 1000).first();
  if (row.n >= max) throw new HttpError(429, 'slow_down', 'Too many tries. Wait a little and try again.');
  await env.DB.batch([
    env.DB.prepare('INSERT INTO rate (key, ts) VALUES (?, ?)').bind(key, t),
    env.DB.prepare('DELETE FROM rate WHERE ts < ?').bind(t - 86400000)
  ]);
}
// A day's after-school plan: half-hour blocks {s: start slot 0-13, n: length, a: activity id, t: own name for "other", d: done}.
function cleanBlocks(v) {
  if (!Array.isArray(v) || v.length > 14) throw new HttpError(400, 'bad_plan', 'Bad plan');
  const used = Array(14).fill(false), out = [];
  for (const b of v) {
    const s = Math.floor(Number(b && b.s)), n = Math.floor(Number(b && b.n)), a = String((b && b.a) || '');
    if (!(s >= 0 && n >= 1 && s + n <= 14) || !ACT_RE.test(a)) throw new HttpError(400, 'bad_plan', 'Bad plan');
    for (let j = s; j < s + n; j++) { if (used[j]) throw new HttpError(400, 'bad_plan', 'Activities overlap'); used[j] = true; }
    const x = { s, n, a, d: b.d ? 1 : 0 };
    if (a === 'other') x.t = clean(b.t, 24, 'Activity name');
    out.push(x);
  }
  return out.sort((p, q) => p.s - q.s);
}
function dayArg(v) {
  const day = String(v || '');
  if (!DAY_RE.test(day) || isNaN(new Date(day + 'T12:00:00Z'))) throw new HttpError(400, 'bad_day', 'Bad date');
  return day;
}
function rangeArgs(url) {
  const start = dayArg(url.searchParams.get('start')), end = dayArg(url.searchParams.get('end'));
  if (end < start || (new Date(end + 'T12:00:00Z') - new Date(start + 'T12:00:00Z')) > 62 * 86400000) throw new HttpError(400, 'bad_range', 'Bad date range');
  return { start, end };
}
const oldDay = () => new Date(now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
// The kid a request is about: yourself if you're a kid, or (for parents) an active kid in your family.
async function kidFor(env, me, kidId) {
  if (me.role === 'kid') {
    if (kidId && kidId !== me.id) throw new HttpError(403, 'not_yours', 'You can only see your own plan.');
    return me;
  }
  const kid = await env.DB.prepare("SELECT id, nickname FROM members WHERE id = ? AND family_id = ? AND role = 'kid' AND status = 'active'").bind(String(kidId || ''), me.family_id).first();
  if (!kid) throw new HttpError(404, 'no_kid', 'That kid isn’t in your family anymore.');
  return kid;
}
async function notifyMember(env, memberId, payload, waitUntil) {
  if (!env.VAPID_PRIVATE_JWK) return;
  const { results } = await env.DB.prepare('SELECT * FROM push_subs WHERE member_id = ?').bind(memberId).all();
  if (results.length) waitUntil(Promise.all(results.map((s) => deliver(env, s, payload))));
}
const ipOf = (request) => request.headers.get('cf-connecting-ip') || 'local';

async function auth(env, request, { active = true, parent = false } = {}) {
  const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(request.headers.get('authorization') || '');
  if (!m) throw new HttpError(401, 'no_session', 'This device is not in a family yet.');
  const me = await env.DB.prepare(
    'SELECT m.*, f.name AS family_name, f.code AS family_code FROM members m JOIN families f ON f.id = m.family_id WHERE m.token_hash = ?'
  ).bind(await sha256hex(m[1])).first();
  if (!me) throw new HttpError(401, 'no_session', 'This device is no longer in a family.');
  if (active && me.status !== 'active') throw new HttpError(403, 'pending', 'Waiting for a parent to approve you.');
  if (parent && me.role !== 'parent') throw new HttpError(403, 'parents_only', 'Only parents can do that.');
  return me;
}

function addEvent(env, me, kind, data, day = null) {
  return env.DB.prepare('INSERT INTO events (family_id, member_id, kind, day, data, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(me.family_id, me.id, kind, day, JSON.stringify({ who: me.nickname, role: me.role, ...data }), now());
}

// Push to every active parent in the family except the person who acted.
async function notifyParents(env, me, payload, waitUntil) {
  if (!env.VAPID_PRIVATE_JWK) return;
  const { results } = await env.DB.prepare(
    "SELECT s.* FROM push_subs s JOIN members m ON m.id = s.member_id WHERE m.family_id = ? AND m.role = 'parent' AND m.status = 'active' AND m.id <> ?"
  ).bind(me.family_id, me.id).all();
  if (results.length) waitUntil(Promise.all(results.map((s) => deliver(env, s, payload))));
}
async function deliver(env, sub, payload) {
  try {
    const r = await sendPush(env, sub, payload);
    if (r.status === 404 || r.status === 410) {
      await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(sub.endpoint).run();
    } else if (!r.ok) {
      console.error('push failed', r.status, await r.text());
    }
    return r.status;
  } catch (e) {
    console.error('push error', e);
    return 0;
  }
}

async function state(env, me) {
  const active = me.status === 'active';
  let members = [];
  let unread = 0;
  let pushOn = false;
  let notes = { notesNew: 0, notesDay: null, notesKid: null };
  if (active) {
    const q = me.role === 'parent'
      ? 'SELECT id, nickname, role, status FROM members WHERE family_id = ? ORDER BY status, created_at'
      : "SELECT id, nickname, role, status FROM members WHERE family_id = ? AND status = 'active' ORDER BY created_at";
    members = (await env.DB.prepare(q).bind(me.family_id).all()).results;
    unread = (await env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE family_id = ? AND id > ? AND (member_id IS NULL OR member_id <> ?)')
      .bind(me.family_id, me.last_seen_event, me.id).first()).n;
    pushOn = !!(await env.DB.prepare('SELECT 1 AS x FROM push_subs WHERE member_id = ? LIMIT 1').bind(me.id).first());
    // New notes from home (kids) or new replies to your notes (parents), with the newest one's day to jump to.
    await ensureBackupTables(env);
    const nq = me.role === 'kid'
      ? 'SELECT COUNT(*) AS n, MAX(day) AS day, NULL AS kid FROM notes WHERE kid_id = ? AND kid_seen = 0'
      : 'SELECT COUNT(*) AS n, MAX(day) AS day, (SELECT kid_id FROM notes WHERE parent_id = ?1 AND parent_seen = 0 ORDER BY reply_at DESC LIMIT 1) AS kid FROM notes WHERE parent_id = ?1 AND parent_seen = 0';
    const nr = await env.DB.prepare(nq).bind(me.id).first();
    notes = { notesNew: nr.n, notesDay: nr.n ? nr.day : null, notesKid: nr.n ? nr.kid : null };
  }
  return {
    me: { id: me.id, nickname: me.nickname, role: me.role, status: me.status },
    family: { name: me.family_name, code: active ? me.family_code : null },
    members, unread, pushOn, ...notes,
    vapidKey: env.VAPID_PUBLIC_KEY || null
  };
}

async function reload(env, memberId) {
  return env.DB.prepare('SELECT m.*, f.name AS family_name, f.code AS family_code FROM members m JOIN families f ON f.id = m.family_id WHERE m.id = ?')
    .bind(memberId).first();
}

const ROUTES = {
  'GET health': async () => json({ ok: true, family: true }),

  'POST family/create': async ({ env, body, request }) => {
    await limit(env, 'create:' + ipOf(request), 5, 3600);
    const name = clean(body.familyName, 40, 'Family name');
    const nickname = clean(body.nickname, 24, 'Your name');
    let code = null;
    for (let i = 0; i < 6 && !code; i++) {
      const c = randomCode();
      if (!(await env.DB.prepare('SELECT 1 AS x FROM families WHERE code = ?').bind(c).first())) code = c;
    }
    if (!code) throw new HttpError(503, 'busy', 'Please try again.');
    const fam = uid(), mid = uid(), token = randomToken();
    const me = { id: mid, family_id: fam, nickname, role: 'parent' };
    await env.DB.batch([
      env.DB.prepare('INSERT INTO families (id, code, name, created_at) VALUES (?, ?, ?, ?)').bind(fam, code, name, now()),
      env.DB.prepare("INSERT INTO members (id, family_id, nickname, role, status, token_hash, created_at) VALUES (?, ?, ?, 'parent', 'active', ?, ?)")
        .bind(mid, fam, nickname, await sha256hex(token), now()),
      addEvent(env, me, 'created', { family: name })
    ]);
    return json({ token, ...(await state(env, await reload(env, mid))) });
  },

  'POST family/join': async ({ env, body, request, waitUntil }) => {
    await limit(env, 'join:' + ipOf(request), 15, 3600);
    const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 6) throw new HttpError(400, 'bad_code', 'Family codes have 6 letters and numbers.');
    const nickname = clean(body.nickname, 24, 'Your name');
    const role = body.role === 'parent' ? 'parent' : 'kid';
    const fam = await env.DB.prepare('SELECT * FROM families WHERE code = ?').bind(code).first();
    if (!fam) throw new HttpError(404, 'bad_code', 'No family has that code. Check it with a parent.');
    const counts = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(status = 'pending') AS p FROM members WHERE family_id = ?").bind(fam.id).first();
    if (counts.n >= MAX_MEMBERS) throw new HttpError(409, 'full', 'This family is full.');
    if ((counts.p || 0) >= MAX_PENDING) throw new HttpError(409, 'too_many_waiting', 'Too many people are waiting. Ask a parent to approve or decline them first.');
    const mid = uid(), token = randomToken();
    const me = { id: mid, family_id: fam.id, nickname, role };
    await env.DB.batch([
      env.DB.prepare("INSERT INTO members (id, family_id, nickname, role, status, token_hash, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)")
        .bind(mid, fam.id, nickname, role, await sha256hex(token), now()),
      addEvent(env, me, 'join_request', {})
    ]);
    await notifyParents(env, me, {
      title: `Lunch Buddy · ${fam.name}`,
      body: `${nickname} wants to join as a ${role}. Tap to approve.`,
      tag: 'join-' + mid, url: '/?tab=family'
    }, waitUntil);
    return json({ token, ...(await state(env, await reload(env, mid))) });
  },

  'GET family/me': async ({ env, request }) => json(await state(env, await auth(env, request, { active: false }))),

  'POST family/approve': async ({ env, request, body }) => {
    const me = await auth(env, request, { parent: true });
    const who = await env.DB.prepare("SELECT * FROM members WHERE id = ? AND family_id = ? AND status = 'pending'").bind(String(body.memberId || ''), me.family_id).first();
    if (!who) throw new HttpError(404, 'gone', 'That request is no longer waiting.');
    if (body.approve) {
      await env.DB.batch([
        env.DB.prepare("UPDATE members SET status = 'active' WHERE id = ?").bind(who.id),
        addEvent(env, me, 'approved', { member: who.nickname, memberRole: who.role })
      ]);
    } else {
      await env.DB.prepare('DELETE FROM members WHERE id = ?').bind(who.id).run();
    }
    return json(await state(env, me));
  },

  'POST family/remove': async ({ env, request, body }) => {
    const me = await auth(env, request, { parent: true });
    const id = String(body.memberId || '');
    if (id === me.id) throw new HttpError(400, 'self', 'Use “Leave family” to remove yourself.');
    const who = await env.DB.prepare('SELECT * FROM members WHERE id = ? AND family_id = ?').bind(id, me.family_id).first();
    if (!who) throw new HttpError(404, 'gone', 'That person is not in the family.');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM members WHERE id = ?').bind(id),
      addEvent(env, me, 'removed', { member: who.nickname })
    ]);
    return json(await state(env, me));
  },

  // Leave (or cancel a pending request). The last parent leaving deletes the whole family.
  'POST family/leave': async ({ env, request }) => {
    const me = await auth(env, request, { active: false });
    if (me.status === 'active' && me.role === 'parent') {
      const others = await env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE family_id = ? AND role = 'parent' AND status = 'active' AND id <> ?").bind(me.family_id, me.id).first();
      if (others.n === 0) {
        await env.DB.batch([
          env.DB.prepare('DELETE FROM events WHERE family_id = ?').bind(me.family_id),
          env.DB.prepare('DELETE FROM families WHERE id = ?').bind(me.family_id)
        ]);
        return json({ ok: true, deletedFamily: true });
      }
    }
    const stmts = [env.DB.prepare('DELETE FROM members WHERE id = ?').bind(me.id)];
    if (me.status === 'active') stmts.push(addEvent(env, { ...me, id: null }, 'left', { who: me.nickname, role: me.role }));
    await env.DB.batch(stmts);
    return json({ ok: true });
  },

  'GET family/events': async ({ env, request }) => {
    const me = await auth(env, request);
    const { results } = await env.DB.prepare('SELECT id, member_id, kind, day, data, created_at FROM events WHERE family_id = ? ORDER BY id DESC LIMIT 40').bind(me.family_id).all();
    return json({
      lastSeen: me.last_seen_event,
      events: results.map((e) => ({ id: e.id, mine: e.member_id === me.id, kind: e.kind, day: e.day, at: e.created_at, ...JSON.parse(e.data) }))
    });
  },

  'POST family/seen': async ({ env, request, body }) => {
    const me = await auth(env, request);
    const id = Math.max(0, Math.floor(Number(body.lastId) || 0));
    await env.DB.prepare('UPDATE members SET last_seen_event = MAX(last_seen_event, ?) WHERE id = ?').bind(id, me.id).run();
    return json({ ok: true });
  },

  // Save one day's add-on picks for this member; tells parents when a kid changes them.
  'PUT addons': async ({ env, request, body, waitUntil }) => {
    const me = await auth(env, request);
    const day = String(body.day || '');
    if (!DAY_RE.test(day)) throw new HttpError(400, 'bad_day', 'Bad date');
    if (!Array.isArray(body.items) || body.items.length > 15) throw new HttpError(400, 'bad_items', 'Up to 15 add-ons per day');
    const items = [...new Set(body.items.map((x) => clean(x, 80, 'Add-on')))];
    const row = await env.DB.prepare('SELECT items FROM addons WHERE member_id = ? AND day = ?').bind(me.id, day).first();
    const prev = row ? JSON.parse(row.items) : [];
    const added = items.filter((x) => !prev.includes(x));
    const removed = prev.filter((x) => !items.includes(x));
    if (!added.length && !removed.length) return json({ ok: true, changed: false });
    await env.DB.batch([
      items.length
        ? env.DB.prepare('INSERT INTO addons (member_id, family_id, day, items, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (member_id, day) DO UPDATE SET items = excluded.items, updated_at = excluded.updated_at')
          .bind(me.id, me.family_id, day, JSON.stringify(items), now())
        : env.DB.prepare('DELETE FROM addons WHERE member_id = ? AND day = ?').bind(me.id, day),
      addEvent(env, me, 'addons', { added, removed }, day),
      env.DB.prepare('DELETE FROM events WHERE family_id = ? AND created_at < ?').bind(me.family_id, now() - 60 * 86400000)
    ]);
    if (me.role === 'kid') {
      const parts = [];
      if (added.length) parts.push(`added ${listText(added)}`);
      if (removed.length) parts.push(`removed ${listText(removed)}`);
      await notifyParents(env, me, {
        title: `${me.nickname}'s lunch plan · ${dayLabel(day)}`,
        body: `${me.nickname} ${parts.join(' and ')}.`.slice(0, 240),
        tag: `addons-${me.id}-${day}`, url: '/?tab=family'
      }, waitUntil);
    }
    return json({ ok: true, changed: true });
  },

  // One-time upload of picks made before joining: shown in plans, no alert.
  'POST addons/sync': async ({ env, request, body }) => {
    const me = await auth(env, request);
    const days = body.days && typeof body.days === 'object' ? Object.entries(body.days).slice(0, 60) : [];
    const stmts = [];
    for (const [day, list] of days) {
      if (!DAY_RE.test(day) || !Array.isArray(list)) continue;
      const items = [...new Set(list.slice(0, 15).map((x) => clean(x, 80, 'Add-on')))];
      if (!items.length) continue;
      stmts.push(env.DB.prepare('INSERT INTO addons (member_id, family_id, day, items, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (member_id, day) DO UPDATE SET items = excluded.items, updated_at = excluded.updated_at')
        .bind(me.id, me.family_id, day, JSON.stringify(items), now()));
    }
    if (stmts.length) {
      stmts.push(addEvent(env, me, 'synced', { days: stmts.length }));
      await env.DB.batch(stmts);
    }
    return json({ ok: true, days: stmts.length ? stmts.length - 1 : 0 });
  },

  'GET addons': async ({ env, request, url }) => {
    const me = await auth(env, request);
    const start = url.searchParams.get('start') || '', end = url.searchParams.get('end') || '';
    if (!DAY_RE.test(start) || !DAY_RE.test(end) || end < start) throw new HttpError(400, 'bad_range', 'Bad dates');
    const { results } = await env.DB.prepare(
      "SELECT a.member_id, m.nickname, m.role, a.day, a.items FROM addons a JOIN members m ON m.id = a.member_id WHERE a.family_id = ? AND m.status = 'active' AND a.day BETWEEN ? AND ? ORDER BY m.created_at, a.day"
    ).bind(me.family_id, start, end).all();
    return json({ plans: results.map((r) => ({ memberId: r.member_id, nickname: r.nickname, role: r.role, day: r.day, items: JSON.parse(r.items), mine: r.member_id === me.id })) });
  },

  // Backup of this member's own saved app data (ideas, badges, game points…), replaced on every save.
  'PUT backup': async ({ env, request, body }) => {
    const me = await auth(env, request);
    await ensureBackupTables(env);
    const text = backupText(body.data);
    await limit(env, 'backup:' + me.id, 120, 600);
    const t = now();
    await env.DB.prepare('INSERT INTO backups (member_id, family_id, data, size, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (member_id) DO UPDATE SET data = excluded.data, size = excluded.size, updated_at = excluded.updated_at')
      .bind(me.id, me.family_id, text, text.length, t).run();
    return json({ ok: true, updatedAt: t });
  },

  // A one-time code that moves a member to another phone. Members make one for themselves;
  // parents can make one for anyone in the family (for a lost or new phone).
  'POST move/create': async ({ env, request, body }) => {
    const me = await auth(env, request);
    await ensureBackupTables(env);
    await limit(env, 'move:' + me.id, 10, 3600);
    let target = me;
    const want = String(body.memberId || '');
    if (want && want !== me.id) {
      if (me.role !== 'parent') throw new HttpError(403, 'parents_only', 'Only parents can make a code for someone else.');
      target = await env.DB.prepare("SELECT * FROM members WHERE id = ? AND family_id = ? AND status = 'active'").bind(want, me.family_id).first();
      if (!target) throw new HttpError(404, 'gone', 'That person is not in the family.');
    }
    const code = randomCode(8), expiresAt = now() + MOVE_TTL;
    await env.DB.batch([
      env.DB.prepare('DELETE FROM move_codes WHERE member_id = ? OR expires_at < ?').bind(target.id, now()),
      env.DB.prepare('INSERT INTO move_codes (code_hash, member_id, created_by, expires_at) VALUES (?, ?, ?, ?)').bind(await sha256hex(code), target.id, me.id, expiresAt)
    ]);
    return json({ code: code.slice(0, 4) + '-' + code.slice(4), expiresAt, nickname: target.nickname, self: target.id === me.id });
  },

  // Use a move code on the new phone: this phone becomes the member, the old phone is signed out.
  'POST move/redeem': async ({ env, request, body }) => {
    await limit(env, 'redeem:' + ipOf(request), 30, 3600);
    await ensureBackupTables(env);
    const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 8) throw new HttpError(400, 'bad_code', 'Move codes have 8 letters and numbers.');
    const hash = await sha256hex(code);
    const row = await env.DB.prepare('SELECT * FROM move_codes WHERE code_hash = ?').bind(hash).first();
    if (!row) {
      // A personal backup's code: this phone takes over the backup; the old phone starts a new one.
      const vc = await env.DB.prepare('SELECT * FROM vault_codes WHERE code_hash = ?').bind(hash).first();
      if (!vc || vc.expires_at < now()) throw new HttpError(404, 'bad_code', 'That code didn’t work. Codes work once, for 15 minutes. Ask for a new one.');
      const token = randomToken();
      await env.DB.batch([
        env.DB.prepare('UPDATE vaults SET token_hash = ? WHERE id = ?').bind(await sha256hex(token), vc.vault_id),
        env.DB.prepare('DELETE FROM vault_codes WHERE vault_id = ?').bind(vc.vault_id)
      ]);
      const v = await env.DB.prepare('SELECT data, updated_at FROM vaults WHERE id = ?').bind(vc.vault_id).first();
      if (!v) throw new HttpError(404, 'bad_code', 'That code didn’t work. Ask for a new one.');
      return json({ vault: true, token, backup: { data: JSON.parse(v.data), updatedAt: v.updated_at } });
    }
    if (row.expires_at < now()) throw new HttpError(404, 'bad_code', 'That code didn’t work. Codes work once, for 15 minutes. Ask for a new one.');
    const who = await reload(env, row.member_id);
    if (!who || who.status !== 'active') throw new HttpError(404, 'bad_code', 'That code didn’t work. Ask for a new one.');
    const token = randomToken();
    await env.DB.batch([
      env.DB.prepare('UPDATE members SET token_hash = ? WHERE id = ?').bind(await sha256hex(token), who.id),
      env.DB.prepare('DELETE FROM move_codes WHERE member_id = ?').bind(who.id),
      env.DB.prepare('DELETE FROM push_subs WHERE member_id = ?').bind(who.id),
      addEvent(env, who, 'moved', {})
    ]);
    const b = await env.DB.prepare('SELECT data, updated_at FROM backups WHERE member_id = ?').bind(who.id).first();
    return json({
      token, ...(await state(env, await reload(env, who.id))),
      backup: b ? { data: JSON.parse(b.data), updatedAt: b.updated_at } : null
    });
  },

  // ── Personal backups, for phones that aren't in a family. No name or account: just a random key. ──
  'POST vault': async ({ env, request, body }) => {
    await ensureBackupTables(env);
    const text = backupText(body.data);
    await limit(env, 'vault:' + ipOf(request), 600, 3600);
    const id = uid(), token = randomToken(), t = now();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO vaults (id, token_hash, data, size, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, await sha256hex(token), text, text.length, t, t),
      env.DB.prepare('DELETE FROM vaults WHERE updated_at < ?').bind(t - VAULT_IDLE)
    ]);
    return json({ token, updatedAt: t });
  },

  'PUT vault': async ({ env, request, body }) => {
    await ensureBackupTables(env);
    const v = await vaultAuth(env, request);
    const text = backupText(body.data);
    await limit(env, 'vbackup:' + v.id, 120, 600);
    const t = now();
    await env.DB.prepare('UPDATE vaults SET data = ?, size = ?, updated_at = ? WHERE id = ?').bind(text, text.length, t, v.id).run();
    return json({ ok: true, updatedAt: t });
  },

  'POST vault/move': async ({ env, request }) => {
    await ensureBackupTables(env);
    const v = await vaultAuth(env, request);
    await limit(env, 'vmove:' + v.id, 10, 3600);
    const code = randomCode(8), expiresAt = now() + MOVE_TTL;
    await env.DB.batch([
      env.DB.prepare('DELETE FROM vault_codes WHERE vault_id = ? OR expires_at < ?').bind(v.id, now()),
      env.DB.prepare('INSERT INTO vault_codes (code_hash, vault_id, expires_at) VALUES (?, ?, ?)').bind(await sha256hex(code), v.id, expiresAt)
    ]);
    return json({ code: code.slice(0, 4) + '-' + code.slice(4), expiresAt, self: true, vault: true });
  },

  // Used when the phone joins a family (its family backup takes over) or moves to another backup.
  'POST vault/delete': async ({ env, request }) => {
    await ensureBackupTables(env);
    const v = await vaultAuth(env, request);
    await env.DB.prepare('DELETE FROM vaults WHERE id = ?').bind(v.id).run();
    return json({ ok: true });
  },

  'POST push/subscribe': async ({ env, request, body }) => {
    const me = await auth(env, request);
    const endpoint = String(body.endpoint || '');
    const keys = body.keys || {};
    if (!isPushEndpoint(endpoint) || endpoint.length > 1000) throw new HttpError(400, 'bad_endpoint', 'This browser’s push service is not supported.');
    const p256dh = String(keys.p256dh || ''), authKey = String(keys.auth || '');
    if (!/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,30}$/.test(authKey)) throw new HttpError(400, 'bad_keys', 'Bad subscription');
    await env.DB.prepare('INSERT INTO push_subs (endpoint, member_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (endpoint) DO UPDATE SET member_id = excluded.member_id, p256dh = excluded.p256dh, auth = excluded.auth')
      .bind(endpoint, me.id, p256dh, authKey, now()).run();
    return json({ ok: true });
  },

  'POST push/unsubscribe': async ({ env, request, body }) => {
    const me = await auth(env, request, { active: false });
    await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ? AND member_id = ?').bind(String(body.endpoint || ''), me.id).run();
    return json({ ok: true });
  },

  // ── Flight Plan: kids' after-school plans, and parents' notes of encouragement ──
  'PUT plans': async ({ env, request, body }) => {
    const me = await auth(env, request);
    if (me.role !== 'kid') throw new HttpError(403, 'kids_only', 'Only kids share a plan.');
    await ensureBackupTables(env);
    await limit(env, 'plan:' + me.id, 200, 600);
    const day = dayArg(body.day), blocks = cleanBlocks(body.blocks);
    await env.DB.batch([
      blocks.length
        ? env.DB.prepare('INSERT INTO plans (member_id, family_id, day, blocks, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (member_id, day) DO UPDATE SET blocks = excluded.blocks, updated_at = excluded.updated_at')
          .bind(me.id, me.family_id, day, JSON.stringify(blocks), now())
        : env.DB.prepare('DELETE FROM plans WHERE member_id = ? AND day = ?').bind(me.id, day),
      env.DB.prepare('DELETE FROM plans WHERE member_id = ? AND day < ?').bind(me.id, oldDay())
    ]);
    return json({ ok: true });
  },

  'GET plans': async ({ env, request, url }) => {
    const me = await auth(env, request);
    await ensureBackupTables(env);
    const kid = await kidFor(env, me, url.searchParams.get('member') || me.id);
    const { start, end } = rangeArgs(url);
    const { results } = await env.DB.prepare('SELECT day, blocks FROM plans WHERE member_id = ? AND day >= ? AND day <= ? ORDER BY day').bind(kid.id, start, end).all();
    return json({ plans: results.map((r) => ({ day: r.day, blocks: JSON.parse(r.blocks) })) });
  },

  'GET notes': async ({ env, request, url }) => {
    const me = await auth(env, request);
    await ensureBackupTables(env);
    const kid = await kidFor(env, me, url.searchParams.get('kid') || me.id);
    const { start, end } = rangeArgs(url);
    const { results } = await env.DB.prepare(
      'SELECT n.*, m.nickname AS parent_name FROM notes n JOIN members m ON m.id = n.parent_id WHERE n.kid_id = ? AND n.day >= ? AND n.day <= ? ORDER BY n.day, n.created_at'
    ).bind(kid.id, start, end).all();
    return json({
      notes: results.map((n) => ({
        id: n.id, day: n.day, parent: n.parent_name, parentId: n.parent_id, text: n.text, reply: n.reply, replyAt: n.reply_at,
        mine: n.parent_id === me.id, isNew: me.role === 'kid' ? !n.kid_seen : n.parent_id === me.id && !n.parent_seen
      }))
    });
  },

  // A parent's note to one kid for one day (one per parent per kid per day; sending again replaces it).
  'PUT notes': async ({ env, request, body, waitUntil }) => {
    const me = await auth(env, request, { parent: true });
    await ensureBackupTables(env);
    await limit(env, 'note:' + me.id, 60, 600);
    const kid = await kidFor(env, me, body.kid), day = dayArg(body.day), text = clean(body.text, 140, 'Note'), t = now();
    const had = await env.DB.prepare('SELECT 1 AS x FROM notes WHERE kid_id = ? AND parent_id = ? AND day = ?').bind(kid.id, me.id, day).first();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO notes (id, family_id, kid_id, parent_id, day, text, kid_seen, parent_seen, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?) ON CONFLICT (kid_id, parent_id, day) DO UPDATE SET text = excluded.text, kid_seen = 0, updated_at = excluded.updated_at')
        .bind(uid(), me.family_id, kid.id, me.id, day, text, t, t),
      env.DB.prepare('DELETE FROM notes WHERE kid_id = ? AND day < ?').bind(kid.id, oldDay())
    ]);
    if (!had) await notifyMember(env, kid.id, { title: `A note from ${me.nickname} 💌`, body: text, tag: 'note-' + day, url: '/?tab=plan' }, waitUntil);
    return json({ ok: true });
  },

  'POST notes/delete': async ({ env, request, body }) => {
    const me = await auth(env, request, { parent: true });
    await ensureBackupTables(env);
    await env.DB.prepare('DELETE FROM notes WHERE id = ? AND parent_id = ?').bind(String(body.id || ''), me.id).run();
    return json({ ok: true });
  },

  // A kid's reply to a note; tells the parent who wrote it.
  'POST notes/reply': async ({ env, request, body, waitUntil }) => {
    const me = await auth(env, request);
    if (me.role !== 'kid') throw new HttpError(403, 'kids_only', 'Only kids reply to notes.');
    await ensureBackupTables(env);
    await limit(env, 'reply:' + me.id, 60, 600);
    const reply = clean(body.reply, 80, 'Reply');
    const n = await env.DB.prepare('SELECT * FROM notes WHERE id = ? AND kid_id = ?').bind(String(body.id || ''), me.id).first();
    if (!n) throw new HttpError(404, 'no_note', 'That note was deleted.');
    if (n.reply === reply) return json({ ok: true });
    await env.DB.prepare('UPDATE notes SET reply = ?, reply_at = ?, parent_seen = 0, kid_seen = 1 WHERE id = ?').bind(reply, now(), n.id).run();
    await notifyMember(env, n.parent_id, { title: `${me.nickname} replied 💬`, body: `“${n.text.length > 60 ? n.text.slice(0, 57) + '…' : n.text}” → ${reply}`, tag: 'reply-' + n.id, url: '/?tab=plan' }, waitUntil);
    return json({ ok: true });
  },

  // Notes (kids) or replies (parents) the person has now read.
  'POST notes/seen': async ({ env, request, body }) => {
    const me = await auth(env, request);
    await ensureBackupTables(env);
    const ids = Array.isArray(body.ids) ? body.ids.slice(0, 50).map(String) : [];
    if (!ids.length) return json({ ok: true });
    const q = me.role === 'kid' ? 'UPDATE notes SET kid_seen = 1 WHERE kid_id = ? AND id IN ' : 'UPDATE notes SET parent_seen = 1 WHERE parent_id = ? AND id IN ';
    await env.DB.prepare(q + `(${ids.map(() => '?').join(',')})`).bind(me.id, ...ids).run();
    return json({ ok: true });
  },

  'POST push/test': async ({ env, request }) => {
    const me = await auth(env, request);
    await limit(env, 'pushtest:' + me.id, 5, 600);
    if (!env.VAPID_PRIVATE_JWK) throw new HttpError(503, 'push_off', 'Phone alerts are not set up on the server yet.');
    const { results } = await env.DB.prepare('SELECT * FROM push_subs WHERE member_id = ?').bind(me.id).all();
    if (!results.length) throw new HttpError(400, 'no_sub', 'Phone alerts are not turned on for this device.');
    const statuses = await Promise.all(results.map((s) => deliver(env, s, {
      title: 'Lunch Buddy', body: `Phone alerts work! You'll hear about ${me.family_name} lunch plans here.`, tag: 'test', url: '/?tab=family'
    })));
    return json({ ok: statuses.some((s) => s >= 200 && s < 300), statuses });
  }
};

export async function onRequest(ctx) {
  const { request, env, params } = ctx;
  const path = [].concat(params.path || []).join('/');
  const route = ROUTES[request.method + ' ' + path];
  if (!route) return json({ error: 'not_found', message: 'No such endpoint' }, 404);
  if (!env.DB) return json({ error: 'not_configured', message: 'Family sharing is not set up on this server.' }, 503);
  try {
    let body = {};
    if (request.method !== 'GET') {
      try { body = await request.json(); } catch (e) { throw new HttpError(400, 'bad_json', 'Send JSON'); }
      if (!body || typeof body !== 'object') body = {};
    }
    return await route({ request, env, body, url: new URL(request.url), waitUntil: (p) => ctx.waitUntil(p) });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status);
    console.error(e);
    return json({ error: 'server_error', message: 'Something went wrong. Please try again.' }, 500);
  }
}
