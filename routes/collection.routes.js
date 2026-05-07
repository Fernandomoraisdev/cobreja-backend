const express = require('express');
const authMiddleware = require('../authMiddleware');
const {
  listCollectionAutomation,
  registerCollectionGenerated,
} = require('../controllers/collection.controller');

const router = express.Router();

router.get('/automation-summary', authMiddleware, listCollectionAutomation);
router.post('/installments/:installmentId/generated', authMiddleware, registerCollectionGenerated);

module.exports = router;
