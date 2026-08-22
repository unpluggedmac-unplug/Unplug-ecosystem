import { passThrough } from './_shared.js';

// Served from the backend rather than kept as a static file, so the Sitemap:
// line and the site origin come from one place and cannot drift apart.
export const onRequestGet = ({ env }) => passThrough(env, '/robots.txt', 'text/plain');
