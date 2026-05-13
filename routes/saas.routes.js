const express = require('express');
const authMiddleware = require('../authMiddleware');
const {
  createSaasPlanPix,
  getSaasPlanPaymentStatus,
  getSaasStatus,
  listSaasPlanPayments,
  selectSaasPlan,
} = require('../controllers/saas.controller');

const router = express.Router();

router.get('/status', authMiddleware, getSaasStatus);
router.get('/plan-payments', authMiddleware, listSaasPlanPayments);
router.get('/plan-payments/:id/status', authMiddleware, getSaasPlanPaymentStatus);
router.post('/select-plan', authMiddleware, selectSaasPlan);
router.post('/plan-payments/pix', authMiddleware, createSaasPlanPix);

module.exports = router;
