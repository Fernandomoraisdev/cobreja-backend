const express = require('express');
const authMiddleware = require('../authMiddleware');
const { requireSuperAdmin } = require('../utils/superAdmin');
const {
  getSuperAdminOverview,
  listSuperAdminAccounts,
  updateAccountStatus,
  changeSuperAdminAccountPlan,
  impersonateAccountAdmin,
} = require('../controllers/superAdmin.controller');

const router = express.Router();

router.use(authMiddleware, requireSuperAdmin);

router.get('/overview', getSuperAdminOverview);
router.get('/accounts', listSuperAdminAccounts);
router.patch('/accounts/:accountId/status', updateAccountStatus);
router.post('/accounts/:accountId/plan', changeSuperAdminAccountPlan);
router.post('/accounts/:accountId/impersonate', impersonateAccountAdmin);

module.exports = router;
