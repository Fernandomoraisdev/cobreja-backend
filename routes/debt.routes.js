const express = require('express');
const router = express.Router();

const {
  getMyDebts,
  createDebt,
  getDebtsByClient,
  updateDebt,
  deleteDebt
} = require('../controllers/debt.controller');
const authMiddleware = require('../authMiddleware');
const adminMiddleware = require('../adminMiddleware');

router.post('/', authMiddleware, adminMiddleware, createDebt);
router.get('/client/:clientId', authMiddleware, adminMiddleware, getDebtsByClient);
router.put('/:id', authMiddleware, adminMiddleware, updateDebt);
router.delete('/:id', authMiddleware, adminMiddleware, deleteDebt);

// GET /api/debt/my-debts
router.get('/my-debts', authMiddleware, getMyDebts);

module.exports = router;