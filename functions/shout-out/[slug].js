const PRODUCTION_API = 'https://unplug-ecosystem.onrender.com';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function resolveApi(env) {
  const environment = String((env && env.UNPLUG_ENV) || 'production').toLowerCase();
  const staging = environment === 'staging' || environment === 'preview';
  const configured = String((env && env.UNPLUG_API) || '').trim().replace(/\/+$/, '');
  if (staging) return configured && configured !== PRODUCTION_API ? configured : '';
  return configured || PRODUCTION_API;
}

function unavailable(status, title, message) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)}</title></head><body style="margin:0;background:#f4efe6;color:#050302;font:16px Arial,sans-serif"><main style="max-width:760px;margin:10vh auto;padding:32px"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="/daily-shout-out">View today’s Daily Shout-Out</a></p></main></body></html>`, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestGet({ request, env, params }) {
  const api = resolveApi(env || {});
  if (!api) return unavailable(503, 'Staging is not connected', 'This preview does not have an isolated staging API configured.');

  const slug = String(params && params.slug || '').trim();
  if (!slug || !/^[a-z0-9-]+$/i.test(slug)) return unavailable(404, 'Shout-out not found', 'That Daily Shout-Out link is not valid.');

  let response;
  try {
    response = await fetch(`${api}/shoutouts/share/${encodeURIComponent(slug)}`, {
      headers: { Accept: 'application/json' },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
  } catch (_) {
    return unavailable(503, 'Temporarily unavailable', 'The Daily Shout-Out could not be loaded right now.');
  }

  if (response.status === 404) return unavailable(404, 'Shout-out not found', 'That Daily Shout-Out is not available.');
  if (!response.ok) return unavailable(503, 'Temporarily unavailable', 'The Daily Shout-Out artwork is still being prepared.');

  const data = await response.json();
  const s = data && data.shoutout;
  if (!s) return unavailable(404, 'Shout-out not found', 'That Daily Shout-Out is not available.');

  const url = new URL(request.url);
  const permalink = `${url.origin}/shout-out/${encodeURIComponent(s.shareSlug || slug)}`;
  const title = `POWER ON! — ${s.recipientName} | Unplug Magazine`;
  const description = s.message;
  const image = s.imageOgUrl;
  const portrait = s.imagePortraitUrl || image;

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="robots" content="noindex,follow">
  <link rel="canonical" href="${escapeHtml(permalink)}">
  <meta property="og:type" content="article">
  <meta property="og:title" content="${escapeHtml(`POWER ON! — ${s.recipientName}`)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${escapeHtml(permalink)}">
  <meta property="og:image" content="${escapeHtml(image || '')}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:site_name" content="Unplug Magazine">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(`POWER ON! — ${s.recipientName}`)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${escapeHtml(image || '')}">
  <style>
    :root{--black:#050302;--red:#df3b01;--bright:#ff2f00;--ivory:#e9e2dd;--ivory2:#f4efe6;}
    *{box-sizing:border-box}body{margin:0;background:var(--ivory2);color:var(--black);font-family:Arial,Helvetica,sans-serif}
    main{min-height:100vh;padding:clamp(18px,4vw,54px);display:grid;place-items:center;background:radial-gradient(circle at 90% 10%,rgba(223,59,1,.14),transparent 34%),linear-gradient(135deg,var(--ivory2),var(--ivory))}
    .shell{width:min(1120px,100%);display:grid;grid-template-columns:minmax(0,1fr) minmax(320px,520px);gap:clamp(24px,5vw,70px);align-items:center}
    .eyebrow{font-weight:900;letter-spacing:.18em;font-size:12px;color:var(--red)}h1{font-size:clamp(42px,6vw,82px);line-height:.92;margin:10px 0 22px;text-transform:uppercase}h1 span{color:var(--red)}
    .copy{font-size:clamp(17px,2vw,23px);line-height:1.55;max-width:620px}.brand{font-weight:800;margin-top:28px}.return{font-size:14px;opacity:.72}.site{display:inline-block;margin-top:24px;background:var(--black);color:#fff;padding:11px 17px;text-decoration:none;font-weight:800}
    .art{background:#fff;border:3px solid var(--black);box-shadow:18px 18px 0 var(--red);transform:rotate(1deg);overflow:hidden}.art img{display:block;width:100%;height:auto}.art-fallback{aspect-ratio:4/5;padding:44px;background:var(--ivory);display:flex;flex-direction:column;justify-content:center}.art-fallback b{font-size:52px;color:var(--red)}.art-fallback strong{font-size:46px;margin:24px 0}
    @media(max-width:800px){.shell{grid-template-columns:1fr}.art{order:-1;max-width:520px;margin:auto}.intro{text-align:center}.copy{margin:auto}.site{margin-bottom:12px}}
  </style>
</head>
<body>
<main>
  <div class="shell">
    <section class="intro" aria-labelledby="share-title">
      <div class="eyebrow">DAILY SHOUT-OUT · THE GUY SAYS</div>
      <h1 id="share-title"><span>POWER ON!</span><br>${escapeHtml(s.recipientName)}</h1>
      <p class="copy">${escapeHtml(s.message)}</p>
      <p class="brand">${escapeHtml(s.brandLine)}</p>
      <p class="return">${escapeHtml(s.returnLine)}</p>
      <a class="site" href="/daily-shout-out">${escapeHtml(s.website || 'www.unplugnews.com')}</a>
    </section>
    <figure class="art" aria-label="Daily Unplug Magazine shout-out for ${escapeHtml(s.recipientName)}">
      ${portrait ? `<img src="${escapeHtml(portrait)}" alt="Daily Unplug Magazine shout-out for ${escapeHtml(s.recipientName)}: ${escapeHtml(s.message)}">` : `<div class="art-fallback"><b>POWER ON!</b><strong>${escapeHtml(s.recipientName)}</strong><span>${escapeHtml(s.message)}</span></div>`}
    </figure>
  </div>
</main>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    },
  });
}
