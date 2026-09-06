const express = require('express');
const pool = require('../db');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');
const { ALL_PERMISSIONS, getStaffAccess } = require('../utils/staffPermissions');
const { logActivity } = require('./activityLog');

const router = express.Router();

function staffOnly(req, res, next) {
  if (!req.user || !['admin', 'staff'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Control Centre access is required.' });
  }
  next();
}

// GET /admin/staff/access — used by the dashboard to hide tools the signed-in
// staff member cannot use. Super Admin receives every capability.
router.get('/access', requireAuth, staffOnly, async (req, res, next) => {
  try {
    const access = await getStaffAccess(req.user.id);
    if (!access || (!access.isSuperAdmin && access.accountRole !== 'staff')) {
      return res.status(403).json({ error: 'Control Centre access is required.' });
    }
    res.json({ access });
  } catch (err) { next(err); }
});

router.get('/roles', requireSuperAdmin, async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT r.id, r.slug, r.name, r.description, r.is_system, r.created_at, r.updated_at,
              COALESCE(array_agg(p.permission ORDER BY p.permission)
                       FILTER (WHERE p.permission IS NOT NULL), '{}') AS permissions,
              (SELECT COUNT(*)::int FROM staff_assignments a WHERE a.role_id = r.id) AS assigned_count
         FROM staff_roles r
         LEFT JOIN staff_role_permissions p ON p.role_id = r.id
        GROUP BY r.id ORDER BY r.is_system DESC, r.name`);
    res.json({ roles: r.rows, allPermissions: ALL_PERMISSIONS });
  } catch (err) { next(err); }
});

router.post('/roles', requireSuperAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const name = String(req.body.name || '').trim().slice(0, 80);
    const description = String(req.body.description || '').trim().slice(0, 300) || null;
    const slug = String(req.body.slug || name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    const permissions = [...new Set(['dashboard.view', ...(Array.isArray(req.body.permissions) ? req.body.permissions : [])])]
      .filter((p) => ALL_PERMISSIONS.includes(p));
    if (!name || !slug) return res.status(400).json({ error: 'Role name is required.' });
    await client.query('BEGIN');
    const role = await client.query(
      `INSERT INTO staff_roles (slug, name, description, is_system) VALUES ($1,$2,$3,false) RETURNING *`,
      [slug, name, description]);
    for (const permission of permissions) {
      await client.query(`INSERT INTO staff_role_permissions (role_id, permission) VALUES ($1,$2)`, [role.rows[0].id, permission]);
    }
    await client.query('COMMIT');
    await logActivity(req.user.id, 'staff_role_created', `${name}: ${permissions.join(', ') || 'no permissions'}`);
    res.status(201).json({ role: { ...role.rows[0], permissions } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(409).json({ error: 'A staff role with that name/slug already exists.' });
    next(err);
  } finally { client.release(); }
});

router.patch('/roles/:id', requireSuperAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Valid role id required.' });
    const existing = await client.query('SELECT * FROM staff_roles WHERE id=$1', [id]);
    if (!existing.rowCount) return res.status(404).json({ error: 'Staff role not found.' });
    const name = req.body.name === undefined ? existing.rows[0].name : String(req.body.name || '').trim().slice(0,80);
    const description = req.body.description === undefined ? existing.rows[0].description : String(req.body.description || '').trim().slice(0,300) || null;
    const permissions = req.body.permissions === undefined ? null
      : [...new Set(['dashboard.view', ...(Array.isArray(req.body.permissions) ? req.body.permissions : [])])].filter((p) => ALL_PERMISSIONS.includes(p));
    if (!name) return res.status(400).json({ error: 'Role name is required.' });
    await client.query('BEGIN');
    await client.query(`UPDATE staff_roles SET name=$1, description=$2, updated_at=now() WHERE id=$3`, [name, description, id]);
    if (permissions) {
      await client.query('DELETE FROM staff_role_permissions WHERE role_id=$1', [id]);
      for (const permission of permissions) {
        await client.query(`INSERT INTO staff_role_permissions (role_id, permission) VALUES ($1,$2)`, [id, permission]);
      }
    }
    await client.query('COMMIT');
    await logActivity(req.user.id, 'staff_role_updated', `${name}${permissions ? ': ' + permissions.join(', ') : ''}`);
    res.json({ updated: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally { client.release(); }
});

router.delete('/roles/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const role = await pool.query('SELECT * FROM staff_roles WHERE id=$1', [id]);
    if (!role.rowCount) return res.status(404).json({ error: 'Staff role not found.' });
    if (role.rows[0].is_system) return res.status(409).json({ error: 'Built-in roles cannot be deleted. You can change their permissions instead.' });
    const used = await pool.query('SELECT COUNT(*)::int AS n FROM staff_assignments WHERE role_id=$1', [id]);
    if (used.rows[0].n) return res.status(409).json({ error: 'This role is assigned to staff. Reassign them before deleting it.' });
    await pool.query('DELETE FROM staff_roles WHERE id=$1', [id]);
    await logActivity(req.user.id, 'staff_role_deleted', role.rows[0].name);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

router.get('/accounts', requireSuperAdmin, async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT u.id, u.email, u.full_name, u.role AS account_role, u.is_suspended, u.created_at,
              r.id AS staff_role_id, r.slug AS staff_role_slug, r.name AS staff_role_name,
              a.assigned_at
         FROM users u
         LEFT JOIN staff_assignments a ON a.user_id = u.id
         LEFT JOIN staff_roles r ON r.id = a.role_id
        WHERE u.role IN ('admin','staff')
        ORDER BY (u.role='admin') DESC, u.full_name NULLS LAST, u.email`);
    res.json({ staff: r.rows });
  } catch (err) { next(err); }
});

