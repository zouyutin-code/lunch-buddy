# Lunch Buddy

Southeast Bulloch Middle's lunch menu with add-on ideas, the Nest (quests and badges), the
Flight Plan (an after-school planner from 3 to 10 PM whose finished activities earn Nest
points, plus a private month calendar for events, important days and period tracking) and the Peck Patch game, live at https://lunch-buddy.pages.dev. Every phone's progress
is backed up automatically, and a one-time move code brings it to a new phone. Families can
link up so parents see (and get phone alerts for) the lunch add-ons their kids plan, see their
kids' after-school plans, and leave them notes of encouragement that kids can reply to.

## Layout

| Path | What it is |
|---|---|
| `public/` | Everything served as the website (Cloudflare Pages output folder) |
| `public/index.html` | The app, as a self-unpacking bundle. **Don't edit it by hand**: edit `src/app.dc.html` and run the build |
| `public/sw.js`, `manifest.webmanifest`, `icons/` | Home-screen install and phone alerts |
| `src/app.dc.html` | The app source (screens and logic) |
| `tools/build.py` | Packs `src/app.dc.html` into `public/index.html` |
| `functions/menu.js` | `/menu`: fetches the live menu from MealViewer |
| `functions/api/[[path]].js` | `/api/...`: backups and move codes, family sharing (create, join, approve, lunch plans, after-school plans, notes, activity, alerts) |
| `lib/webpush.js` | Sends encrypted Web Push alerts (no extra packages) |
| `schema.sql` | Database tables (Cloudflare D1, binding `DB`) |
| `wrangler.toml` | Cloudflare config: output folder, D1 binding, public push key |

## Editing

```bash
python3 -I tools/build.py      # after changing src/app.dc.html
```

Pushing to `main` on GitHub deploys the live site; any other branch gets a preview URL.

## Running locally

```bash
npx wrangler d1 execute lunch-buddy --local --file schema.sql   # first time only
npx wrangler pages dev --port 8788
```

Local secrets live in `.dev.vars` (not committed): `VAPID_PRIVATE_JWK`, the private half of
the push key whose public half is `VAPID_PUBLIC_KEY` in `wrangler.toml`.

## One-time Cloudflare setup

1. `npx wrangler d1 create lunch-buddy`, then put the database id in `wrangler.toml`.
2. `npx wrangler d1 execute lunch-buddy --remote --file schema.sql`
3. Add the push key secret for production and previews:
   `npx wrangler pages secret put VAPID_PRIVATE_JWK --project-name lunch-buddy` (repeat with `--env preview`).

Keep the private key: replacing it means every family has to turn phone alerts on again.

## Privacy

Stored: each phone's app backup (ideas, badges, quests, game points, after-school plan, and the
private "My calendar": events and period days, which other family members never see) under a random key kept
on that phone, plus, for families, nicknames, the family name, lunch add-on picks, activity
and push subscriptions, kids' after-school plans, and parents' notes with kids' replies (plans and
notes are deleted after 120 days). No emails, passwords or full names. Family members back up to their
family; leaving or being removed deletes that backup. Personal backups unused for 400 days
are deleted. New members can't see anything until a parent approves them, and the last
parent leaving deletes the family.
