const express = require('express');
const authMiddleware = require('../authMiddleware');
const {
  cancelScheduledSaasPlanChange,
  createPublicSaasSignup,
  createSaasPlanPix,
  getSaasPlanPaymentStatus,
  getSaasStatus,
  listPublicSaasPlans,
  listSaasPlanPayments,
  scheduleSaasPlanChange,
  selectSaasPlan,
} = require('../controllers/saas.controller');

const router = express.Router();

router.get('/public/plans', listPublicSaasPlans);
router.post('/public/signup', createPublicSaasSignup);
router.get('/status', authMiddleware, getSaasStatus);
router.get('/plan-payments', authMiddleware, listSaasPlanPayments);
router.get('/plan-payments/:id/status', authMiddleware, getSaasPlanPaymentStatus);
router.post('/schedule-plan-change', authMiddleware, scheduleSaasPlanChange);
router.delete('/schedule-plan-change', authMiddleware, cancelScheduledSaasPlanChange);
router.post('/select-plan', authMiddleware, selectSaasPlan);
router.post('/plan-payments/pix', authMiddleware, createSaasPlanPix);

module.exports = router;
