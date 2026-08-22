import { passThrough } from './_shared.js';

// The child sitemaps: /sitemap-articles.xml and friends.
//
// The name is checked against a fixed list rather than passed through. Without
// that, this route would forward any path fragment to the backend, which is
// how a public edge Function becomes an open proxy to an internal origin.
const ALLOWED = new Set(['pages', 'articles', 'directory', 'projects']);

export const onRequestGet = ({ params, env }) => {
  const name = String(params.name || '');
  if (!ALLOWED.has(name)) {
    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  }
  return passThrough(env, `/sitemap-${name}.xml`, 'application/xml');
};
