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

function isValidDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function uniquePositiveIds(items) {
  return Array.from(
    new Set(
      (Array.isArray(items) ? items : [])
        .map((item) => Number(item))
        .filter((item) => Number.isInteger(item) && item > 0),
    ),
  );
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
    splits: (installment.splits || []).map((split) => ({
      id: split.id,
      splitNumber: split.splitNumber,
      amount: split.amount,
      paidAmount: split.paidAmount,
      dueDate: split.dueDate,
      paidAt: split.paidAt,
      status: split.status,
      note: split.note,
      installmentId: split.installmentId,
      createdAt: split.createdAt,
      updatedAt: split.updatedAt,
    })),
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

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function buildSplitDueDate(installmentDueDate, dayOfMonth) {
  const base = new Date(installmentDueDate);
  const safeDay = Math.max(
    1,
    Math.min(Number(dayOfMonth || base.getDate()), daysInMonth(base.getFullYear(), base.getMonth())),
  );
  return new Date(
    base.getFullYear(),
    base.getMonth(),
    safeDay,
    base.getHours(),
    base.getMinutes(),
    base.getSeconds(),
    base.getMilliseconds(),
  );
}

function normalizeSplitPayments(raw) {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((item, index) => ({
      splitNumber: index + 1,
      dayOfMonth: Number(item.dayOfMonth || item.day || 0),
      amount: item.amount !== undefined ? Number(item.amount) : null,
    }))
    .filter((item) => item.dayOfMonth >= 1 && item.dayOfMonth <= 31);
}

function buildInstallmentSplits({ installment, splitPayments }) {
  if (!splitPayments.length) return [];

  const manualTotal = roundMoney(
    splitPayments.reduce((sum, item) => sum + (item.amount && item.amount > 0 ? item.amount : 0), 0),
  );
  let accumulated = 0;

  return splitPayments.map((item, index) => {
    let amount;
    if (manualTotal > 0) {
      amount = item.amount && item.amount > 0 ? roundMoney(item.amount) : 0;
    } else {
      amount = index === splitPayments.length - 1
        ? roundMoney(installment.amount - accumulated)
        : roundMoney(installment.amount / splitPayments.length);
    }
    accumulated = roundMoney(accumulated + amount);

    return {
      splitNumber: item.splitNumber,
      amount,
      dueDate: buildSplitDueDate(installment.dueDate, item.dayOfMonth),
    };
  });
}

async function createRenegotiation(req, res) {
  try {
    const clientId = Number(req.body.clientId);
    const debtIds = uniquePositiveIds(req.body.debtIds);
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
    const splitPayments = normalizeSplitPayments(req.body.splitPayments);

    if (!clientId || !installmentCount || !firstDueDate) {
      return res.status(400).json({
        message: 'clientId, installmentCount e firstDueDate sao obrigatorios',
        data: {},
      });
    }

    if (!Number.isInteger(installmentCount) || installmentCount < 1 || installmentCount > 240) {
      return res.status(400).json({
        message: 'Informe uma quantidade de parcelas entre 1 e 240',
        data: {},
      });
    }

    if (!isValidDate(firstDueDate) || !isValidDate(startedAt)) {
      return res.status(400).json({
        message: 'Informe datas validas para inicio e primeiro vencimento',
        data: {},
      });
    }

    if (firstDueDate < startedAt) {
      return res.status(400).json({
        message: 'O primeiro vencimento nao pode ser anterior ao inicio da renegociacao',
        data: {},
      });
    }

    if (dailyInterestValue !== null && (!Number.isFinite(dailyInterestValue) || dailyInterestValue < 0)) {
      return res.status(400).json({
        message: 'Informe um juros diario valido',
        data: {},
      });
    }

    if (dailyInterestValue > 0 && !dailyInterestMode) {
      return res.status(400).json({
        message: 'Informe se o juros diario sera em porcentagem ou valor fixo',
        data: {},
      });
    }

    if (!debtIds.length) {
      return res.status(400).json({
        message: 'Selecione ao menos uma divida para renegociar',
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
        id: { in: debtIds },
      },
      orderBy: { dueDate: 'asc' },
    });

    if (!sourceDebts.length) {
      return res.status(404).json({
        message: 'Nenhuma divida ativa encontrada para renegociar',
        data: {},
      });
    }

    if (sourceDebts.length !== debtIds.length) {
      return res.status(409).json({
        message: 'Uma ou mais dividas selecionadas nao estao mais ativas. Atualize a tela e selecione novamente.',
        data: {
          requestedDebtIds: debtIds,
          foundDebtIds: sourceDebts.map((debt) => debt.id),
        },
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

    if (!Number.isFinite(negotiatedTotal) || negotiatedTotal <= 0) {
      return res.status(400).json({
        message: 'O total renegociado precisa ser maior que zero',
        data: {},
      });
    }

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
          debtType: 'MANUAL_AGREEMENT',
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
        const installment = await tx.installment.create({
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

        const splits = buildInstallmentSplits({
          installment,
          splitPayments,
        });

        for (const split of splits) {
          await tx.installmentSplit.create({
            data: {
              splitNumber: split.splitNumber,
              amount: split.amount,
              dueDate: split.dueDate,
              status: 'PENDING',
              clientId,
              accountId: req.user.accountId,
              installmentId: installment.id,
            },
          });
        }
      }

      return tx.renegotiation.findUnique({
        where: { id: createdRenegotiation.id },
        include: {
          client: true,
          debts: {
            orderBy: { createdAt: 'desc' },
          },
          installments: {
            include: {
              splits: {
                orderBy: { splitNumber: 'asc' },
              },
            },
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
          include: {
            splits: {
              orderBy: { splitNumber: 'asc' },
            },
          },
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
          include: {
            splits: {
              orderBy: { splitNumber: 'asc' },
            },
          },
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

async function cancelRenegotiation(req, res) {
  try {
    const renegotiationId = Number(req.params.id);
    if (!renegotiationId) {
      return res.status(400).json({ message: 'ID da renegociacao invalido', data: {} });
    }

    const existing = await prisma.renegotiation.findFirst({
      where: {
        id: renegotiationId,
        accountId: req.user.accountId,
      },
      include: {
        debts: true,
        installments: true,
      },
    });

    if (!existing) {
      return res.status(404).json({ message: 'Renegociacao nao encontrada', data: {} });
    }

    if (existing.status !== 'ACTIVE') {
      return res.status(409).json({
        message: 'Somente renegociacoes ativas podem ser canceladas',
        data: serializeRenegotiation(existing),
      });
    }

    const sourceDebtIds = Array.isArray(existing.sourceDebtIds)
      ? existing.sourceDebtIds.map((item) => Number(item)).filter(Boolean)
      : [];

    const renegotiatedDebtIds = existing.debts
      .filter((debt) => debt.kind === 'RENEGOTIATED')
      .map((debt) => debt.id);
    const installmentIds = existing.installments.map((installment) => installment.id);

    if (renegotiatedDebtIds.length || installmentIds.length) {
      const paymentCount = await prisma.payment.count({
        where: {
          accountId: req.user.accountId,
          deletedAt: null,
          OR: [
            ...(renegotiatedDebtIds.length ? [{ debtId: { in: renegotiatedDebtIds } }] : []),
            ...(installmentIds.length ? [{ installmentId: { in: installmentIds } }] : []),
          ],
        },
      });

      if (paymentCount > 0) {
        return res.status(409).json({
          message: 'Este acordo ja possui pagamento registrado. Exclua/estorne os pagamentos antes de cancelar ou descongelar.',
          data: { paymentCount },
        });
      }
    }

    const cancelled = await prisma.$transaction(async (tx) => {
      await tx.renegotiation.update({
        where: { id: existing.id },
        data: {
          status: 'CANCELLED',
          completedAt: new Date(),
        },
      });

      await tx.debt.updateMany({
        where: {
          renegotiationId: existing.id,
          accountId: req.user.accountId,
          kind: 'RENEGOTIATED',
          status: 'ACTIVE',
        },
        data: {
          status: 'EXCLUDED',
          deletedAt: new Date(),
        },
      });

      if (sourceDebtIds.length) {
        await tx.debt.updateMany({
          where: {
            id: { in: sourceDebtIds },
            accountId: req.user.accountId,
            status: 'RENEGOTIATED',
          },
          data: {
            status: 'ACTIVE',
          },
        });
      }

      return tx.renegotiation.findUnique({
        where: { id: existing.id },
        include: {
          client: true,
          debts: {
            orderBy: { createdAt: 'desc' },
          },
        installments: {
          include: {
            splits: {
              orderBy: { splitNumber: 'asc' },
            },
          },
          orderBy: { installmentNumber: 'asc' },
        },
        },
      });
    });

    return res.json({
      message: 'Renegociacao cancelada e dividas originais reativadas',
      data: serializeRenegotiation(cancelled),
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ message: 'Erro ao cancelar renegociacao', data: {} });
  }
}

module.exports = {
  createRenegotiation,
  getRenegotiations,
  getRenegotiationsByClient,
  cancelRenegotiation,
};
