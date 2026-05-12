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
  const emails = getSuperAdminEmails();
  return emails.length > 0 && emails.includes(normalizeEmail(user.email));
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
  isSuperAdminUser,
  requireSuperAdmin,
};
