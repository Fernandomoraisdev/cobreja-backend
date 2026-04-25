const express = require('express');
const router = express.Router();

const authMiddleware = require('../authMiddleware');
const adminMiddleware = require('../adminMiddleware');
const {
  getMyRequests,
  linkClient,
  createClient,
  createClientLogin,
  mergeClientDuplicates,
  getClientsSummary,
  getClients,
  getClientById,
  updateClient,
  deleteClient,
  restoreClient,
  permanentlyDeleteClient,
} = require('../controllers/client.controller');

router.post('/clients', authMiddleware, adminMiddleware, createClient);
router.post('/clients/:id/create-login', authMiddleware, adminMiddleware, createClientLogin);
router.post('/clients/:id/merge-duplicates', authMiddleware, adminMiddleware, mergeClientDuplicates);
router.get('/clients', authMiddleware, adminMiddleware, getClients);
router.get('/clients/summary', authMiddleware, adminMiddleware, getClientsSummary);
router.get('/clients/:id', authMiddleware, adminMiddleware, getClientById);
router.put('/clients/:id', authMiddleware, adminMiddleware, updateClient);
router.delete('/clients/:id', authMiddleware, adminMiddleware, deleteClient);
router.patch('/clients/:id/restore', authMiddleware, adminMiddleware, restoreClient);
router.delete('/clients/:id/permanent', authMiddleware, adminMiddleware, permanentlyDeleteClient);
router.get('/my-requests', authMiddleware, getMyRequests);
router.post('/link-client', authMiddleware, adminMiddleware, linkClient);

module.exports = router;
