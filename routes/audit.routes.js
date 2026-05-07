const express = require('express');
const authMiddleware = require('../authMiddleware');
const { listAuditLogs } = require('../controllers/audit.controller');

const router = express.Router();

router.get('/', authMiddleware, listAuditLogs);

module.exports = router;
