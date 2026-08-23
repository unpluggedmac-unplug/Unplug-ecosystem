// Who is refused before anything else runs.
//
// Two layers, in this order, and the order is the design:
//
//   1. ALLOW rules. Anything on the allow list is let through and no further
//      check applies to it.
//   2. BLOCK rules — a single address, a range, or an account.
//
// WHY ALLOW WINS. The realistic accident here is not an attacker slipping
// past. Cloudflare sits in front of the site and handles most of that. It is
// an admin blocking a range that turns out to contain their own office, or a
// large slice of a South African mobile network, and locking themselves out of
// the screen they would use to undo it. The allow list is the way back in, so
// it is consulted first and cannot be overridden.
//
// THE RULES ARE CACHED, BRIEFLY. This runs on every request and the rule set
// changes perhaps weekly, so re-reading the table each time would be a query
// per request to nearly always get the same answer. Fifteen seconds is short
// enough that a block applied during an incident takes effect while the person
// is still looking at the screen, and the admin routes clear the cache on
// write so their own changes are immediate.
//
// IF THE DATABASE IS UNREACHABLE, EVERYONE IS LET THROUGH. Failing closed here
// would mean a database blip takes the whole site offline in order to enforce
// a list that is usually empty. That trade is not worth making for a magazine.

const pool = require('../db');
const { inCidr, sameAddress } = require('../utils/ipMatch');

const CACHE_MS = 15 * 1000;
let cache = { rules: [], at: 0 };

function invalidate() { cache = { rules: [], at: 0 }; }

async function rules() {
  const now = Date.now();
  if (cache.at && now - cache.at < CACHE_MS) return cache.rules;
  try {
    const r = await pool.query(
      `SELECT id, effect, kind, value FROM access_rules
        WHERE expires_at IS NULL OR expires_at > now()`);
    cache = { rules: r.rows, at: now };
  } catch (err) {
    // Deliberately keeps serving the last known set rather than emptying it:
    // a momentary database problem should not quietly lift every block.
    console.error('[access] could not load rules:', err.message);
    cache.at = now;
  }
  return cache.rules;
}

function matches(rule, { ip, email, country }) {
  switch (rule.kind) {
    case 'ip':      return ip ? sameAddress(ip, rule.value) : false;
    case 'cidr':    return ip ? inCidr(ip, rule.value) : false;
    case 'account': return email ? String(email).toLowerCase() === String(rule.value).toLowerCase() : false;
    // Needs a GeoIP lookup, which needs a MaxMind licence key. Until one is
    // configured this never matches, and a country rule sits in the table
    // doing nothing rather than silently blocking the wrong people.
    case 'country': return country ? String(country).toUpperCase() === String(rule.value).toUpperCase() : false;
    default:        return false;
  }
}

// Decides on one request. Exported separately from the middleware so it can be
// tested without an HTTP server.
async function decide({ ip, email, country }) {
  const all = await rules();
  const subject = { ip, email, country };

  const allowed = all.find((r) => r.effect === 'allow' && matches(r, subject));
  if (allowed) return { allowed: true, rule: allowed };

  const blocked = all.find((r) => r.effect === 'block' && matches(r, subject));
  if (blocked) return { allowed: false, rule: blocked };

  return { allowed: true, rule: null };
}

// Counts the hit and records what was refused. Not awaited by the request —
// somebody being refused should not also be kept waiting.
function recordDenial(rule, req, deniedBy) {
  const ctx = require('./requestContext').current();
  pool.query(
    `UPDATE access_rules SET hit_count = hit_count + 1, last_hit_at = now() WHERE id = $1`,
    [rule ? rule.id : null]
  ).catch(() => { /* a statistic must never be the reason a refusal fails */ });

  pool.query(
    `INSERT INTO access_denials (rule_id, ip_address, path, user_agent, denied_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [rule ? rule.id : null, ctx.ip || null,
     (req.originalUrl || '').split('?')[0].slice(0, 300),
     (req.get('user-agent') || '').slice(0, 300) || null, deniedBy || 'rule']
  ).catch((e) => console.error('[access] could not record denial:', e.message));
}

function middleware(req, res, next) {
  const ctx = require('./requestContext').current();
  // req.user is populated by attachUser, which runs before this; an account
  // block therefore follows the person rather than the machine.
  const email = req.user && req.user.email;

  decide({ ip: ctx.ip, email, country: req.get('cf-ipcountry') || null })
    .then((verdict) => {
      if (verdict.allowed) return next();
      recordDenial(verdict.rule, req, 'rule');
      // 403, and nothing about why. A blocked party learning which rule caught
      // them learns exactly what to change.
      res.status(403).json({ error: 'Access denied.' });
    })
    .catch((err) => {
      // See the note at the top: a failure here lets the request through.
      console.error('[access] check failed, allowing request:', err.message);
      next();
    });
}

module.exports = { middleware, decide, invalidate, recordDenial, rules };
