const express = require('express');
const authMiddleware = require('../authMiddleware');
const { changePassword, getSecurityOverview } = require('../controllers/security.controller');

const router = express.Router();

router.get('/overview', authMiddleware, getSecurityOverview);
router.post('/change-password', authMiddleware, changePassword);

module.exports = router;
