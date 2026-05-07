const express = require('express');
const authMiddleware = require('../authMiddleware');
const adminMiddleware = require('../adminMiddleware');
const { getFinancialAnalytics } = require('../controllers/analytics.controller');

const router = express.Router();

router.get('/financial', authMiddleware, adminMiddleware, getFinancialAnalytics);

module.exports = router;
