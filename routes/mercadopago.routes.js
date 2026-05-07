const express = require('express');
const authMiddleware = require('../authMiddleware');
const {
  createInstallmentPix,
  createInstallmentAnticipationPix,
  getAdminMercadoPagoSummary,
  getInstallmentAnticipationQuote,
  getPixIntentStatus,
  mercadoPagoWebhook,
} = require('../controllers/mercadopago.controller');

const router = express.Router();

router.get('/admin/summary', authMiddleware, getAdminMercadoPagoSummary);
router.get('/installments/:installmentId/anticipation/quote', authMiddleware, getInstallmentAnticipationQuote);
router.post('/installments/:installmentId/anticipation/pix', authMiddleware, createInstallmentAnticipationPix);
router.post('/installments/:installmentId/pix', authMiddleware, createInstallmentPix);
router.get('/intents/:id/status', authMiddleware, getPixIntentStatus);
router.post('/webhook', mercadoPagoWebhook);

module.exports = router;
