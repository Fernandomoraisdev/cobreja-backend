const prisma = require('../prisma');
const {
  addMonthsKeepingDay,
  calculateDebtSnapshot,
  enrichDebt,
  roundMoney,
} = require('../services/debt.service');

function normalizeInterestMode(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return [ 'PERCENTAGE', 'FIXED' ].includes(normalized) ? normalized : null;
}

function serializeInstallment(installment) {
  return {
    id: installment.id,
    installmentNumber: installment.installmentNumber,
    amount: installment.amount,
    paidAmount: installment.paidAmount,
    dueDate: installment.dueDate,
    paidAt: installment.paidAt,
    status: installment.status,
    note: installment.note,
    debtId: installment.debtId,
    renegotiationId: installment.renegotiationId,
    createdAt: installment.createdAt,
    updatedAt: installment.updatedAt,
  };
}

function serializeRenegotiation(renegotiation) {
  return {
    id: renegotiation.id,
    status: renegotiation.status,
    originalTotal: renegotiation.originalTotal,
    multiplier: renegotiation.multiplier,
    negotiatedTotal: renegotiation.negotiatedTotal,
    installmentCount: renegotiation.installmentCount,
    installmentAmount: renegotiation.installmentAmount,
    startedAt: renegotiation.startedAt,
    firstDueDate: renegotiation.firstDueDate,
    dailyInterestMode: renegotiation.dailyInterestMode,
    dailyInterestValue: renegotiation.dailyInterestValue,
    note: renegotiation.note,
    sourceDebtIds: renegotiation.sourceDebtIds,
    completedAt: renegotiation.completedAt,
    createdAt: renegotiation.createdAt,
    updatedAt: renegotiation.updatedAt,
    client: renegotiation.client
      ? {
          id: renegotiation.client.id,
          name: renegotiation.client.name,
          phone: renegotiation.client.phone,
          email: renegotiation.client.email,
          cpf: renegotiation.client.cpf,
        }
      : null,
    debts: (renegotiation.debts || []).map((debt) => enrichDebt(debt)),
    installments: (renegotiation.installments || []).map(serializeInstallment),
  };
}

function buildInstallmentSchedule(firstDueDate, installmentCount, installmentAmount, negotiatedTotal) {
  const installments = [];
  let accumulated = 0;

  for (let index = 0; index < installmentCount; index += 1) {
    const amount = index === installmentCount - 1
      ? roundMoney(negotiatedTotal - accumulated)
      : installmentAmount;

    accumulated = roundMoney(accumulated + amount);
    installments.push({
      installmentNumber: index + 1,
      amount,
      dueDate: addMonthsKeepingDay(firstDueDate, index),
    });
  }

  return installments;
}

