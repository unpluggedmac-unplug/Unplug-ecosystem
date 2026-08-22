import { passThrough } from './_shared.js';

// The sitemap index, under the public domain. Search Console will not accept
// a sitemap for this site that is only reachable on the API's origin.
export const onRequestGet = ({ env }) => passThrough(env, '/sitemap.xml', 'application/xml');
