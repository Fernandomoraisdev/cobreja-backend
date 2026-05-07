const prisma = require('../prisma');
const { writeAuditLog } = require('../services/audit.service');

async function resolveClientForUser(req) {
  if (req.user.role !== 'CLIENT') return null;
  return prisma.client.findFirst({
    where: {
      userId: req.user.id,
      accountId: req.user.accountId,
    },
  });
}

function serializeConversation(conversation) {
  return {
    id: conversation.id,
    subject: conversation.subject,
    status: conversation.status,
    priority: conversation.priority,
    lastMessageAt: conversation.lastMessageAt,
    client: conversation.client
      ? {
          id: conversation.client.id,
          name: conversation.client.name,
          phone: conversation.client.phone,
          email: conversation.client.email,
        }
      : null,
    messages: (conversation.messages || []).map((message) => ({
      id: message.id,
      body: message.body,
      direction: message.direction,
      channel: message.channel,
      senderUserId: message.senderUserId,
      clientId: message.clientId,
      createdAt: message.createdAt,
    })),
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

async function listConversations(req, res) {
  const accountId = Number(req.user.accountId);
  const client = await resolveClientForUser(req);

  if (req.user.role === 'CLIENT' && !client) {
    return res.status(404).json({ message: 'Cliente nao encontrado', data: [] });
  }

  const conversations = await prisma.supportConversation.findMany({
    where: {
      accountId,
      ...(req.user.role === 'CLIENT' ? { clientId: client.id } : {}),
    },
    include: {
      client: true,
      messages: { orderBy: { createdAt: 'asc' }, take: 50 },
    },
    orderBy: { lastMessageAt: 'desc' },
  });

  return res.json({
    message: 'Conversas carregadas',
    data: conversations.map(serializeConversation),
  });
}

async function createConversation(req, res) {
  const accountId = Number(req.user.accountId);
  const body = String(req.body.body || '').trim();
  const subject = String(req.body.subject || 'Suporte').trim();

  if (!body) {
    return res.status(400).json({ message: 'Mensagem e obrigatoria', data: {} });
  }

  const client = await resolveClientForUser(req);
  const requestedClientId = Number(req.body.clientId);

  if (req.user.role === 'CLIENT' && !client) {
    return res.status(404).json({ message: 'Cliente nao encontrado', data: {} });
  }

  const clientId = req.user.role === 'CLIENT'
    ? client.id
    : (requestedClientId || null);

  if (req.user.role === 'ADMIN' && clientId) {
    const exists = await prisma.client.findFirst({
      where: { id: clientId, accountId },
    });
    if (!exists) {
      return res.status(404).json({ message: 'Cliente nao encontrado nesta conta', data: {} });
    }
  }

  const conversation = await prisma.supportConversation.create({
    data: {
      subject,
      accountId,
      clientId,
      openedByUserId: req.user.id,
      messages: {
        create: {
          body,
          direction: req.user.role === 'ADMIN' ? 'OUTBOUND' : 'INBOUND',
          channel: 'IN_APP',
          accountId,
          senderUserId: req.user.id,
          clientId,
        },
      },
    },
    include: {
      client: true,
      messages: { orderBy: { createdAt: 'asc' } },
    },
  });

  await writeAuditLog({
    req,
    action: 'SUPPORT_CONVERSATION_CREATED',
    entity: 'SupportConversation',
    entityId: conversation.id,
    metadata: { subject, role: req.user.role },
  });

  return res.status(201).json({
    message: 'Conversa de suporte criada',
    data: serializeConversation(conversation),
  });
}

async function addMessage(req, res) {
  const accountId = Number(req.user.accountId);
  const conversationId = Number(req.params.id);
  const body = String(req.body.body || '').trim();

  if (!conversationId) {
    return res.status(400).json({ message: 'Conversa invalida', data: {} });
  }
  if (!body) {
    return res.status(400).json({ message: 'Mensagem e obrigatoria', data: {} });
  }

  const client = await resolveClientForUser(req);
  const conversation = await prisma.supportConversation.findFirst({
    where: {
      id: conversationId,
      accountId,
      ...(req.user.role === 'CLIENT' ? { clientId: client?.id || 0 } : {}),
    },
  });

  if (!conversation) {
    return res.status(404).json({ message: 'Conversa nao encontrada', data: {} });
  }

  const message = await prisma.supportMessage.create({
    data: {
      body,
      direction: req.user.role === 'ADMIN' ? 'OUTBOUND' : 'INBOUND',
      channel: 'IN_APP',
      conversationId,
      accountId,
      senderUserId: req.user.id,
      clientId: conversation.clientId,
    },
  });

  await prisma.supportConversation.update({
    where: { id: conversationId },
    data: {
      status: 'OPEN',
      lastMessageAt: message.createdAt,
    },
  });

  await writeAuditLog({
    req,
    action: 'SUPPORT_MESSAGE_SENT',
    entity: 'SupportConversation',
    entityId: conversationId,
    metadata: { role: req.user.role, channel: 'IN_APP' },
  });

  return res.status(201).json({
    message: 'Mensagem enviada',
    data: message,
  });
}

async function updateConversationStatus(req, res) {
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ message: 'Apenas ADMIN pode alterar status do suporte', data: {} });
  }

  const accountId = Number(req.user.accountId);
  const conversationId = Number(req.params.id);
  const status = String(req.body.status || '').trim().toUpperCase();
  const allowed = ['OPEN', 'PENDING', 'RESOLVED', 'CLOSED'];

  if (!allowed.includes(status)) {
    return res.status(400).json({ message: 'Status invalido', data: {} });
  }

  const conversation = await prisma.supportConversation.updateMany({
    where: { id: conversationId, accountId },
    data: { status },
  });

  if (!conversation.count) {
    return res.status(404).json({ message: 'Conversa nao encontrada', data: {} });
  }

  await writeAuditLog({
    req,
    action: 'SUPPORT_STATUS_UPDATED',
    entity: 'SupportConversation',
    entityId: conversationId,
    metadata: { status },
  });

  return res.json({ message: 'Status atualizado', data: { id: conversationId, status } });
}

module.exports = {
  listConversations,
  createConversation,
  addMessage,
  updateConversationStatus,
};
