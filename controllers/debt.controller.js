const prisma = require('../prisma');
const {
  enrichDebt,
  simulatePaymentsForDebt,
  buildDebtUpdateFromState,
} = require('../services/debt.service');

function normalizeInterestMode(mode, percentValue, fixedValue) {
  if (mode) {
    const normalized = String(mode).toUpperCase();
    if (normalized === 'PERCENTAGE' || normalized === 'FIXED') {
      return normalized;
    }
  }

  if (percentValue !== undefined && percentValue !== null && percentValue !== '') {
    return 'PERCENTAGE';
  }

  if (fixedValue !== undefined && fixedValue !== null && fixedValue !== '') {
    return 'FIXED';
  }

  return null;
}

function toNullableNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDebtType(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (['LOAN', 'INSTALLMENT_SALE', 'SERVICE', 'MANUAL_AGREEMENT'].includes(normalized)) {
    return normalized;
  }
  return 'LOAN';
}

function normalizeDebtTypeInterest({ debtType, monthlyInterestMode, monthlyInterestValue }) {
  if (debtType === 'LOAN') {
    return { monthlyInterestMode, monthlyInterestValue };
  }

  return {
    monthlyInterestMode: null,
    monthlyInterestValue: null,
  };
}

function startOfDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function isSameDay(left, right) {
  if (!left || !right) return false;
  return startOfDay(left).getTime() === startOfDay(right).getTime();
}

function buildDraftDebtForUpdate(debt, body) {
  const requestedDueDate = body.dueDate ? new Date(body.dueDate) : null;
  const requestedOriginalDueDate = body.originalDueDate ? new Date(body.originalDueDate) : null;

  // IMPORTANTE:
  // - `originalDueDate` eh a data-base usada para reprocessar (replay) os pagamentos.
  // - Ela NAO deve ser sobrescrita quando o frontend apenas reenviar `dueDate` sem o usuario mudar nada.
  // - Para manter compatibilidade com o frontend atual (que envia `dueDate`), so tratamos `dueDate`
  //   como alteracao de `originalDueDate` quando ele realmente difere do vencimento atual.
  const nextOriginalDueDate =
    requestedOriginalDueDate
      ? requestedOriginalDueDate
      : requestedDueDate && !isSameDay(requestedDueDate, debt.dueDate)
        ? requestedDueDate
        : debt.originalDueDate;

  const draftDebt = {
    ...debt,
    title: body.title !== undefined ? String(body.title || '').trim() || null : debt.title,
    debtType: body.debtType !== undefined
      ? normalizeDebtType(body.debtType)
      : debt.debtType || 'LOAN',
    principalAmount:
      body.principalAmount !== undefined || body.amount !== undefined || body.total !== undefined
        ? Number(body.principalAmount ?? body.amount ?? body.total)
        : debt.principalAmount,
    principalOutstanding:
      body.principalAmount !== undefined || body.amount !== undefined || body.total !== undefined
        ? Number(body.principalAmount ?? body.amount ?? body.total)
        : debt.principalAmount,
    monthlyInterestMode: normalizeInterestMode(
      body.monthlyInterestMode ?? debt.monthlyInterestMode,
      body.interestPercent,
      body.interestValue,
    ) || debt.monthlyInterestMode,
    monthlyInterestValue:
      body.monthlyInterestMode !== undefined || body.monthlyInterestValue !== undefined || body.interestPercent !== undefined || body.interestValue !== undefined
        ? (normalizeInterestMode(body.monthlyInterestMode, body.interestPercent, body.interestValue) === 'PERCENTAGE'
            ? toNullableNumber(body.interestPercent ?? body.monthlyInterestValue)
            : toNullableNumber(body.interestValue ?? body.monthlyInterestValue))
        : debt.monthlyInterestValue,
    dailyInterestMode: normalizeInterestMode(
      body.dailyInterestMode ?? debt.dailyInterestMode,
      body.dailyPercent,
      body.dailyFee,
    ) || debt.dailyInterestMode,
    dailyInterestValue:
      body.dailyInterestMode !== undefined || body.dailyInterestValue !== undefined || body.dailyPercent !== undefined || body.dailyFee !== undefined
        ? (normalizeInterestMode(body.dailyInterestMode, body.dailyPercent, body.dailyFee) === 'PERCENTAGE'
            ? toNullableNumber(body.dailyPercent ?? body.dailyInterestValue)
            : toNullableNumber(body.dailyFee ?? body.dailyInterestValue))
        : debt.dailyInterestValue,
    borrowedAt: body.borrowedAt ? new Date(body.borrowedAt) : debt.borrowedAt,
    originalDueDate: nextOriginalDueDate,
    // `dueDate` atual sera recalculado via replay (buildDebtUpdateFromState), mas mantemos aqui o valor atual
    // para nao confundir outros usos futuros do draft.
    dueDate: debt.dueDate,
    status: body.status ? String(body.status).toUpperCase() : debt.status,
    deletedAt:
      body.deletedAt !== undefined
        ? (body.deletedAt ? new Date(body.deletedAt) : null)
        : debt.deletedAt,
  };

  const normalizedDraftMonthlyInterest = normalizeDebtTypeInterest({
    debtType: draftDebt.debtType,
    monthlyInterestMode: draftDebt.monthlyInterestMode,
    monthlyInterestValue: draftDebt.monthlyInterestValue,
  });
  draftDebt.monthlyInterestMode = normalizedDraftMonthlyInterest.monthlyInterestMode;
  draftDebt.monthlyInterestValue = normalizedDraftMonthlyInterest.monthlyInterestValue;

  return draftDebt;
}

