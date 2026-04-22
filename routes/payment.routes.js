const express = require('express');
const router = express.Router();

const authMiddleware = require('../authMiddleware');
const adminMiddleware = require('../adminMiddleware');
const {
  createPayment,
  updatePayment,
  deletePayment,
  getMyPayments,
  getPaymentHistory,
  getPaymentHistoryByClient,
} = require('../controllers/payment.controller');

router.post('/', authMiddleware, adminMiddleware, createPayment);
router.put('/:id', authMiddleware, adminMiddleware, updatePayment);
router.delete('/:id', authMiddleware, adminMiddleware, deletePayment);
router.get('/history', authMiddleware, adminMiddleware, getPaymentHistory);
router.get('/client/:clientId', authMiddleware, adminMiddleware, getPaymentHistoryByClient);
router.get('/my-payments', authMiddleware, getMyPayments);

module.exports = router;
