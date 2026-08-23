import { passThrough } from './_shared.js';

// The sitemap, under the public domain. Search Console will not accept a
// sitemap for this site that is only reachable on the API's origin, so the
// backend generates it from live content and this serves it from here.
//
// robots.txt is deliberately NOT proxied the same way. The API's robots.txt
// says "Disallow: /" because nothing on that host should be indexed; serving
// it here would ask every crawler to drop the whole magazine. The public
// robots.txt is a static file in the repository root.
export const onRequestGet = ({ env }) => passThrough(env, '/sitemap.xml', 'application/xml');
