const express = require('express');
const authMiddleware = require('../authMiddleware');
const {
  listConversations,
  createConversation,
  addMessage,
  markSupportRead,
  updateConversationStatus,
} = require('../controllers/support.controller');

const router = express.Router();

router.get('/conversations', authMiddleware, listConversations);
router.post('/conversations', authMiddleware, createConversation);
router.post('/conversations/read', authMiddleware, markSupportRead);
router.post('/conversations/:id/messages', authMiddleware, addMessage);
router.post('/conversations/:id/read', authMiddleware, markSupportRead);
router.patch('/conversations/:id/status', authMiddleware, updateConversationStatus);

module.exports = router;