async function createRenegotiation(req, res) {
  try {
    const clientId = Number(req.body.clientId);
    const debtIds = Array.isArray(req.body.debtIds)
      ? req.body.debtIds.map((item) => Number(item)).filter(Boolean)
      : [];
    const multiplier = req.body.multiplier !== undefined ? Number(req.body.multiplier) : null;
    const manualTotal = req.body.negotiatedTotal !== undefined
      ? Number(req.body.negotiatedTotal)
      : req.body.newTotal !== undefined
        ? Number(req.body.newTotal)
        : null;
    const installmentCount = Number(req.body.installmentCount || 1);
    const firstDueDate = req.body.firstDueDate
      ? new Date(req.body.firstDueDate)
      : req.body.newDueDate
        ? new Date(req.body.newDueDate)
        : null;
    const startedAt = req.body.startedAt ? new Date(req.body.startedAt) : new Date();
    const dailyInterestMode = normalizeInterestMode(req.body.dailyInterestMode);
    const dailyInterestValue = req.body.dailyInterestValue !== undefined
      ? Number(req.body.dailyInterestValue)
      : null;
    const note = req.body.note ? String(req.body.note).trim() : null;

    if (!clientId || !installmentCount || !firstDueDate) {
      return res.status(400).json({
        message: 'clientId, installmentCount e firstDueDate sao obrigatorios',
        data: {},
      });
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

    const sourceDebts = await prisma.debt.findMany({
      where: {
        clientId,
        accountId: req.user.accountId,
        status: 'ACTIVE',
        deletedAt: null,
        ...(debtIds.length ? { id: { in: debtIds } } : {}),
      },
      orderBy: { dueDate: 'asc' },
    });

    if (!sourceDebts.length) {
      return res.status(404).json({
        message: 'Nenhuma divida ativa encontrada para renegociar',
        data: {},
      });
    }

    const originalTotal = roundMoney(
      sourceDebts.reduce(
        (sum, debt) => sum + calculateDebtSnapshot(debt).totalDue,
        0,
      ),
    );

    const negotiatedTotal = manualTotal && manualTotal > 0
      ? roundMoney(manualTotal)
      : roundMoney(originalTotal * (multiplier || 1));

    const installmentAmount = roundMoney(negotiatedTotal / installmentCount);
    const schedule = buildInstallmentSchedule(
      firstDueDate,
      installmentCount,
      installmentAmount,
      negotiatedTotal,
    );

    const renegotiation = await prisma.$transaction(async (tx) => {
      const createdRenegotiation = await tx.renegotiation.create({
        data: {
          status: 'ACTIVE',
          originalTotal,
          multiplier,
          negotiatedTotal,
          installmentCount,
          installmentAmount,
          startedAt,
          firstDueDate,
          dailyInterestMode,
          dailyInterestValue,
          note,
          sourceDebtIds: sourceDebts.map((debt) => debt.id),
          clientId,
          accountId: req.user.accountId,
        },
      });

      await tx.debt.updateMany({
        where: {
          id: { in: sourceDebts.map((debt) => debt.id) },
          accountId: req.user.accountId,
        },
        data: {
          status: 'RENEGOTIATED',
        },
      });

      const renegotiatedDebt = await tx.debt.create({
        data: {
          title: 'Renegociacao',
          kind: 'RENEGOTIATED',
          status: 'ACTIVE',
          principalAmount: negotiatedTotal,
          principalOutstanding: negotiatedTotal,
          borrowedAt: startedAt,
          originalDueDate: firstDueDate,
          dueDate: firstDueDate,
          dailyInterestMode,
          dailyInterestValue,
          clientId,
          accountId: req.user.accountId,
          renegotiationId: createdRenegotiation.id,
        },
      });

      for (const item of schedule) {
        await tx.installment.create({
          data: {
            installmentNumber: item.installmentNumber,
            amount: item.amount,
            dueDate: item.dueDate,
            status: 'PENDING',
            clientId,
            accountId: req.user.accountId,
            renegotiationId: createdRenegotiation.id,
            debtId: renegotiatedDebt.id,
          },
        });
      }

      return tx.renegotiation.findUnique({
        where: { id: createdRenegotiation.id },
        include: {
          client: true,
          debts: {
            orderBy: { createdAt: 'desc' },
          },
          installments: {
            orderBy: { installmentNumber: 'asc' },
          },
        },
      });
    });

    return res.status(201).json({
      message: 'Renegociacao criada com sucesso',
      data: serializeRenegotiation(renegotiation),
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ message: 'Erro ao renegociar divida', data: {} });
  }
}

async function getRenegotiations(req, res) {
  try {
    const renegotiations = await prisma.renegotiation.findMany({
      where: {
        accountId: req.user.accountId,
      },
      include: {
        client: true,
        debts: {
          orderBy: { createdAt: 'desc' },
        },
        installments: {
          orderBy: { installmentNumber: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({
      message: 'Renegociacoes listadas com sucesso',
      data: renegotiations.map(serializeRenegotiation),
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ message: 'Erro ao listar renegociacoes', data: {} });
  }
}

async function getRenegotiationsByClient(req, res) {
  try {
    const clientId = Number(req.params.clientId);
    if (!clientId) {
      return res.status(400).json({ message: 'ID do cliente invalido', data: {} });
    }

    const renegotiations = await prisma.renegotiation.findMany({
      where: {
        clientId,
        accountId: req.user.accountId,
      },
      include: {
        client: true,
        debts: {
          orderBy: { createdAt: 'desc' },
        },
        installments: {
          orderBy: { installmentNumber: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({
      message: 'Renegociacoes do cliente listadas com sucesso',
      data: renegotiations.map(serializeRenegotiation),
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ message: 'Erro ao listar renegociacoes do cliente', data: {} });
  }
}

module.exports = {
  createRenegotiation,
  getRenegotiations,
  getRenegotiationsByClient,
};
