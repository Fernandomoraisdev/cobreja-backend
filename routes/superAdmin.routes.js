const express = require('express');
const authMiddleware = require('../authMiddleware');
const { requireSuperAdmin } = require('../utils/superAdmin');
const {
  getSuperAdminOverview,
  listSuperAdminAccounts,
  listSuperAdminSubscriptions,
  listSuperAdminPayments,
  listSuperAdminSupport,
  listSuperAdminAuditLogs,
  listSuperAdminWebhooks,
  updateAccountStatus,
  changeSuperAdminAccountPlan,
  renewSuperAdminSubscription,
  impersonateAccountAdmin,
} = require('../controllers/superAdmin.controller');

const router = express.Router();

router.use(authMiddleware, requireSuperAdmin);

router.get('/overview', getSuperAdminOverview);
router.get('/accounts', listSuperAdminAccounts);
router.get('/subscriptions', listSuperAdminSubscriptions);
router.get('/payments', listSuperAdminPayments);
router.get('/support', listSuperAdminSupport);
router.get('/logs', listSuperAdminAuditLogs);
router.get('/webhooks', listSuperAdminWebhooks);
router.patch('/accounts/:accountId/status', updateAccountStatus);
router.post('/accounts/:accountId/plan', changeSuperAdminAccountPlan);
router.post('/accounts/:accountId/subscription/renew', renewSuperAdminSubscription);
router.post('/accounts/:accountId/impersonate', impersonateAccountAdmin);

module.exports = router;
