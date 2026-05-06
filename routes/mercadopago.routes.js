const express = require('express');
const authMiddleware = require('../authMiddleware');
const {
  createInstallmentPix,
  getPixIntentStatus,
  mercadoPagoWebhook,
} = require('../controllers/mercadopago.controller');

const router = express.Router();

router.post('/installments/:installmentId/pix', authMiddleware, createInstallmentPix);
router.get('/intents/:id/status', authMiddleware, getPixIntentStatus);
router.post('/webhook', mercadoPagoWebhook);

module.exports = router;
