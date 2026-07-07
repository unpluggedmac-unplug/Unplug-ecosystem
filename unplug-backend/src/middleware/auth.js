const jwt = require('jsonwebtoken');

// Verifies the JWT on incoming requests. If valid, attaches req.user.
// If missing or invalid, req.user stays undefined — routes decide whether
// that's acceptable (many endpoints allow guest/read-only access).
function attachUser(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next();
  }
  const token = header.slice('Bearer '.length);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { id, email, role }
  } catch (err) {
    // Invalid/expired token — treat as guest rather than erroring, so
    // public endpoints still work if a stale token is sent.
  }
  next();
}

// Requires a logged-in user of any role.
function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  next();
}

// Requires one of the given roles. Usage: requireRole('admin')
// or requireRole('admin', 'investor') for multiple allowed roles.
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to do that.' });
    }
    next();
  };
}

// Allows the resource owner OR an admin — e.g. a member editing their own
// profile, or an admin editing anyone's. `getOwnerId` extracts the owning
// user_id from the request (usually after a DB lookup in the route itself).
function requireOwnerOrAdmin(getOwnerId) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    if (req.user.role === 'admin') {
      return next();
    }
    try {
      const ownerId = await getOwnerId(req);
      if (ownerId === req.user.id) {
        return next();
      }
      return res.status(403).json({ error: 'You do not have permission to do that.' });
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { attachUser, requireAuth, requireRole, requireOwnerOrAdmin };
