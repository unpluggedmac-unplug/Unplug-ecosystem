const jwt = require('jsonwebtoken');
const pool = require('../db');

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
    const ctx = require('./requestContext').current();
    if (ctx) ctx.actorRole = payload.role === 'staff' ? 'staff' : (payload.role === 'admin' ? 'admin' : 'member');
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
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    if (allowedRoles.includes(req.user.role)) return next();

    // Existing admin routes number in the hundreds. Rather than replacing every
    // guard, staff accounts are allowed through an existing admin guard only
    // when the capability inferred for THIS request is assigned to them.
    if (allowedRoles.includes('admin') && req.user.role === 'staff') {
      try {
        const { permissionForRequest, hasPermission } = require('../utils/staffPermissions');
        const permission = permissionForRequest(req);
        if (await hasPermission(req.user.id, permission)) {
          req.staffPermission = permission;
          return next();
        }
      } catch (err) {
        return next(err);
      }
    }
    return res.status(403).json({ error: 'You do not have permission to do that.' });
  };
}

// Super Admin means the actual account role in the database is `admin`. This
// intentionally does NOT accept a staff capability: only Super Admin can grant
// staff access, alter role templates, or create another unrestricted admin.
function requireSuperAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  pool.query('SELECT role FROM users WHERE id = $1', [req.user.id])
    .then((r) => {
      if (!r.rowCount || r.rows[0].role !== 'admin') {
        return res.status(403).json({ error: 'Super Admin access is required.' });
      }
      next();
    })
    .catch(next);
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

module.exports = { attachUser, requireAuth, requireRole, requireSuperAdmin, requireOwnerOrAdmin };
