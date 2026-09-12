function db() { return require('../db'); }

const ALL_PERMISSIONS = [
  'dashboard.view',
  'content.view', 'content.manage',
  'approvals.view', 'approvals.manage',
  'pages.manage', 'media.manage',
  'members.view', 'members.manage',
  'agreements.view', 'agreements.manage',
  'growth.view', 'growth.manage', 'growth.sensitive',
  'events.manage', 'competitions.manage', 'directory.manage',
  'advertising.manage', 'finance.view', 'finance.manage',
  'marketing.manage', 'crm.manage',
  'analytics.view', 'reports.export',
  'staff.manage', 'system.manage',
];

function permissionForRequest(req) {
  const method = String(req.method || 'GET').toUpperCase();
  const path = String(req.originalUrl || req.url || '').split('?')[0].toLowerCase();
  const read = method === 'GET' || method === 'HEAD';

  // Staff/permissions and genuinely dangerous operational surfaces default to
  // system-level access. Staff management itself is Super Admin-only at route
  // level; this mapping remains defensive for future endpoints.
  if (/\/admin\/staff(?:\/|$)/.test(path)) return 'staff.manage';
  if (/\/admin\/overview(?:\/|$)/.test(path)) return 'dashboard.view';
  if (/\/admin\/notifications(?:\/|$)/.test(path)) return 'system.manage';
  if (/\/(security|backups|maintenance)(?:\/|$)/.test(path)
      || /\/admin\/(activity-log|redirects)(?:\/|$)/.test(path)) return 'system.manage';

  // Growth Application is a separate Control Centre domain. Sensitive access
  // is never implied by ordinary manage access and must be granted explicitly.
  if (/\/growth-admin(?:\/|$)/.test(path)) {
    if (/\/sensitive(?:\/|$)/.test(path)) return 'growth.sensitive';
    return read ? 'growth.view' : 'growth.manage';
  }

  if (/\/admin\/approval|\/change-requests|\/(comments|reviews)\/admin|\/pending(?:\/|$)/.test(path)) return read ? 'approvals.view' : 'approvals.manage';
  // Banner placements live under page-cms for historical reasons, but they are
  // an Advertising surface, not a page-layout permission. Keep this specific
  // rule before the generic page-cms rule.
  if (/\/page-cms\/admin\/ad-slots/.test(path)) return 'advertising.manage';
  if (/\/page-cms|\/page-content|\/site-buttons|\/popups/.test(path)) return 'pages.manage';
  if (/\/admin\/media|\/uploads|\/images|\/gallery/.test(path)) return 'media.manage';

  if (/\/payments|\/orders|\/cancellations|\/vouchers|\/credits|\/invoices|\/admin\/payment/.test(path)) {
    return read ? 'finance.view' : 'finance.manage';
  }
  if (/\/admin\/business-reports\/export\.(csv|xls)/.test(path)) return 'reports.export';
  if (/\/admin\/checkout-health/.test(path)) return read ? 'finance.view' : 'finance.manage';
  if (/\/admin\/business-reports/.test(path)) return 'analytics.view';
  if (/\/analytics|\/analytics-reports/.test(path)) return 'analytics.view';
  if (/\/email|\/newsletter|\/bulk-email|\/social/.test(path)) return 'marketing.manage';

  // Agreement Generator is intentionally separate from the generic form
  // builder. Staff only reaches it when Super Admin has granted the explicit
  // Agreement permission; individual records add an assignment check as well.
  if (/\/agreement-forms(?:\/|$)/.test(path)) return read ? 'agreements.view' : 'agreements.manage';

  if (/\/crm|\/inquiries|\/forms/.test(path)) return 'crm.manage';
  if (/\/ad-banners|\/placements|\/sponsors/.test(path)) return 'advertising.manage';
  if (/\/competitions|\/top10|\/votes|\/polls|\/badges|\/participation/.test(path)) return 'competitions.manage';
  if (/\/events|\/calendar/.test(path)) return 'events.manage';
  if (/\/profiles|\/directory|\/claims|\/sales-consultants|\/projects/.test(path)) return 'directory.manage';
  if (/\/admin\/users|\/members|\/my-unplug/.test(path)) return read ? 'members.view' : 'members.manage';
  if (/\/admin\/content|\/articles|\/highlights|\/contributors|\/testimonials|\/impact-makers|\/shoutouts|\/birthdays|\/editions|\/sasl|\/deaf-community|\/admin\/tags/.test(path)) {
    return read ? 'content.view' : 'content.manage';
  }
  if (/\/admin\/search/.test(path)) return 'dashboard.view';

  // Unknown admin-only routes are deliberately closed to staff. A new admin
  // endpoint should not silently become available merely because it exists.
  return 'system.manage';
}

async function getStaffAccess(userId) {
  const result = await db().query(
    `SELECT u.id, u.email, u.role AS account_role,
            r.id AS staff_role_id, r.slug AS staff_role_slug, r.name AS staff_role_name,
            COALESCE(array_agg(p.permission ORDER BY p.permission)
                     FILTER (WHERE p.permission IS NOT NULL), '{}') AS permissions
       FROM users u
       LEFT JOIN staff_assignments a ON a.user_id = u.id
       LEFT JOIN staff_roles r ON r.id = a.role_id
       LEFT JOIN staff_role_permissions p ON p.role_id = r.id
      WHERE u.id = $1
      GROUP BY u.id, u.email, u.role, r.id, r.slug, r.name`,
    [userId]
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  return {
    userId: row.id,
    email: row.email,
    accountRole: row.account_role,
    staffRoleId: row.staff_role_id,
    staffRoleSlug: row.staff_role_slug,
    staffRoleName: row.staff_role_name,
    permissions: row.account_role === 'admin' ? ALL_PERMISSIONS.slice() : (row.permissions || []),
    isSuperAdmin: row.account_role === 'admin',
  };
}

async function hasPermission(userId, permission) {
  const access = await getStaffAccess(userId);
  if (!access) return false;
  if (access.isSuperAdmin) return true;
  if (access.accountRole !== 'staff') return false;
  if (access.permissions.includes(permission)) return true;
  // A manage permission always includes its corresponding read permission.
  const implied = {
    'content.view': 'content.manage',
    'approvals.view': 'approvals.manage',
    'members.view': 'members.manage',
    'agreements.view': 'agreements.manage',
    'finance.view': 'finance.manage',
    'growth.view': 'growth.manage',
  };
  return implied[permission] ? access.permissions.includes(implied[permission]) : false;
}

module.exports = { ALL_PERMISSIONS, permissionForRequest, getStaffAccess, hasPermission };
