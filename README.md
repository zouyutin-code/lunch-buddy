# Lunch Buddy

Southeast Bulloch Middle's lunch menu with add-on ideas, quests and badges, live at
https://lunch-buddy.pages.dev. Families can link up so parents see (and get phone alerts
for) the lunch add-ons their kids plan.

## Layout

| Path | What it is |
|---|---|
| `public/` | Everything served as the website (Cloudflare Pages output folder) |
| `public/index.html` | The app, as a self-unpacking bundle. **Don't edit it by hand**: edit `src/app.dc.html` and run the build |
| `public/sw.js`, `manifest.webmanifest`, `icons/` | Home-screen install and phone alerts |
| `src/app.dc.html` | The app source (screens and logic) |
| `tools/build.py` | Packs `src/app.dc.html` into `public/index.html` |
| `functions/menu.js` | `/menu`: fetches the live menu from MealViewer |
| `functions/api/[[path]].js` | `/api/...`: family sharing (create, join, approve, plans, activity, alerts) |
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

Only nicknames, the family name, lunch add-on picks, activity and push subscriptions are
stored. No emails, passwords or full names. New members can't see anything until a parent
approves them, and the last parent leaving deletes the family.
