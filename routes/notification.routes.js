const express = require('express');
const authMiddleware = require('../authMiddleware');
const { getNotificationSummary } = require('../controllers/notification.controller');

const router = express.Router();

router.get('/summary', authMiddleware, getNotificationSummary);

module.exports = router;
