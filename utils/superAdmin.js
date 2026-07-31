function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function getSuperAdminEmails() {
  return String(process.env.SUPER_ADMIN_EMAILS || '')
    .split(',')
    .map(normalizeEmail)
    .filter(Boolean);
}

function isSuperAdminUser(user = {}) {
  user = user || {};
  const emails = getSuperAdminEmails();
  return user.role === 'ADMIN' &&
    emails.length > 0 &&
    emails.includes(normalizeEmail(user.email));
}

function getEffectiveRole(user = {}) {
  user = user || {};
  if (isSuperAdminUser(user)) return 'SUPER_ADMIN';
  if (user.role === 'CLIENT') return 'CLIENT';
  if (user.role === 'ADMIN') return 'ADMIN';
  return 'UNKNOWN';
}

function getUserPermissions(user = {}) {
  const effectiveRole = getEffectiveRole(user);
  return {
    effectiveRole,
    isSuperAdmin: effectiveRole === 'SUPER_ADMIN',
    isAdmin: effectiveRole === 'SUPER_ADMIN' || effectiveRole === 'ADMIN',
    isClient: effectiveRole === 'CLIENT',
    canAccessSuperAdminPanel: effectiveRole === 'SUPER_ADMIN',
    canAccessAdminPanel: effectiveRole === 'SUPER_ADMIN' || effectiveRole === 'ADMIN',
    canAccessClientPanel: effectiveRole === 'CLIENT',
  };
}

function requireSuperAdmin(req, res, next) {
  if (!isSuperAdminUser(req.user)) {
    return res.status(403).json({
      message: 'Apenas SUPER ADMIN pode acessar este recurso',
      data: {},
    });
  }

  return next();
}

module.exports = {
  getSuperAdminEmails,
  getEffectiveRole,
  getUserPermissions,
  isSuperAdminUser,
  requireSuperAdmin,
};
