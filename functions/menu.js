// Cloudflare Pages Function — GET /menu?school=SoutheastBullochMiddle&start=MM-DD-YYYY&end=MM-DD-YYYY
export async function onRequest({ request }) {
  const q = new URL(request.url).searchParams;
  const school = (q.get('school') || 'SoutheastBullochMiddle').replace(/[^\w-]/g, '');
  const start = q.get('start'), end = q.get('end');
  const ok = s => /^\d{2}-\d{2}-\d{4}$/.test(s || '');
  const cors = { 'Access-Control-Allow-Origin': '*' };
  if (!ok(start) || !ok(end)) return new Response('bad dates', { status: 400, headers: cors });
  try {
    const r = await fetch(`https://api.mealviewer.com/api/v4/school/${school}/${start}/${end}/0`, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        Origin: 'https://schools.mealviewer.com',
        Referer: `https://schools.mealviewer.com/school/${school}`,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
      },
      cf: { cacheTtl: 3600, cacheEverything: true }
    });
    return new Response(await r.text(), {
      status: r.status,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 502, headers: cors });
  }
}
