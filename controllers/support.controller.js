const prisma = require('../prisma');
const { writeAuditLog } = require('../services/audit.service');

function onlyDigits(value) {
  return String(value || '').replace(/\D+/g, '');
}

function buildWhatsAppLink(phone, message) {
  const digits = onlyDigits(phone);
  if (!digits) return null;
  const normalized = digits.startsWith('55') ? digits : `55${digits}`;
  return `https://wa.me/${normalized}?text=${encodeURIComponent(message)}`;
}

async function resolveClientForUser(req) {
  if (req.user.role !== 'CLIENT') return null;
  return prisma.client.findFirst({
    where: {
      userId: req.user.id,
      accountId: req.user.accountId,
    },
  });
}

function latestMessage(conversation) {
  const messages = conversation.messages || [];
  if (!messages.length) return null;
  return [...messages].sort(
    (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  )[0];
}

function buildAdminSupportNotification({ conversation, message, settings }) {
  const clientName = conversation.client?.name || 'Cliente';
  const subject = conversation.subject || 'Suporte';
  const companyName = settings?.company?.name || 'PEGUEI&PAGUEI';
  const adminPhone =
    settings?.whatsapp?.adminPhone ||
    settings?.company?.phone ||
    settings?.admin?.phone ||
    null;
  const text = [
    `${companyName} - novo atendimento`,
    `Cliente: ${clientName}`,
    `Assunto: ${subject}`,
    `Mensagem: ${message?.body || 'Sem mensagem'}`,
  ].join('\n');

  return {
    message: text,
    whatsappLink: buildWhatsAppLink(adminPhone, text),
    phoneConfigured: Boolean(onlyDigits(adminPhone)),
  };
}

function serializeConversation(conversation, settings = null) {
  const lastMessage = latestMessage(conversation);
  const needsAdminReply =
    ['OPEN', 'PENDING'].includes(String(conversation.status || '').toUpperCase()) &&
    lastMessage?.direction === 'INBOUND';

  return {
    id: conversation.id,
    subject: conversation.subject,
    status: conversation.status,
    priority: conversation.priority,
    lastMessageAt: conversation.lastMessageAt,
    lastMessage: lastMessage
      ? {
          id: lastMessage.id,
          body: lastMessage.body,
          direction: lastMessage.direction,
          channel: lastMessage.channel,
          createdAt: lastMessage.createdAt,
        }
      : null,
    needsAdminReply,
    adminNotification: needsAdminReply
      ? buildAdminSupportNotification({ conversation, message: lastMessage, settings })
      : null,
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
      readAt: message.readAt,
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

  const [conversations, settings] = await Promise.all([
    prisma.supportConversation.findMany({
    where: {
      accountId,
      ...(req.user.role === 'CLIENT' ? { clientId: client.id } : {}),
    },
    include: {
      client: true,
      messages: { orderBy: { createdAt: 'asc' }, take: 50 },
    },
    orderBy: { lastMessageAt: 'desc' },
    }),
    prisma.accountSettings.findUnique({
      where: { accountId },
      select: { company: true, admin: true, whatsapp: true },
    }),
  ]);

  return res.json({
    message: 'Conversas carregadas',
    data: conversations.map((conversation) => serializeConversation(conversation, settings)),
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

  const settings = await prisma.accountSettings.findUnique({
    where: { accountId },
    select: { company: true, admin: true, whatsapp: true },
  });

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
    metadata: {
      subject,
      role: req.user.role,
      notifyAdmin: req.user.role === 'CLIENT',
      adminNotification: req.user.role === 'CLIENT'
        ? buildAdminSupportNotification({
            conversation,
            message: latestMessage(conversation),
            settings,
          })
        : null,
    },
  });

  return res.status(201).json({
    message: 'Conversa de suporte criada',
    data: serializeConversation(conversation, settings),
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
  const [conversation, settings] = await Promise.all([
    prisma.supportConversation.findFirst({
    where: {
      id: conversationId,
      accountId,
      ...(req.user.role === 'CLIENT' ? { clientId: client?.id || 0 } : {}),
    },
    include: { client: true },
    }),
    prisma.accountSettings.findUnique({
      where: { accountId },
      select: { company: true, admin: true, whatsapp: true },
    }),
  ]);

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
    metadata: {
      role: req.user.role,
      channel: 'IN_APP',
      notifyAdmin: req.user.role === 'CLIENT',
      adminNotification: req.user.role === 'CLIENT'
        ? buildAdminSupportNotification({ conversation, message, settings })
        : null,
    },
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

async function markSupportRead(req, res) {
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ message: 'Apenas ADMIN pode marcar suporte como lido', data: {} });
  }

  const accountId = Number(req.user.accountId);
  const conversationId = Number(req.params.id || req.body.conversationId || 0);
  const readAt = new Date();
  const result = await prisma.supportMessage.updateMany({
    where: {
      accountId,
      direction: 'INBOUND',
      readAt: null,
      ...(conversationId ? { conversationId } : {}),
    },
    data: { readAt },
  });

  if (result.count > 0) {
    await writeAuditLog({
      req,
      action: 'SUPPORT_MESSAGES_READ',
      entity: conversationId ? 'SupportConversation' : 'SupportMessage',
      entityId: conversationId || null,
      metadata: { count: result.count },
    });
  }

  return res.json({
    message: 'Mensagens marcadas como lidas',
    data: { count: result.count, readAt },
  });
}

module.exports = {
  listConversations,
  createConversation,
  addMessage,
  markSupportRead,
  updateConversationStatus,
};