router.get('/candidates', requireSuperAdmin, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ users: [] });
    const r = await pool.query(
      `SELECT id, email, full_name, role FROM users
        WHERE role <> 'admin' AND (email ILIKE $1 OR full_name ILIKE $1)
        ORDER BY full_name NULLS LAST, email LIMIT 25`, [`%${q}%`]);
    res.json({ users: r.rows });
  } catch (err) { next(err); }
});

router.post('/assign', requireSuperAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const userId = Number(req.body.userId), staffRoleId = Number(req.body.staffRoleId);
    if (!Number.isInteger(userId) || !Number.isInteger(staffRoleId)) return res.status(400).json({ error: 'User and staff role are required.' });
    if (userId === req.user.id) return res.status(400).json({ error: 'Your Super Admin account cannot be converted to a staff account.' });
    await client.query('BEGIN');
    const target = await client.query('SELECT id,email,role FROM users WHERE id=$1 FOR UPDATE', [userId]);
    if (!target.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found.' }); }
    if (target.rows[0].role === 'admin') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Another Super Admin cannot be converted here.' }); }
    const role = await client.query('SELECT id,name FROM staff_roles WHERE id=$1', [staffRoleId]);
    if (!role.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Staff role not found.' }); }
    const existing = await client.query('SELECT original_role FROM staff_assignments WHERE user_id=$1', [userId]);
    const originalRole = existing.rowCount ? existing.rows[0].original_role : target.rows[0].role;
    await client.query(`UPDATE users SET role='staff' WHERE id=$1`, [userId]);
    await client.query(
      `INSERT INTO staff_assignments (user_id, role_id, assigned_by, original_role)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id) DO UPDATE SET role_id=EXCLUDED.role_id, assigned_by=EXCLUDED.assigned_by, updated_at=now()`,
      [userId, staffRoleId, req.user.id, originalRole]);
    await client.query('COMMIT');
    await logActivity(req.user.id, 'staff_access_assigned', `${target.rows[0].email}: ${role.rows[0].name}`);
    res.json({ assigned: true, message: `${target.rows[0].email} is now ${role.rows[0].name}. They must sign in again for the new access to take effect.` });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {}); next(err);
  } finally { client.release(); }
});

router.delete('/accounts/:userId', requireSuperAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId)) return res.status(400).json({ error: 'Valid user id required.' });
    if (userId === req.user.id) return res.status(400).json({ error: 'You cannot remove your own Super Admin access.' });
    await client.query('BEGIN');
    const a = await client.query(
      `SELECT a.original_role, u.email, u.role FROM staff_assignments a JOIN users u ON u.id=a.user_id WHERE a.user_id=$1 FOR UPDATE`, [userId]);
    if (!a.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'That user has no staff assignment.' }); }
    const restore = ['member','investor','advertiser','consultant'].includes(a.rows[0].original_role) ? a.rows[0].original_role : 'member';
    await client.query('DELETE FROM staff_assignments WHERE user_id=$1', [userId]);
    await client.query('UPDATE users SET role=$1 WHERE id=$2', [restore, userId]);
    await client.query('COMMIT');
    await logActivity(req.user.id, 'staff_access_removed', `${a.rows[0].email}: restored to ${restore}`);
    res.json({ removed: true, message: `Staff access removed. Account restored to ${restore}.` });
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); next(err); }
  finally { client.release(); }
});

module.exports = router;
