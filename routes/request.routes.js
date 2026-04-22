const express = require('express');
const router = express.Router();

const adminMiddleware = require('../adminMiddleware');
const authMiddleware = require('../authMiddleware');

const { createRequest, getAllRequests, approveRequest, rejectRequest } = require('../controllers/request.controller');

// POST /api/request/credit-request
router.post('/credit-request', authMiddleware, createRequest);
router.get('/credit-requests', authMiddleware, adminMiddleware, getAllRequests);
router.post('/approve-request', authMiddleware, adminMiddleware, approveRequest);
router.post('/reject-request', authMiddleware, adminMiddleware, rejectRequest);

module.exports = router;