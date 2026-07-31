const prisma = require('../prisma');
const {
  MONEY_EPSILON,
  buildDebtUpdateFromState,
  roundMoney,
  simulatePaymentsForDebt,
} = require('../services/debt.service');
const {
  createPixPayment,
  getMercadoPagoCredentialsForAccount,
  getPayment,
  mapPaymentStatus,
  searchPayments,
  validateWebhookSignature,
} = require('../services/mercadopago.service');
const { applySaasPaymentResult } = require('../services/saas.service');

function onlyDigits(value) {
  return String(value || '').replace(/\D+/g, '');
}

function splitName(name) {
  const parts = String(name || 'Cliente').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: 'Cliente', lastName: 'Peguei & Paguei' };
  if (parts.length === 1) return { firstName: parts[0], lastName: 'Peguei & Paguei' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function installmentPrincipalPaid(payment) {
  const principalAmount = Number(payment.principalAmount || 0);
  if (principalAmount > MONEY_EPSILON) return principalAmount;
  return String(payment.type || '').toUpperCase() === 'PARCELA'
    ? Number(payment.amount || 0)
    : 0;
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

function startOfDay(date = new Date()) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function daysUntil(date, from = new Date()) {
  const due = startOfDay(date).getTime();
  const today = startOfDay(from).getTime();
  return Math.max(Math.ceil((due - today) / 86400000), 0);
}

function buildAnticipationQuote(installment) {
  const remaining = roundMoney(
    Math.max(Number(installment.amount || 0) - Number(installment.paidAmount || 0), 0),
  );
  const earlyDays = daysUntil(installment.dueDate);
  const dailyDiscountRate = Number(process.env.ANTICIPATION_DAILY_DISCOUNT_RATE || 0.0015);
  const maxDiscountRate = Number(process.env.ANTICIPATION_MAX_DISCOUNT_RATE || 0.30);
  const discountRate = earlyDays > 0
    ? Math.min(Math.max(dailyDiscountRate, 0) * earlyDays, Math.max(maxDiscountRate, 0))
    : 0;
  const discountAmount = roundMoney(remaining * discountRate);
  const anticipatedAmount = roundMoney(Math.max(remaining - discountAmount, 0.01));

  return {
    originalAmount: remaining,
    anticipatedAmount,
    discountAmount,
    discountRate,
    earlyDays,
    dueDate: installment.dueDate,
    installmentId: installment.id,
    installmentNumber: installment.installmentNumber,
    available: remaining > MONEY_EPSILON && earlyDays > 0 && installment.status !== 'PAID',
  };
}

function buildMercadoPagoWebhookUrl() {
  const baseUrl = String(process.env.BACKEND_PUBLIC_URL || '').replace(/\/+$/, '');
  if (!baseUrl) return null;
  return `${baseUrl}/api/payments/mercadopago/webhook`;
}

function summarizeStatuses(items, statusKey = 'status') {
  return items.reduce((summary, item) => {
    const status = String(item[statusKey] || 'UNKNOWN').toUpperCase();
    summary[status] = (summary[status] || 0) + Number(item._count?._all || item.count || 0);
    return summary;
  }, {});
}

function serializeAdminIntent(intent) {
  return {
    id: intent.id,
    status: intent.status,
    amount: intent.amount,
    externalReference: intent.externalReference,
    mercadoPagoPaymentId: intent.mercadoPagoPaymentId,
    paidAt: intent.paidAt,
    createdAt: intent.createdAt,
    client: intent.client
      ? {
          id: intent.client.id,
          name: intent.client.name,
          cpf: intent.client.cpf,
          phone: intent.client.phone,
        }
      : null,
    installment: intent.installment
      ? {
          id: intent.installment.id,
          installmentNumber: intent.installment.installmentNumber,
          dueDate: intent.installment.dueDate,
          status: intent.installment.status,
        }
      : null,
    debtId: intent.debtId,
    paymentId: intent.paymentId,
  };
}

async function rebuildInstallmentsForRenegotiation(tx, renegotiationId) {
  if (!renegotiationId) return;

  const installments = await tx.installment.findMany({
    where: { renegotiationId },
    include: {
      payments: {
        where: { deletedAt: null },
        orderBy: { paidAt: 'asc' },
      },
      splits: {
        orderBy: { splitNumber: 'asc' },
      },
    },
    orderBy: { installmentNumber: 'asc' },
  });

  const today = new Date();
  let paidInstallments = 0;

  for (const installment of installments) {
    const totalPaid = roundMoney(
      (installment.payments || []).reduce(
        (sum, payment) => sum + installmentPrincipalPaid(payment),
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

    let remainingForSplits = totalPaid;
    for (const split of installment.splits || []) {
      const splitAmount = Number(split.amount || 0);
      const splitPaid = roundMoney(Math.min(splitAmount, Math.max(0, remainingForSplits)));
      remainingForSplits = roundMoney(Math.max(0, remainingForSplits - splitPaid));

      let splitStatus = 'PENDING';
      if (splitPaid <= MONEY_EPSILON) {
        splitStatus = new Date(split.dueDate) < today ? 'OVERDUE' : 'PENDING';
      } else if (splitPaid + MONEY_EPSILON < splitAmount) {
        splitStatus = 'PARTIAL';
      } else {
        splitStatus = 'PAID';
      }

      await tx.installmentSplit.update({
        where: { id: split.id },
        data: {
          paidAmount: splitPaid,
          paidAt: splitStatus === 'PAID' ? (latestPayment ? latestPayment.paidAt : new Date()) : null,
          status: splitStatus,
        },
      });
    }

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
        where: { deletedAt: null },
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

    let remaining = roundMoney(
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

    if (lockedIntent.kind === 'INSTALLMENT_ANTICIPATION_PIX') {
      remaining = roundMoney(Number(lockedIntent.amount || remaining));
      await tx.installment.update({
        where: { id: installment.id },
        data: {
          amount: remaining,
          note: [
            installment.note,
            'Parcela antecipada com desconto via Pix Mercado Pago.',
          ].filter(Boolean).join('\n'),
        },
      });
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
        note: lockedIntent.kind === 'INSTALLMENT_ANTICIPATION_PIX'
          ? `Antecipacao Pix Mercado Pago ${mercadoPagoPaymentId}`
          : `Pagamento Pix Mercado Pago ${mercadoPagoPaymentId}`,
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

    const externalReference = `pegueipaguei:installment:${installment.id}:${Date.now()}`;
    const idempotencyKey = `installment-${installment.id}-${Date.now()}`;
    const { firstName, lastName } = splitName(client.name);
    const payerEmail =
      client.email ||
      client.user?.email ||
      `cliente-${client.id}@pegueipaguei.local`;
    const mercadoPagoCredentials = await getMercadoPagoCredentialsForAccount(req.user.accountId);

    const mpPayment = await createPixPayment({
      amount: remaining,
      description: `Peguei & Paguei - Parcela ${installment.installmentNumber}`,
      externalReference,
      idempotencyKey,
      accessToken: mercadoPagoCredentials.accessToken,
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
        rawResponse: {
          ...mpPayment,
          credentialSource: mercadoPagoCredentials.credentialSource,
        },
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

async function getInstallmentAnticipationQuote(req, res) {
  try {
    if (req.user.role !== 'CLIENT') {
      return res.status(403).json({ message: 'Apenas CLIENT pode antecipar parcela propria', data: {} });
    }

    const installmentId = Number(req.params.installmentId || req.body.installmentId);
    if (!installmentId) {
      return res.status(400).json({ message: 'installmentId e obrigatorio', data: {} });
    }

    const client = await prisma.client.findFirst({
      where: { userId: req.user.id, accountId: req.user.accountId },
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
      include: { debt: true },
    });

    if (!installment || !installment.debt) {
      return res.status(404).json({ message: 'Parcela nao encontrada', data: {} });
    }

    const quote = buildAnticipationQuote(installment);
    if (!quote.available) {
      return res.status(400).json({
        message: quote.earlyDays <= 0
          ? 'Antecipacao disponivel apenas para parcelas futuras'
          : 'Esta parcela nao esta disponivel para antecipacao',
        data: quote,
      });
    }

    return res.json({
      message: 'Cotacao de antecipacao carregada',
      data: quote,
    });
  } catch (err) {
    console.error('Erro ao cotar antecipacao:', err);
    return res.status(500).json({
      message: err.message || 'Erro ao cotar antecipacao',
      data: {},
    });
  }
}

async function createInstallmentAnticipationPix(req, res) {
  try {
    if (req.user.role !== 'CLIENT') {
      return res.status(403).json({ message: 'Apenas CLIENT pode antecipar parcela propria', data: {} });
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
      include: { debt: true },
    });

    if (!installment || !installment.debt) {
      return res.status(404).json({ message: 'Parcela nao encontrada', data: {} });
    }

    const quote = buildAnticipationQuote(installment);
    if (!quote.available) {
      return res.status(400).json({
        message: quote.earlyDays <= 0
          ? 'Antecipacao disponivel apenas para parcelas futuras'
          : 'Esta parcela nao esta disponivel para antecipacao',
        data: quote,
      });
    }

    const existingIntent = await prisma.paymentIntent.findFirst({
      where: {
        installmentId: installment.id,
        clientId: client.id,
        accountId: req.user.accountId,
        provider: 'MERCADO_PAGO',
        kind: 'INSTALLMENT_ANTICIPATION_PIX',
        status: { in: ['CREATED', 'PENDING', 'IN_PROCESS'] },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existingIntent?.qrCode) {
      return res.json({
        message: 'Cobranca Pix de antecipacao ja existente',
        data: serializeIntent(existingIntent),
      });
    }

    const externalReference = `pegueipaguei:anticipation:${installment.id}:${Date.now()}`;
    const idempotencyKey = `anticipation-${installment.id}-${Date.now()}`;
    const { firstName, lastName } = splitName(client.name);
    const payerEmail = client.email || client.user?.email || `cliente-${client.id}@pegueipaguei.local`;
    const mercadoPagoCredentials = await getMercadoPagoCredentialsForAccount(req.user.accountId);

    const mpPayment = await createPixPayment({
      amount: quote.anticipatedAmount,
      description: `Peguei & Paguei - Antecipacao parcela ${installment.installmentNumber}`,
      externalReference,
      idempotencyKey,
      accessToken: mercadoPagoCredentials.accessToken,
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
        kind: 'INSTALLMENT_ANTICIPATION_PIX',
        status: mapPaymentStatus(mpPayment.status),
        amount: quote.anticipatedAmount,
        currency: 'BRL',
        externalReference,
        idempotencyKey,
        mercadoPagoPaymentId: mpPayment.id ? String(mpPayment.id) : null,
        qrCode: transactionData.qr_code || null,
        qrCodeBase64: transactionData.qr_code_base64 || null,
        ticketUrl: transactionData.ticket_url || null,
        rawResponse: {
          ...mpPayment,
          credentialSource: mercadoPagoCredentials.credentialSource,
          anticipationQuote: quote,
        },
        clientId: client.id,
        debtId: installment.debtId,
        installmentId: installment.id,
        accountId: req.user.accountId,
      },
    });

    return res.status(201).json({
      message: 'Pix de antecipacao criado com sucesso',
      data: {
        ...serializeIntent(intent),
        anticipationQuote: quote,
      },
    });
  } catch (err) {
    console.error('Erro ao criar Pix de antecipacao:', err);
    return res.status(err.statusCode || 500).json({
      message: err.message || 'Erro ao criar Pix de antecipacao',
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
      const mercadoPagoCredentials = await getMercadoPagoCredentialsForAccount(req.user.accountId);
      const mpPayment = await getPayment(intent.mercadoPagoPaymentId, {
        accessToken: mercadoPagoCredentials.accessToken,
      });
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

async function getAdminMercadoPagoSummary(req, res) {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({
        message: 'Apenas ADMIN pode consultar o painel Mercado Pago',
        data: {},
      });
    }

    const accountId = req.user.accountId;
    const mercadoPagoCredentials = await getMercadoPagoCredentialsForAccount(accountId);
    const approvedStatuses = ['APPROVED'];
    const pendingStatuses = ['CREATED', 'PENDING', 'IN_PROCESS'];
    const failedStatuses = ['REJECTED', 'CANCELLED', 'REFUNDED'];

    const [
      statusGroups,
      approvedAmount,
      pendingAmount,
      failedAmount,
      recentIntents,
      webhookGroups,
      recentWebhookLogs,
    ] = await Promise.all([
      prisma.paymentIntent.groupBy({
        by: ['status'],
        where: { accountId, provider: 'MERCADO_PAGO' },
        _count: { _all: true },
      }),
      prisma.paymentIntent.aggregate({
        where: { accountId, provider: 'MERCADO_PAGO', status: { in: approvedStatuses } },
        _sum: { amount: true },
      }),
      prisma.paymentIntent.aggregate({
        where: { accountId, provider: 'MERCADO_PAGO', status: { in: pendingStatuses } },
        _sum: { amount: true },
      }),
      prisma.paymentIntent.aggregate({
        where: { accountId, provider: 'MERCADO_PAGO', status: { in: failedStatuses } },
        _sum: { amount: true },
      }),
      prisma.paymentIntent.findMany({
        where: { accountId, provider: 'MERCADO_PAGO' },
        include: {
          client: true,
          installment: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      prisma.webhookLog.groupBy({
        by: ['processed', 'signatureValid'],
        where: {
          provider: 'MERCADO_PAGO',
          OR: [{ accountId }, { accountId: null }],
        },
        _count: { _all: true },
      }),
      prisma.webhookLog.findMany({
        where: {
          provider: 'MERCADO_PAGO',
          OR: [{ accountId }, { accountId: null }],
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);

    let mercadoPagoApi = {
      status: mercadoPagoCredentials.accessTokenConfigured ? 'NOT_CHECKED' : 'NOT_CONFIGURED',
      approvedAmount: 0,
      pendingAmount: 0,
      paymentsCount: 0,
      recentPayments: [],
      error: null,
    };

    if (mercadoPagoCredentials.accessTokenConfigured) {
      try {
        const apiResult = await searchPayments({
          sort: 'date_created',
          criteria: 'desc',
          limit: 20,
        }, {
          accessToken: mercadoPagoCredentials.accessToken,
        });
        const payments = Array.isArray(apiResult.results) ? apiResult.results : [];
        mercadoPagoApi = {
          status: 'OK',
          approvedAmount: payments
            .filter((payment) => payment.status === 'approved')
            .reduce((sum, payment) => sum + Number(payment.transaction_amount || 0), 0),
          pendingAmount: payments
            .filter((payment) => ['pending', 'in_process'].includes(payment.status))
            .reduce((sum, payment) => sum + Number(payment.transaction_amount || 0), 0),
          paymentsCount: payments.length,
          recentPayments: payments.slice(0, 8).map((payment) => ({
            id: payment.id ? String(payment.id) : null,
            status: payment.status,
            statusDetail: payment.status_detail,
            amount: payment.transaction_amount,
            paymentMethodId: payment.payment_method_id,
            externalReference: payment.external_reference,
            dateCreated: payment.date_created,
            dateApproved: payment.date_approved,
          })),
          error: null,
        };
      } catch (err) {
        mercadoPagoApi = {
          ...mercadoPagoApi,
          status: 'ERROR',
          error: err.message || 'Nao foi possivel consultar a API Mercado Pago',
        };
      }
    }

    const webhookCounts = recentWebhookLogs.reduce(
      (summary, log) => {
        if (log.processed) summary.processed += 1;
        if (!log.signatureValid) summary.invalidSignature += 1;
        if (log.processingError) summary.failed += 1;
        return summary;
      },
      { processed: 0, failed: 0, invalidSignature: 0 },
    );

    return res.json({
      message: 'Resumo Mercado Pago carregado',
      data: {
        integration: {
          accessTokenConfigured: mercadoPagoCredentials.accessTokenConfigured,
          publicKeyConfigured: mercadoPagoCredentials.publicKeyConfigured,
          webhookSecretConfigured: mercadoPagoCredentials.webhookSecretConfigured,
          backendPublicUrlConfigured: mercadoPagoCredentials.backendPublicUrlConfigured,
          credentialSource: mercadoPagoCredentials.credentialSource,
          webhookSecretSource: mercadoPagoCredentials.webhookSecretSource,
          maskedAccessToken: mercadoPagoCredentials.maskedAccessToken,
          maskedPublicKey: mercadoPagoCredentials.maskedPublicKey,
          maskedWebhookSecret: mercadoPagoCredentials.maskedWebhookSecret,
          webhookUrl: buildMercadoPagoWebhookUrl(),
          sandboxRecommended: true,
        },
        local: {
          statusCounts: summarizeStatuses(statusGroups),
          approvedAmount: approvedAmount._sum.amount || 0,
          pendingAmount: pendingAmount._sum.amount || 0,
          failedAmount: failedAmount._sum.amount || 0,
          recentIntents: recentIntents.map(serializeAdminIntent),
        },
        webhook: {
          counts: webhookCounts,
          groupedCounts: webhookGroups.map((group) => ({
            processed: group.processed,
            signatureValid: group.signatureValid,
            count: group._count._all,
          })),
          recentLogs: recentWebhookLogs.map((log) => ({
            id: log.id,
            eventType: log.eventType,
            resourceId: log.resourceId,
            signatureValid: log.signatureValid,
            processed: log.processed,
            processingError: log.processingError,
            createdAt: log.createdAt,
          })),
        },
        mercadoPagoApi,
      },
    });
  } catch (err) {
    console.error('Erro ao carregar resumo Mercado Pago:', err);
    return res.status(500).json({
      message: err.message || 'Erro ao carregar resumo Mercado Pago',
      data: {},
    });
  }
}

async function mercadoPagoWebhook(req, res) {
  const payload = req.body || {};
  const initialResourceId = req.query?.['data.id'] || req.query?.id || payload?.data?.id || payload?.id || payload?.resource;
  const knownIntent = initialResourceId
    ? await prisma.paymentIntent.findFirst({
        where: {
          provider: 'MERCADO_PAGO',
          mercadoPagoPaymentId: String(initialResourceId),
        },
        select: { id: true, accountId: true },
      })
    : null;
  const knownSaasIntent = !knownIntent && initialResourceId
    ? await prisma.saasPaymentIntent.findFirst({
        where: {
          provider: 'MERCADO_PAGO',
          mercadoPagoPaymentId: String(initialResourceId),
        },
        select: { id: true, accountId: true },
      })
    : null;
  const mercadoPagoCredentials = knownIntent
    ? await getMercadoPagoCredentialsForAccount(knownIntent.accountId)
    : knownSaasIntent
      ? await getMercadoPagoCredentialsForAccount(null)
    : await getMercadoPagoCredentialsForAccount(null);
  const validation = validateWebhookSignature({
    headers: req.headers,
    query: req.query,
    payload: req.body,
    secret: mercadoPagoCredentials.webhookSecret,
  });
  const resourceId = validation.dataId || payload?.data?.id || payload?.id || payload?.resource;
  const eventType = payload?.type || payload?.action || req.query?.type || null;

  const log = await prisma.webhookLog.create({
    data: {
      provider: 'MERCADO_PAGO',
      eventType: eventType ? String(eventType) : null,
      eventId: payload?.id ? String(payload.id) : null,
      resourceId: resourceId ? String(resourceId) : null,
      accountId: knownIntent?.accountId || knownSaasIntent?.accountId || null,
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

    const mpPayment = await getPayment(resourceId, {
      accessToken: mercadoPagoCredentials.accessToken,
    });
    let result = await applyApprovedPayment(mpPayment, { rawWebhook: payload });
    if (result.reason === 'PAYMENT_INTENT_NOT_FOUND') {
      result = await applySaasPaymentResult({
        mercadoPagoPaymentId: mpPayment.id,
        externalReference: mpPayment.external_reference,
        status: mapPaymentStatus(mpPayment.status),
        rawResponse: mpPayment,
        rawWebhook: payload,
        paidAt: mpPayment.date_approved ? new Date(mpPayment.date_approved) : undefined,
      });
    }

    await prisma.webhookLog.update({
      where: { id: log.id },
      data: {
        processed: true,
        accountId: result.intentId
          ? (await prisma.paymentIntent.findUnique({ where: { id: result.intentId } }))?.accountId
          : result.saasIntentId
            ? (await prisma.saasPaymentIntent.findUnique({ where: { id: result.saasIntentId } }))?.accountId
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
  createInstallmentAnticipationPix,
  getAdminMercadoPagoSummary,
  getInstallmentAnticipationQuote,
  getPixIntentStatus,
  mercadoPagoWebhook,
};

