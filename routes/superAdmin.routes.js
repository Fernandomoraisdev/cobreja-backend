const express = require('express');
const authMiddleware = require('../authMiddleware');
const { requireSuperAdmin } = require('../utils/superAdmin');
const {
  getSuperAdminOverview,
  listSuperAdminAccounts,
  listSuperAdminSubscriptions,
  listSuperAdminPayments,
  listSuperAdminSaasPayments,
  listSuperAdminSupport,
  listSuperAdminAuditLogs,
  listSuperAdminWebhooks,
  updateAccountStatus,
  changeSuperAdminAccountPlan,
  cancelSuperAdminScheduledPlanChange,
  renewSuperAdminSubscription,
  impersonateAccountAdmin,
  impersonateClientUser,
} = require('../controllers/superAdmin.controller');
const {
  getOperationsHealth,
  exportOperationsBackup,
  restoreOperationsBackup,
} = require('../controllers/operations.controller');

const router = express.Router();

router.use(authMiddleware, requireSuperAdmin);

router.get('/overview', getSuperAdminOverview);
router.get('/accounts', listSuperAdminAccounts);
router.get('/subscriptions', listSuperAdminSubscriptions);
router.get('/payments', listSuperAdminPayments);
router.get('/saas-payments', listSuperAdminSaasPayments);
router.get('/support', listSuperAdminSupport);
router.get('/logs', listSuperAdminAuditLogs);
router.get('/webhooks', listSuperAdminWebhooks);
router.get('/operations/health', getOperationsHealth);
router.get('/operations/backup', exportOperationsBackup);
router.post('/operations/restore', restoreOperationsBackup);
router.patch('/accounts/:accountId/status', updateAccountStatus);
router.post('/accounts/:accountId/plan', changeSuperAdminAccountPlan);
router.delete('/accounts/:accountId/plan-schedule', cancelSuperAdminScheduledPlanChange);
router.post('/accounts/:accountId/subscription/renew', renewSuperAdminSubscription);
router.post('/accounts/:accountId/impersonate', impersonateAccountAdmin);
router.post('/impersonate-client', impersonateClientUser);
router.post('/accounts/:accountId/impersonate-client', impersonateClientUser);

module.exports = router;
