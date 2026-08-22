# Cloudflare Pages Functions

Small pieces of server-side code that run at the edge, in front of the static
site. Cloudflare Pages picks this folder up automatically — there is no build
step, no config file and no cost on the free plan.

## Why these exist at all

`www.unplugnews.com` is served by Cloudflare Pages. The API is a different
origin (`unplug-ecosystem.onrender.com`). Two things therefore cannot be done
by the Express backend alone, no matter how it is written:

**A sitemap must live on the public domain.** Search Console will not accept a
sitemap for unplugnews.com that is only reachable at onrender.com. The backend
generates the XML; `sitemap.xml.js` serves it under the right domain.

**A redirect must be applied before the static site answers.** A request for
`https://www.unplugnews.com/old-page` is handled by Cloudflare and never
reaches Express, so Express middleware cannot redirect it. `[[path]].js` sits
in front of the static assets and can.

## What is here

| File | Responsibility |
|---|---|
| `sitemap.xml.js` | Serves the sitemap index from the backend |
| `sitemap-[name].xml.js` | Serves each child sitemap (pages, articles, directory, projects) |
| `robots.txt.js` | Serves robots.txt from the backend, so it names one origin |
| `[[path]].js` | Catch-all: static asset first, then redirect lookup, then log the miss |

## The rule that matters in `[[path]].js`

**The static asset is always tried first.** Only a genuine 404 asks the backend
anything. A visitor loading a page that exists pays nothing for this — no extra
latency, no backend round-trip. If the backend is asleep or down, the fallback
is the normal 404 page, which is exactly what would have happened anyway.

## Configuration

`UNPLUG_API` — the API origin, set in the Cloudflare Pages dashboard under
Settings → Environment variables. Falls back to the production API if unset, so
a preview deployment works without configuration.

## Removing all of this

Delete the `functions/` folder. The site returns to being purely static and
behaves exactly as it did before — the sitemap and redirects simply stop
working. Nothing else depends on it.
