const assert = require('node:assert/strict');
const test = require('node:test');

const {
  getEffectiveRole,
  getUserPermissions,
  isSuperAdminUser,
} = require('../utils/superAdmin');

const previousSuperAdminEmails = process.env.SUPER_ADMIN_EMAILS;

test.afterEach(() => {
  if (previousSuperAdminEmails === undefined) {
    delete process.env.SUPER_ADMIN_EMAILS;
  } else {
    process.env.SUPER_ADMIN_EMAILS = previousSuperAdminEmails;
  }
});

test('admin email configured as super admin receives SUPER_ADMIN effective role', () => {
  process.env.SUPER_ADMIN_EMAILS = 'fernandomorais.ads@gmail.com, outro@email.com';

  const user = {
    role: 'ADMIN',
    email: 'FernandoMorais.ADS@gmail.com',
  };

  assert.equal(isSuperAdminUser(user), true);
  assert.equal(getEffectiveRole(user), 'SUPER_ADMIN');
  assert.deepEqual(getUserPermissions(user), {
    effectiveRole: 'SUPER_ADMIN',
    isSuperAdmin: true,
    isAdmin: true,
    isClient: false,
    canAccessSuperAdminPanel: true,
    canAccessAdminPanel: true,
    canAccessClientPanel: false,
  });
});

test('client email configured as super admin remains CLIENT', () => {
  process.env.SUPER_ADMIN_EMAILS = 'cliente@email.com';

  const user = {
    role: 'CLIENT',
    email: 'cliente@email.com',
  };

  assert.equal(isSuperAdminUser(user), false);
  assert.equal(getEffectiveRole(user), 'CLIENT');
  assert.equal(getUserPermissions(user).canAccessSuperAdminPanel, false);
});

test('normal admin keeps ADMIN effective role', () => {
  process.env.SUPER_ADMIN_EMAILS = 'super@email.com';

  const user = {
    role: 'ADMIN',
    email: 'admin@email.com',
  };

  assert.equal(isSuperAdminUser(user), false);
  assert.equal(getEffectiveRole(user), 'ADMIN');
  assert.equal(getUserPermissions(user).canAccessAdminPanel, true);
});

test('missing user is handled as UNKNOWN without permissions', () => {
  process.env.SUPER_ADMIN_EMAILS = 'super@email.com';

  assert.equal(isSuperAdminUser(null), false);
  assert.equal(getEffectiveRole(null), 'UNKNOWN');
  assert.deepEqual(getUserPermissions(null), {
    effectiveRole: 'UNKNOWN',
    isSuperAdmin: false,
    isAdmin: false,
    isClient: false,
    canAccessSuperAdminPanel: false,
    canAccessAdminPanel: false,
    canAccessClientPanel: false,
  });
});
