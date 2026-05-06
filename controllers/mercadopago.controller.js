const prisma = require('../prisma');
const {
  MONEY_EPSILON,
  buildDebtUpdateFromState,
  roundMoney,
  simulatePaymentsForDebt,
} = require('../services/debt.service');
const {
  createPixPayment,
  getPayment,
  mapPaymentStatus,
  validateWebhookSignature,
} = require('../services/mercadopago.service');

function onlyDigits(value) {
  return String(value || '').replace(/\D+/g, '');
}

function splitName(name) {
  const parts = String(name || 'Cliente').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: 'Cliente', lastName: 'COBREJA' };
  if (parts.length === 1) return { firstName: parts[0], lastName: 'COBREJA' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function serializeIntent(intent) {
  return {
    id: intent.id,
    provider: intent.provider,
    kind: intent.kind,
    status: intent.status,
    amount: intent.amount,
    currency: intent.currency,
    externalReference: intent.externalReference,
    mercadoPagoPaymentId: intent.mercadoPagoPaymentId,
    qrCode: intent.qrCode,
    qrCodeBase64: intent.qrCodeBase64,
    ticketUrl: intent.ticketUrl,
    paidAt: intent.paidAt,
    expiresAt: intent.expiresAt,
    installmentId: intent.installmentId,
    debtId: intent.debtId,
    paymentId: intent.paymentId,
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt,
  };
}

async function rebuildInstallmentsForRenegotiation(tx, renegotiationId) {
  if (!renegotiationId) return;

  const installments = await tx.installment.findMany({
    where: { renegotiationId },
    include: {
      payments: {
        orderBy: { paidAt: 'asc' },
      },
    },
    orderBy: { installmentNumber: 'asc' },
  });

  const today = new Date();
  let paidInstallments = 0;

  for (const installment of installments) {
    const totalPaid = roundMoney(
      (installment.payments || []).reduce(
        (sum, payment) => sum + Number(payment.amount || 0),
        0,
      ),
    );

    let status = 'PENDING';
    if (totalPaid <= MONEY_EPSILON) {
      status = new Date(installment.dueDate) < today ? 'OVERDUE' : 'PENDING';
    } else if (totalPaid + MONEY_EPSILON < Number(installment.amount || 0)) {
      status = 'PARTIAL';
    } else {
      status = 'PAID';
      paidInstallments += 1;
    }

    const latestPayment = (installment.payments || []).length
      ? [...installment.payments].sort(
          (left, right) => new Date(right.paidAt).getTime() - new Date(left.paidAt).getTime(),
        )[0]
      : null;

    await tx.installment.update({
      where: { id: installment.id },
      data: {
        paidAmount: totalPaid,
        paidAt: latestPayment ? latestPayment.paidAt : null,
        status,
      },
    });
  }

  const allPaid = installments.length > 0 && paidInstallments === installments.length;

  await tx.renegotiation.update({
    where: { id: renegotiationId },
    data: {
      status: allPaid ? 'COMPLETED' : 'ACTIVE',
      completedAt: allPaid ? new Date() : null,
    },
  });
}

async function recalculateDebtAndRelations(tx, debtId) {
  const debt = await tx.debt.findFirst({
    where: { id: debtId },
    include: {
      payments: {
        orderBy: { paidAt: 'asc' },
      },
    },
  });

  if (!debt) return null;

  const simulation = simulatePaymentsForDebt(debt, debt.payments || []);

  for (const computedPayment of simulation.computedPayments) {
    await tx.payment.update({
      where: { id: computedPayment.id },
      data: {
        amount: computedPayment.amount,
        principalAmount: computedPayment.principalAmount,
        interestAmount: computedPayment.interestAmount,
        dailyAmount: computedPayment.dailyAmount,
        paidAt: computedPayment.paidAt,
        type: computedPayment.type,
        note: computedPayment.note,
        receiptUrl: computedPayment.receiptUrl,
      },
    });
  }

  const updatedDebt = await tx.debt.update({
    where: { id: debtId },
    data: buildDebtUpdateFromState(simulation.state),
  });

  if (updatedDebt.renegotiationId) {
    await rebuildInstallmentsForRenegotiation(tx, updatedDebt.renegotiationId);
  }

  return updatedDebt;
}

async function applyApprovedPayment(paymentData, { rawWebhook } = {}) {
  const mercadoPagoPaymentId = String(paymentData.id || '');
  const externalReference = String(paymentData.external_reference || '');
  const status = mapPaymentStatus(paymentData.status);

  const intent = await prisma.paymentIntent.findFirst({
    where: {
      OR: [
        ...(mercadoPagoPaymentId ? [{ mercadoPagoPaymentId }] : []),
        ...(externalReference ? [{ externalReference }] : []),
      ],
    },
    include: {
      installment: true,
      debt: true,
    },
  });

  if (!intent) {
    return { applied: false, reason: 'PAYMENT_INTENT_NOT_FOUND' };
  }

  if (status !== 'APPROVED') {
    await prisma.paymentIntent.update({
      where: { id: intent.id },
      data: {
        status,
        mercadoPagoPaymentId: mercadoPagoPaymentId || intent.mercadoPagoPaymentId,
        rawResponse: paymentData,
        rawWebhook: rawWebhook || intent.rawWebhook,
        lastCheckedAt: new Date(),
      },
    });
    return { applied: false, reason: `STATUS_${status}`, intentId: intent.id };
  }

  if (intent.paymentId && intent.status === 'APPROVED') {
    return { applied: false, reason: 'ALREADY_APPLIED', intentId: intent.id };
  }

  const paidAt = paymentData.date_approved
    ? new Date(paymentData.date_approved)
    : new Date();

  const result = await prisma.$transaction(async (tx) => {
    const lockedIntent = await tx.paymentIntent.findUnique({
      where: { id: intent.id },
      include: {
        installment: true,
        debt: true,
      },
    });

    if (!lockedIntent) {
      throw new Error('PAYMENT_INTENT_NOT_FOUND');
    }

    if (lockedIntent.paymentId && lockedIntent.status === 'APPROVED') {
      return { alreadyApplied: true, paymentId: lockedIntent.paymentId };
    }

    const installment = await tx.installment.findFirst({
      where: {
        id: lockedIntent.installmentId,
        accountId: lockedIntent.accountId,
        clientId: lockedIntent.clientId,
      },
    });

    if (!installment) {
      throw new Error('INSTALLMENT_NOT_FOUND');
    }

    const remaining = roundMoney(
      Math.max(Number(installment.amount || 0) - Number(installment.paidAmount || 0), 0),
    );

    if (remaining <= MONEY_EPSILON && installment.status === 'PAID') {
      const updatedIntent = await tx.paymentIntent.update({
        where: { id: lockedIntent.id },
        data: {
          status: 'APPROVED',
          mercadoPagoPaymentId: mercadoPagoPaymentId || lockedIntent.mercadoPagoPaymentId,
          rawResponse: paymentData,
          rawWebhook: rawWebhook || lockedIntent.rawWebhook,
          paidAt,
          lastCheckedAt: new Date(),
        },
      });
      return { alreadyApplied: true, paymentId: updatedIntent.paymentId };
    }

    const amount = roundMoney(Math.min(Number(lockedIntent.amount || remaining), remaining));

    const payment = await tx.payment.create({
      data: {
        type: 'PARCELA',
        amount,
        clientId: lockedIntent.clientId,
        debtId: lockedIntent.debtId,
        installmentId: lockedIntent.installmentId,
        accountId: lockedIntent.accountId,
        paidAt,
        note: `Pagamento Pix Mercado Pago ${mercadoPagoPaymentId}`,
      },
    });

    await tx.paymentIntent.update({
      where: { id: lockedIntent.id },
      data: {
        status: 'APPROVED',
        mercadoPagoPaymentId: mercadoPagoPaymentId || lockedIntent.mercadoPagoPaymentId,
        rawResponse: paymentData,
        rawWebhook: rawWebhook || lockedIntent.rawWebhook,
        paidAt,
        paymentId: payment.id,
        lastCheckedAt: new Date(),
      },
    });

    await recalculateDebtAndRelations(tx, lockedIntent.debtId);

    return { alreadyApplied: false, paymentId: payment.id };
  });

  return { applied: !result.alreadyApplied, paymentId: result.paymentId, intentId: intent.id };
}

async function createInstallmentPix(req, res) {
  try {
    if (req.user.role !== 'CLIENT') {
      return res.status(403).json({ message: 'Apenas CLIENT pode pagar parcela propria', data: {} });
    }

    const installmentId = Number(req.params.installmentId || req.body.installmentId);
    if (!installmentId) {
      return res.status(400).json({ message: 'installmentId e obrigatorio', data: {} });
    }

    const client = await prisma.client.findFirst({
      where: {
        userId: req.user.id,
        accountId: req.user.accountId,
      },
      include: { user: true },
    });

    if (!client) {
      return res.status(404).json({ message: 'Cliente nao encontrado', data: {} });
    }

    const installment = await prisma.installment.findFirst({
      where: {
        id: installmentId,
        accountId: req.user.accountId,
        clientId: client.id,
      },
      include: {
        debt: true,
      },
    });

    if (!installment || !installment.debt) {
      return res.status(404).json({ message: 'Parcela nao encontrada', data: {} });
    }

    const remaining = roundMoney(
      Math.max(Number(installment.amount || 0) - Number(installment.paidAmount || 0), 0),
    );

    if (remaining <= MONEY_EPSILON || installment.status === 'PAID') {
      return res.status(400).json({ message: 'Esta parcela ja esta paga', data: {} });
    }

    const existingIntent = await prisma.paymentIntent.findFirst({
      where: {
        installmentId: installment.id,
        clientId: client.id,
        accountId: req.user.accountId,
        provider: 'MERCADO_PAGO',
        kind: 'INSTALLMENT_PIX',
        status: { in: ['CREATED', 'PENDING', 'IN_PROCESS'] },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existingIntent?.qrCode) {
      return res.json({
        message: 'Cobranca Pix ja existente',
        data: serializeIntent(existingIntent),
      });
    }

    const externalReference = `cobreja:installment:${installment.id}:${Date.now()}`;
    const idempotencyKey = `installment-${installment.id}-${Date.now()}`;
    const { firstName, lastName } = splitName(client.name);
    const payerEmail =
      client.email ||
      client.user?.email ||
      `cliente-${client.id}@cobreja.local`;

    const mpPayment = await createPixPayment({
      amount: remaining,
      description: `COBREJA - Parcela ${installment.installmentNumber}`,
      externalReference,
      idempotencyKey,
      payer: {
        email: payerEmail,
        firstName,
        lastName,
        cpf: onlyDigits(client.cpf || client.user?.cpf),
      },
    });

    const transactionData = mpPayment?.point_of_interaction?.transaction_data || {};
    const intent = await prisma.paymentIntent.create({
      data: {
        provider: 'MERCADO_PAGO',
        kind: 'INSTALLMENT_PIX',
        status: mapPaymentStatus(mpPayment.status),
        amount: remaining,
        currency: 'BRL',
        externalReference,
        idempotencyKey,
        mercadoPagoPaymentId: mpPayment.id ? String(mpPayment.id) : null,
        qrCode: transactionData.qr_code || null,
        qrCodeBase64: transactionData.qr_code_base64 || null,
        ticketUrl: transactionData.ticket_url || null,
        rawResponse: mpPayment,
        clientId: client.id,
        debtId: installment.debtId,
        installmentId: installment.id,
        accountId: req.user.accountId,
      },
    });

    return res.status(201).json({
      message: 'Cobranca Pix criada com sucesso',
      data: serializeIntent(intent),
    });
  } catch (err) {
    console.error('Erro ao criar Pix Mercado Pago:', err);
    return res.status(err.statusCode || 500).json({
      message: err.message || 'Erro ao criar cobranca Pix',
      data: err.response || {},
    });
  }
}

async function getPixIntentStatus(req, res) {
  try {
    if (req.user.role !== 'CLIENT') {
      return res.status(403).json({ message: 'Apenas CLIENT pode consultar Pix de parcela propria', data: {} });
    }

    const intentId = Number(req.params.id);
    if (!intentId) {
      return res.status(400).json({ message: 'ID da cobranca invalido', data: {} });
    }

    const client = await prisma.client.findFirst({
      where: {
        userId: req.user.id,
        accountId: req.user.accountId,
      },
    });

    if (!client) {
      return res.status(404).json({ message: 'Cliente nao encontrado', data: {} });
    }

    let intent = await prisma.paymentIntent.findFirst({
      where: {
        id: intentId,
        clientId: client.id,
        accountId: req.user.accountId,
      },
    });

    if (!intent) {
      return res.status(404).json({ message: 'Cobranca nao encontrada', data: {} });
    }

    if (intent.mercadoPagoPaymentId && !['APPROVED', 'CANCELLED', 'REJECTED', 'REFUNDED'].includes(intent.status)) {
      const mpPayment = await getPayment(intent.mercadoPagoPaymentId);
      await applyApprovedPayment(mpPayment);
      intent = await prisma.paymentIntent.findUnique({ where: { id: intent.id } });
    }

    return res.json({
      message: 'Status carregado com sucesso',
      data: serializeIntent(intent),
    });
  } catch (err) {
    console.error('Erro ao consultar Pix Mercado Pago:', err);
    return res.status(err.statusCode || 500).json({
      message: err.message || 'Erro ao consultar cobranca Pix',
      data: err.response || {},
    });
  }
}

async function mercadoPagoWebhook(req, res) {
  const validation = validateWebhookSignature({
    headers: req.headers,
    query: req.query,
    payload: req.body,
  });
  const payload = req.body || {};
  const resourceId = validation.dataId || payload?.data?.id || payload?.id || payload?.resource;
  const eventType = payload?.type || payload?.action || req.query?.type || null;

  const log = await prisma.webhookLog.create({
    data: {
      provider: 'MERCADO_PAGO',
      eventType: eventType ? String(eventType) : null,
      eventId: payload?.id ? String(payload.id) : null,
      resourceId: resourceId ? String(resourceId) : null,
      signatureValid: validation.valid,
      headers: {
        'x-signature': req.headers['x-signature'] || null,
        'x-request-id': req.headers['x-request-id'] || null,
      },
      payload,
    },
  });

  if (!validation.valid) {
    await prisma.webhookLog.update({
      where: { id: log.id },
      data: {
        processingError: validation.reason || 'Assinatura invalida',
      },
    });
    return res.status(401).json({ message: 'invalid signature' });
  }

  try {
    if (!resourceId) {
      throw new Error('Webhook sem data.id/resource');
    }

    const mpPayment = await getPayment(resourceId);
    const result = await applyApprovedPayment(mpPayment, { rawWebhook: payload });

    await prisma.webhookLog.update({
      where: { id: log.id },
      data: {
        processed: true,
        accountId: result.intentId
          ? (await prisma.paymentIntent.findUnique({ where: { id: result.intentId } }))?.accountId
          : null,
      },
    });

    return res.json({ received: true, result });
  } catch (err) {
    console.error('Erro ao processar webhook Mercado Pago:', err);
    await prisma.webhookLog.update({
      where: { id: log.id },
      data: {
        processingError: err.message || 'Erro ao processar webhook',
      },
    });
    return res.status(200).json({ received: true, processed: false });
  }
}

module.exports = {
  createInstallmentPix,
  getPixIntentStatus,
  mercadoPagoWebhook,
};
