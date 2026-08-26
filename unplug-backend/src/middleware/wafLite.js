// A small request filter: obvious probes refused before they reach a route.
//
// WHAT THIS IS NOT. It is not a web application firewall in the product sense,
// and pretending otherwise would be the dangerous part. Cloudflare already
// sits in front of the site and handles volume, reputation and the bulk of the
// noise. This catches the specific shapes that reach an origin anyway, and it
// exists mainly so that a probe is refused and RECORDED rather than answered.
//
// ============================================================================
// THE RULE THAT SHAPES EVERYTHING BELOW: BODIES ARE NOT SCANNED.
// ============================================================================
//
// This is a magazine. It publishes articles about technology. An article about
// SQL injection contains "OR 1=1". A tutorial contains "<script>". A comment
// quoting a file path contains "../". A profile bio can contain anything a
// person can type.
//
// A filter that scanned request bodies for those patterns would block writers
// from publishing, reviewers from quoting, and readers from commenting — and
// it would do it intermittently, which is worse, because nobody would work out
// why their article saved on Tuesday and not on Wednesday. The team would then
// switch the filter off, and the site would end up with less protection than
// if it had never been added.
//
// So the patterns are applied ONLY where the strings are never legitimate:
// the URL path, the query string, and a couple of headers. Nobody has a
// legitimate reason to put a UNION SELECT in a query parameter of this site.
// Content is defended the way content must be: parameterised queries on the
// way in (which this codebase already does everywhere) and escaping on the way
// out.

const { recordDenial } = require('./accessControl');

// The largest request that could be legitimate. Uploads do not come through
// here — they are multipart and handled by multer with its own, larger limits.
// This bounds JSON, where the biggest honest payload is a long article with
// its gallery list.
const MAX_JSON_BYTES = 512 * 1024;

// Path traversal. Checked against the raw and the decoded path, because
// "%2e%2e%2f" is the same request written to slip past a check that only looks
// at one of them.
const TRAVERSAL = /(\.\.[/\\])|(%2e%2e[/\\%])|(\.\.%2f)/i;

// A null byte in a path is never anything but an attempt to truncate a string
// somewhere downstream.
const NULL_BYTE = /%00|\0/;

// SQL shapes, deliberately narrow. Not "contains SELECT" — this site has a
// query parameter called `q` and somebody searching the directory for a
// business called "Select Motors" must not be refused.
const SQLI = [
  /\bunion\b[\s/*]+\bselect\b/i,
  /\bselect\b[\s\S]{0,40}\bfrom\b[\s\S]{0,40}\binformation_schema\b/i,
  /\b(or|and)\b\s+\d+\s*=\s*\d+(\s|--|;|$)/i,   // or 1=1
  /;\s*(drop|truncate|alter)\s+table\b/i,
  /\bpg_sleep\s*\(/i,
  /\bxp_cmdshell\b/i,
  /'\s*(or|and)\s*'[^']*'\s*=\s*'/i,             // ' or 'a'='a
];

// Script injection in a URL — reflected XSS attempts. Again narrow: a
// parameter carrying the word "script" is fine; a parameter carrying a tag is
// not.
const XSS = [
  /<\s*script\b/i,
  /javascript:\s*[^\s]/i,
  /\bon(error|load|click|mouseover)\s*=/i,
  /<\s*iframe\b/i,
  /\bdata:text\/html/i,
];

// Probes for software this site does not run. They are harmless — the path
// 404s — but they are worth refusing and counting, because a burst of them is
// how you notice being scanned.
const KNOWN_PROBES = /^\/(wp-admin|wp-login\.php|wp-content|xmlrpc\.php|\.env|\.git\/|phpmyadmin|admin\.php|vendor\/phpunit)/i;

function firstMatch(patterns, value) {
  for (const p of patterns) if (p.test(value)) return p;
  return null;
}

// Examines one request. Returns the name of the check that fired, or null.
//
// Separated from the middleware so it can be tested directly against strings,
// which is the only way to be confident about what it does and does not catch.
function inspect({ path, query, userAgent, referer }) {
  const rawPath = String(path || '');
  let decodedPath = rawPath;
  try { decodedPath = decodeURIComponent(rawPath); } catch (e) { /* malformed encoding; the raw form is still checked */ }

  if (NULL_BYTE.test(rawPath) || NULL_BYTE.test(decodedPath)) return 'nullbyte';
  if (TRAVERSAL.test(rawPath) || TRAVERSAL.test(decodedPath)) return 'traversal';
  if (KNOWN_PROBES.test(decodedPath)) return 'probe';

  // Query VALUES, and the keys too — a parameter name is as good a place to
  // hide something as its value.
  const queryText = Object.entries(query || {})
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`)
    .join('&');

  if (queryText) {
    let decodedQuery = queryText;
    try { decodedQuery = decodeURIComponent(queryText); } catch (e) { /* as above */ }
    if (NULL_BYTE.test(decodedQuery)) return 'nullbyte';
    if (TRAVERSAL.test(decodedQuery)) return 'traversal';
    if (firstMatch(SQLI, decodedQuery)) return 'sqli';
    if (firstMatch(XSS, decodedQuery)) return 'xss';
  }

  // Headers an attacker controls and that end up in logs, emails or pages.
  if (userAgent && (NULL_BYTE.test(userAgent) || firstMatch(XSS, userAgent))) return 'header';
  if (referer && firstMatch(XSS, referer)) return 'header';

  return null;
}

function middleware(req, res, next) {
  // Bodies are not scanned (see the note at the top), but their SIZE is
  // bounded — an enormous JSON payload is a way to spend the instance's
  // memory regardless of what is in it.
  const declared = Number(req.get('content-length') || 0);
  if (declared > MAX_JSON_BYTES && !String(req.get('content-type') || '').includes('multipart/')) {
    recordDenial(null, req, 'oversize');
    return res.status(413).json({ error: 'That request is too large.' });
  }

  const verdict = inspect({
    path: req.path,
    query: req.query,
    userAgent: req.get('user-agent'),
    referer: req.get('referer'),
  });

  if (!verdict) return next();

  recordDenial(null, req, verdict);
  // The same flat answer for every check. Telling a scanner which rule caught
  // it tells them precisely what to change.
  res.status(403).json({ error: 'Access denied.' });
}

module.exports = { middleware, inspect, MAX_JSON_BYTES, SQLI, XSS, TRAVERSAL, KNOWN_PROBES };
