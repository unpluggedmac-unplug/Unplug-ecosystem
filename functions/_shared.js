// Where the API lives, for every Function here.
//
// Configurable so a preview deployment can point at a staging API, with the
// production origin as the fallback — an unset variable should not break the
// sitemap on a deploy nobody remembered to configure.
export function apiOrigin(env) {
  const raw = (env && env.UNPLUG_API) || 'https://unplug-ecosystem.onrender.com';
  return String(raw).replace(/\/+$/, '');
}

// Fetch something from the backend and pass it through unchanged.
//
// The backend is on a free instance that sleeps, so a cold start can take the
// better part of a minute. A crawler will not wait that long, and a half-
// answered sitemap is worse than an honest failure: returning a 200 with an
// empty or truncated body would tell Google the site has no pages. So a
// failure here returns 503, which crawlers understand as "ask again later"
// and which leaves the previously submitted sitemap standing.
export async function passThrough(env, path, contentType) {
  try {
    const res = await fetch(apiOrigin(env) + path, {
      headers: { Accept: contentType },
      // Cloudflare caches this at the edge, so a crawl storm does not become
      // a backend load problem.
      cf: { cacheTtl: 900, cacheEverything: true },
    });
    if (!res.ok) {
      return new Response('Temporarily unavailable', {
        status: 503,
        headers: { 'Content-Type': 'text/plain', 'Retry-After': '3600' },
      });
    }
    const body = await res.text();
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': contentType + '; charset=utf-8',
        'Cache-Control': 'public, max-age=900',
      },
    });
  } catch (err) {
    return new Response('Temporarily unavailable', {
      status: 503,
      headers: { 'Content-Type': 'text/plain', 'Retry-After': '3600' },
    });
  }
}
