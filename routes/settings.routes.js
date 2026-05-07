const express = require('express');
const authMiddleware = require('../authMiddleware');
const { getSettings, updateSettings } = require('../controllers/settings.controller');

const router = express.Router();

router.get('/', authMiddleware, getSettings);
router.put('/', authMiddleware, updateSettings);

module.exports = router;