async function getMyDebts(req, res) {
  try {
    const client = await prisma.client.findUnique({
      where: { userId: req.user.id },
      select: { id: true, accountId: true },
    });

    if (!client) {
      return res.status(404).json({ message: 'Cliente nao encontrado', data: {} });
    }

    const debts = await prisma.debt.findMany({
      where: {
        clientId: client.id,
        accountId: req.user.accountId,
        deletedAt: null,
      },
      include: {
        installments: {
          orderBy: { installmentNumber: 'asc' },
        },
      },
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
    });

    return res.json({
      message: 'Dividas carregadas com sucesso',
      data: debts.map((debt) => enrichDebt(debt)),
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ message: 'Erro ao buscar dividas', data: {} });
  }
}

async function createDebt(req, res) {
  try {
    const clientId = Number(req.body.clientId);
    const dueDate = req.body.dueDate ? new Date(req.body.dueDate) : null;
    const borrowedAt = req.body.borrowedAt ? new Date(req.body.borrowedAt) : new Date();
    const principalAmount = Number(
      req.body.principalAmount ?? req.body.amount ?? req.body.total ?? 0,
    );

    if (!clientId || !dueDate || !principalAmount) {
      return res.status(400).json({
        message: 'clientId, principalAmount e dueDate sao obrigatorios',
        data: {},
      });
    }

    const monthlyInterestMode = normalizeInterestMode(
      req.body.monthlyInterestMode,
      req.body.interestPercent,
      req.body.interestValue,
    );
    const monthlyInterestValue = monthlyInterestMode === 'PERCENTAGE'
      ? toNullableNumber(req.body.interestPercent ?? req.body.monthlyInterestValue)
      : toNullableNumber(req.body.interestValue ?? req.body.monthlyInterestValue);
    const debtType = normalizeDebtType(req.body.debtType);
    const monthlyInterest = normalizeDebtTypeInterest({
      debtType,
      monthlyInterestMode,
      monthlyInterestValue,
    });

    const dailyInterestMode = normalizeInterestMode(
      req.body.dailyInterestMode,
      req.body.dailyPercent,
      req.body.dailyFee,
    );
    const dailyInterestValue = dailyInterestMode === 'PERCENTAGE'
      ? toNullableNumber(req.body.dailyPercent ?? req.body.dailyInterestValue)
      : toNullableNumber(req.body.dailyFee ?? req.body.dailyInterestValue);

    const client = await prisma.client.findFirst({
      where: {
        id: clientId,
        accountId: req.user.accountId,
      },
    });

    if (!client) {
      return res.status(404).json({ message: 'Cliente nao encontrado para esta conta', data: {} });
    }

    const debt = await prisma.debt.create({
      data: {
        title: req.body.title ? String(req.body.title).trim() : null,
        kind: 'STANDARD',
        debtType,
        status: 'ACTIVE',
        principalAmount,
        principalOutstanding: principalAmount,
        monthlyInterestMode: monthlyInterest.monthlyInterestMode,
        monthlyInterestValue: monthlyInterest.monthlyInterestValue,
        dailyInterestMode,
        dailyInterestValue,
        borrowedAt,
        originalDueDate: dueDate,
        dueDate,
        clientId,
        accountId: req.user.accountId,
      },
    });

    return res.status(201).json({
      message: 'Divida criada com sucesso',
      data: enrichDebt(debt),
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ message: 'Erro ao criar divida', data: {} });
  }
}

async function getDebtsByClient(req, res) {
  try {
    const clientId = Number(req.params.clientId);

    if (!clientId) {
      return res.status(400).json({ message: 'ID do cliente invalido', data: {} });
    }

    const client = await prisma.client.findFirst({
      where: {
        id: clientId,
        accountId: req.user.accountId,
      },
    });

    if (!client) {
      return res.status(404).json({ message: 'Cliente nao encontrado', data: {} });
    }

    const debts = await prisma.debt.findMany({
      where: {
        clientId,
        accountId: req.user.accountId,
        deletedAt: null,
      },
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
    });

    return res.json({
      message: 'Dividas listadas com sucesso',
      data: debts.map((debt) => enrichDebt(debt)),
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ message: 'Erro ao listar dividas do cliente', data: {} });
  }
}

