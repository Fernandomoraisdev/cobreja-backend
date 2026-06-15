const express = require('express');
const router = express.Router();

const authMiddleware = require('../authMiddleware');
const adminMiddleware = require('../adminMiddleware');
const {
  createRenegotiation,
  getRenegotiations,
  getRenegotiationsByClient,
  cancelRenegotiation,
} = require('../controllers/renegotiation.controller');

router.post('/', authMiddleware, adminMiddleware, createRenegotiation);
router.get('/', authMiddleware, adminMiddleware, getRenegotiations);
router.get('/client/:clientId', authMiddleware, adminMiddleware, getRenegotiationsByClient);
router.post('/:id/cancel', authMiddleware, adminMiddleware, cancelRenegotiation);

module.exports = router;
