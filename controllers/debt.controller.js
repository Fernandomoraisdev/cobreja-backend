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

function startOfDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function isSameDay(left, right) {
  if (!left || !right) return false;
  return startOfDay(left).getTime() === startOfDay(right).getTime();
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
        status: 'ACTIVE',
        principalAmount,
        principalOutstanding: principalAmount,
        monthlyInterestMode,
        monthlyInterestValue,
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
      },
      include: {
        payments: {
          orderBy: { paidAt: 'asc' },
        },
      },
    });

    if (!debt) {
      return res.status(404).json({ message: 'Divida nao encontrada', data: {} });
    }

    const requestedDueDate = req.body.dueDate ? new Date(req.body.dueDate) : null;
    const requestedOriginalDueDate = req.body.originalDueDate ? new Date(req.body.originalDueDate) : null;

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
      title: req.body.title !== undefined ? String(req.body.title || '').trim() || null : debt.title,
      principalAmount:
        req.body.principalAmount !== undefined || req.body.amount !== undefined || req.body.total !== undefined
          ? Number(req.body.principalAmount ?? req.body.amount ?? req.body.total)
          : debt.principalAmount,
      principalOutstanding:
        req.body.principalAmount !== undefined || req.body.amount !== undefined || req.body.total !== undefined
          ? Number(req.body.principalAmount ?? req.body.amount ?? req.body.total)
          : debt.principalAmount,
      monthlyInterestMode: normalizeInterestMode(
        req.body.monthlyInterestMode ?? debt.monthlyInterestMode,
        req.body.interestPercent,
        req.body.interestValue,
      ) || debt.monthlyInterestMode,
      monthlyInterestValue:
        req.body.monthlyInterestMode !== undefined || req.body.monthlyInterestValue !== undefined || req.body.interestPercent !== undefined || req.body.interestValue !== undefined
          ? (normalizeInterestMode(req.body.monthlyInterestMode, req.body.interestPercent, req.body.interestValue) === 'PERCENTAGE'
              ? toNullableNumber(req.body.interestPercent ?? req.body.monthlyInterestValue)
              : toNullableNumber(req.body.interestValue ?? req.body.monthlyInterestValue))
          : debt.monthlyInterestValue,
      dailyInterestMode: normalizeInterestMode(
        req.body.dailyInterestMode ?? debt.dailyInterestMode,
        req.body.dailyPercent,
        req.body.dailyFee,
      ) || debt.dailyInterestMode,
      dailyInterestValue:
        req.body.dailyInterestMode !== undefined || req.body.dailyInterestValue !== undefined || req.body.dailyPercent !== undefined || req.body.dailyFee !== undefined
          ? (normalizeInterestMode(req.body.dailyInterestMode, req.body.dailyPercent, req.body.dailyFee) === 'PERCENTAGE'
              ? toNullableNumber(req.body.dailyPercent ?? req.body.dailyInterestValue)
              : toNullableNumber(req.body.dailyFee ?? req.body.dailyInterestValue))
          : debt.dailyInterestValue,
      borrowedAt: req.body.borrowedAt ? new Date(req.body.borrowedAt) : debt.borrowedAt,
      originalDueDate: nextOriginalDueDate,
      // `dueDate` atual sera recalculado via replay (buildDebtUpdateFromState), mas mantemos aqui o valor atual
      // para nao confundir outros usos futuros do draft.
      dueDate: debt.dueDate,
      status: req.body.status ? String(req.body.status).toUpperCase() : debt.status,
      deletedAt:
        req.body.deletedAt !== undefined
          ? (req.body.deletedAt ? new Date(req.body.deletedAt) : null)
          : debt.deletedAt,
    };

    const simulation = simulatePaymentsForDebt(draftDebt, debt.payments || []);

    const updatedDebt = await prisma.debt.update({
      where: { id: debtId },
      data: {
        title: draftDebt.title,
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

    await prisma.$transaction([
      prisma.payment.deleteMany({ where: { debtId } }),
      prisma.installment.deleteMany({ where: { debtId } }),
      prisma.debt.delete({ where: { id: debtId } }),
    ]);

    return res.json({
      message: 'Divida removida com sucesso',
      data: {},
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ message: 'Erro ao remover divida', data: {} });
  }
}

module.exports = {
  getMyDebts,
  createDebt,
  getDebtsByClient,
  updateDebt,
  deleteDebt,
};