async function previewDebtUpdate(req, res) {
  try {
    const debtId = Number(req.params.id);

    if (!debtId) {
      return res.status(400).json({ message: 'ID da divida invalido', data: {} });
    }

    const debt = await prisma.debt.findFirst({
      where: {
        id: debtId,
        accountId: req.user.accountId,
        deletedAt: null,
      },
      include: {
        payments: {
          where: { deletedAt: null },
          orderBy: { paidAt: 'asc' },
        },
      },
    });

    if (!debt) {
      return res.status(404).json({ message: 'Divida nao encontrada', data: {} });
    }

    const draftDebt = buildDraftDebtForUpdate(debt, req.body);
    const simulation = simulatePaymentsForDebt(draftDebt, debt.payments || []);
    const afterDebt = {
      ...draftDebt,
      ...buildDebtUpdateFromState(simulation.state),
    };

    return res.json({
      message: 'Previa da edicao calculada',
      data: {
        before: enrichDebt(debt),
        after: enrichDebt(afterDebt),
        paymentCount: (debt.payments || []).length,
      },
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ message: 'Erro ao calcular previa da divida', data: {} });
  }
}

async function updateDebt(req, res) {
  try {
    const debtId = Number(req.params.id);

    if (!debtId) {
      return res.status(400).json({ message: 'ID da divida invalido', data: {} });
    }

    const debt = await prisma.debt.findFirst({
      where: {
        id: debtId,
        accountId: req.user.accountId,
        deletedAt: null,
      },
      include: {
        payments: {
          where: { deletedAt: null },
          orderBy: { paidAt: 'asc' },
        },
      },
    });

    if (!debt) {
      return res.status(404).json({ message: 'Divida nao encontrada', data: {} });
    }

    const draftDebt = buildDraftDebtForUpdate(debt, req.body);
    const simulation = simulatePaymentsForDebt(draftDebt, debt.payments || []);

    const updatedDebt = await prisma.debt.update({
      where: { id: debtId },
      data: {
        title: draftDebt.title,
        debtType: draftDebt.debtType,
        principalAmount: draftDebt.principalAmount,
        monthlyInterestMode: draftDebt.monthlyInterestMode,
        monthlyInterestValue: draftDebt.monthlyInterestValue,
        dailyInterestMode: draftDebt.dailyInterestMode,
        dailyInterestValue: draftDebt.dailyInterestValue,
        borrowedAt: draftDebt.borrowedAt,
        originalDueDate: draftDebt.originalDueDate,
        ...buildDebtUpdateFromState(simulation.state),
      },
    });

    return res.json({
      message: 'Divida atualizada com sucesso',
      data: enrichDebt(updatedDebt),
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ message: 'Erro ao atualizar divida', data: {} });
  }
}

async function deleteDebt(req, res) {
  try {
    const debtId = Number(req.params.id);

    if (!debtId) {
      return res.status(400).json({ message: 'ID da divida invalido', data: {} });
    }

    const debt = await prisma.debt.findFirst({
      where: {
        id: debtId,
        accountId: req.user.accountId,
      },
    });

    if (!debt) {
      return res.status(404).json({ message: 'Divida nao encontrada', data: {} });
    }

    await prisma.debt.update({
      where: { id: debtId },
      data: {
        status: 'EXCLUDED',
        deletedAt: new Date(),
      },
    });

    return res.json({
      message: 'Divida movida para excluidos com sucesso',
      data: {},
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ message: 'Erro ao remover divida', data: {} });
  }
}

async function restoreDebt(req, res) {
  try {
    const debtId = Number(req.params.id);

    if (!debtId) {
      return res.status(400).json({ message: 'ID da divida invalido', data: {} });
    }

    const debt = await prisma.debt.findFirst({
      where: {
        id: debtId,
        accountId: req.user.accountId,
      },
      include: {
        payments: {
          where: { deletedAt: null },
          orderBy: { paidAt: 'asc' },
        },
        installments: {
          orderBy: { installmentNumber: 'asc' },
        },
      },
    });

    if (!debt) {
      return res.status(404).json({ message: 'Divida nao encontrada', data: {} });
    }

    const simulation = simulatePaymentsForDebt(
      {
        ...debt,
        status: 'ACTIVE',
        deletedAt: null,
      },
      debt.payments || [],
    );

    const restoredDebt = await prisma.debt.update({
      where: { id: debtId },
      data: {
        status: 'ACTIVE',
        deletedAt: null,
        settledAt: null,
        ...buildDebtUpdateFromState(simulation.state),
      },
      include: {
        installments: {
          orderBy: { installmentNumber: 'asc' },
        },
      },
    });

    return res.json({
      message: 'Divida restaurada com sucesso',
      data: enrichDebt(restoredDebt),
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ message: 'Erro ao restaurar divida', data: {} });
  }
}

module.exports = {
  getMyDebts,
  createDebt,
  getDebtsByClient,
  previewDebtUpdate,
  updateDebt,
  deleteDebt,
  restoreDebt,
};
