const express = require('express');
const authMiddleware = require('../authMiddleware');
const { getSaasStatus, selectSaasPlan } = require('../controllers/saas.controller');

const router = express.Router();

router.get('/status', authMiddleware, getSaasStatus);
router.post('/select-plan', authMiddleware, selectSaasPlan);

module.exports = router;
