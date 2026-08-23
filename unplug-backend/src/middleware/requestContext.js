// Who is making the request that is currently being handled, available
// anywhere without being passed down.
//
// WHY THIS EXISTS. logActivity(adminId, action, details) is called from
// seventy-eight places. To record the address an action came from, every one
// of those would have to be found and given a `req` — a change touching almost
// every route file, where the cost is not the typing but the certainty that
// some of them get missed and quietly record nothing. A log with holes in it
// is worse than one with none, because you cannot tell the holes from the
// blanks.
//
// AsyncLocalStorage is Node's built-in answer: the middleware puts the request
// details in a store, and anything running during that request can read them,
// however deep. No dependency, no plumbing, and it cannot be forgotten at a
// call site because there is no call site to forget.
//
// WHAT IT DOES NOT DO. Work that outlives the request — a scheduled job, a
// promise deliberately not awaited — runs outside any store and reads back
// empty. That is correct: those actions genuinely have no originating address,
// and inventing one would be the sort of evidence that misleads an
// investigation. Callers that know better can still pass values explicitly.

const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

// The address the request came from.
//
// Express's req.ip already honours x-forwarded-for because app.js sets
// 'trust proxy' — Render terminates TLS at its edge and forwards, so without
// that every request would appear to come from the proxy and this whole
// exercise would record one address for the world.
function addressOf(req) {
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || null;
  if (!ip) return null;
  // IPv4-mapped IPv6 ("::ffff:41.2.3.4") is how a v4 client usually arrives on
  // a dual-stack listener. Stored in its familiar form so that searching for
  // an address someone read off a firewall log actually matches.
  return String(ip).replace(/^::ffff:/, '').slice(0, 64);
}

function middleware(req, res, next) {
  storage.run({
    ip: addressOf(req),
    userAgent: (req.get('user-agent') || '').slice(0, 300) || null,
    method: req.method,
    path: req.originalUrl ? req.originalUrl.split('?')[0].slice(0, 300) : null,
  }, next);
}

// The current request's details, or an empty object outside a request.
function current() {
  return storage.getStore() || {};
}

module.exports = { middleware, current, addressOf };
