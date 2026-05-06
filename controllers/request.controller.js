const prisma = require('../prisma');
const {
  addMonthsKeepingDay,
  enrichDebt,
  roundMoney,
} = require('../services/debt.service');

function normalizePositiveInt(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const integer = Math.trunc(parsed);
  return integer > 0 ? integer : fallback;
}

function buildInstallmentSchedule(firstDueDate, installmentCount, installmentAmount, total) {
  const items = [];
  let accumulated = 0;

  for (let index = 0; index < installmentCount; index += 1) {
    const amount = index === installmentCount - 1
      ? roundMoney(total - accumulated)
      : installmentAmount;
    accumulated = roundMoney(accumulated + amount);
    items.push({
      installmentNumber: index + 1,
      amount,
      dueDate: addMonthsKeepingDay(firstDueDate, index),
    });
  }

  return items;
}

async function createRequest(req, res) {
  try {
    const amount = Number(req.body.amount || 0);
    const description = req.body.description ? String(req.body.description).trim() : null;
    const type = String(req.body.type || '').trim();
    const desiredTermDays = normalizePositiveInt(req.body.desiredTermDays);
    const requestedInstallments = normalizePositiveInt(req.body.requestedInstallments, 1);

    if (!amount || !type) {
      return res.status(400).json({ message: 'amount e type sao obrigatorios', data: {} });
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

    const request = await prisma.creditRequest.create({
      data: {
        amount,
        description,
        desiredTermDays,
        requestedInstallments,
        type,
        clientId: client.id,
        accountId: req.user.accountId,
      },
    });

    return res.json({
      message: 'Pedido enviado com sucesso',
      data: request,
      request,
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ message: 'Erro ao criar pedido', data: {} });
  }
}

async function getAllRequests(req, res) {
  try {
    const requests = await prisma.creditRequest.findMany({
      where: {
        accountId: req.user.accountId,
      },
      include: {
        client: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return res.json({
      message: 'Pedidos carregados com sucesso',
      data: requests,
      requests,
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ message: 'Erro ao buscar pedidos', data: {} });
  }
}

async function approveRequest(req, res) {
  try {
    const requestId = Number(req.body.requestId);
    const interestValue = req.body.interestValue !== undefined ? Number(req.body.interestValue) : null;
    const dailyFee = req.body.dailyFee !== undefined ? Number(req.body.dailyFee) : null;
    const dueDate = req.body.dueDate ? new Date(req.body.dueDate) : null;
    const installmentCount = normalizePositiveInt(
      req.body.installmentCount,
      normalizePositiveInt(req.body.requestedInstallments, 1),
    );
    const decisionNote = req.body.decisionNote ? String(req.body.decisionNote).trim() : null;

    if (!requestId) {
      return res.status(400).json({ message: 'requestId e obrigatorio', data: {} });
    }

    if (!dueDate || Number.isNaN(dueDate.getTime())) {
      return res.status(400).json({ message: 'Informe um vencimento valido', data: {} });
    }

    const request = await prisma.creditRequest.findFirst({
      where: {
        id: requestId,
        accountId: req.user.accountId,
      },
    });

    if (!request) {
      return res.status(404).json({ message: 'Pedido nao encontrado', data: {} });
    }

    if (request.status !== 'PENDING') {
      return res.status(400).json({ message: 'Pedido ja processado', data: {} });
    }

    const principalAmount = Number(request.amount || 0);
    const monthlyInterestValue = interestValue !== null && Number.isFinite(interestValue) ? interestValue : null;
    const dailyInterestValue = dailyFee !== null && Number.isFinite(dailyFee) ? dailyFee : null;

    const result = await prisma.$transaction(async (tx) => {
      let debt = null;
      let renegotiation = null;

      if (installmentCount > 1) {
        const installmentAmount = roundMoney(principalAmount / installmentCount);
        const schedule = buildInstallmentSchedule(
          dueDate,
          installmentCount,
          installmentAmount,
          principalAmount,
        );

        renegotiation = await tx.renegotiation.create({
          data: {
            status: 'ACTIVE',
            originalTotal: principalAmount,
            multiplier: null,
            negotiatedTotal: principalAmount,
            installmentCount,
            installmentAmount,
            startedAt: new Date(),
            firstDueDate: dueDate,
            dailyInterestMode: dailyInterestValue && dailyInterestValue > 0 ? 'FIXED' : null,
            dailyInterestValue: dailyInterestValue && dailyInterestValue > 0 ? dailyInterestValue : null,
            note: decisionNote || 'Credito aprovado a partir de solicitacao do cliente.',
            sourceDebtIds: [],
            clientId: request.clientId,
            accountId: req.user.accountId,
          },
        });

        debt = await tx.debt.create({
          data: {
            title: 'Credito aprovado parcelado',
            kind: 'RENEGOTIATED',
            status: 'ACTIVE',
            principalAmount,
            principalOutstanding: principalAmount,
            monthlyInterestMode: monthlyInterestValue && monthlyInterestValue > 0 ? 'FIXED' : null,
            monthlyInterestValue: monthlyInterestValue && monthlyInterestValue > 0 ? monthlyInterestValue : null,
            dailyInterestMode: dailyInterestValue && dailyInterestValue > 0 ? 'FIXED' : null,
            dailyInterestValue: dailyInterestValue && dailyInterestValue > 0 ? dailyInterestValue : null,
            borrowedAt: new Date(),
            originalDueDate: dueDate,
            dueDate,
            clientId: request.clientId,
            accountId: req.user.accountId,
            renegotiationId: renegotiation.id,
          },
        });

        for (const item of schedule) {
          await tx.installment.create({
            data: {
              installmentNumber: item.installmentNumber,
              amount: item.amount,
              dueDate: item.dueDate,
              status: 'PENDING',
              clientId: request.clientId,
              accountId: req.user.accountId,
              renegotiationId: renegotiation.id,
              debtId: debt.id,
            },
          });
        }
      } else {
        debt = await tx.debt.create({
          data: {
            title: 'Credito aprovado',
            kind: 'STANDARD',
            status: 'ACTIVE',
            principalAmount,
            principalOutstanding: principalAmount,
            monthlyInterestMode: monthlyInterestValue && monthlyInterestValue > 0 ? 'FIXED' : null,
            monthlyInterestValue: monthlyInterestValue && monthlyInterestValue > 0 ? monthlyInterestValue : null,
            dailyInterestMode: dailyInterestValue && dailyInterestValue > 0 ? 'FIXED' : null,
            dailyInterestValue: dailyInterestValue && dailyInterestValue > 0 ? dailyInterestValue : null,
            borrowedAt: new Date(),
            originalDueDate: dueDate,
            dueDate,
            clientId: request.clientId,
            accountId: req.user.accountId,
          },
        });
      }

      await tx.creditRequest.update({
        where: { id: request.id },
        data: {
          status: 'APPROVED',
          requestedInstallments: installmentCount,
          decisionNote,
          reviewedAt: new Date(),
          approvedDebtId: debt.id,
          approvedRenegotiationId: renegotiation ? renegotiation.id : null,
        },
      });

      const refreshedDebt = await tx.debt.findUnique({
        where: { id: debt.id },
      });

      return {
        debt: refreshedDebt,
        renegotiation,
      };
    });

    return res.json({
      message: 'Pedido aprovado e divida criada',
      data: {
        debt: enrichDebt(result.debt),
        renegotiation: result.renegotiation,
      },
      debt: enrichDebt(result.debt),
      renegotiation: result.renegotiation,
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ message: 'Erro ao aprovar pedido', data: {} });
  }
}

async function rejectRequest(req, res) {
  try {
    const requestId = Number(req.body.requestId);

    if (!requestId) {
      return res.status(400).json({ message: 'requestId e obrigatorio', data: {} });
    }

    const request = await prisma.creditRequest.findFirst({
      where: {
        id: requestId,
        accountId: req.user.accountId,
      },
    });

    if (!request) {
      return res.status(404).json({ message: 'Pedido nao encontrado', data: {} });
    }

    if (request.status !== 'PENDING') {
      return res.status(400).json({ message: 'Pedido ja processado', data: {} });
    }

    await prisma.creditRequest.update({
      where: { id: request.id },
      data: {
        status: 'REJECTED',
        decisionNote: req.body.decisionNote ? String(req.body.decisionNote).trim() : null,
        reviewedAt: new Date(),
      },
    });

    return res.json({
      message: 'Pedido recusado com sucesso',
      data: {},
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ message: 'Erro ao recusar pedido', data: {} });
  }
}

module.exports = {
  createRequest,
  getAllRequests,
  approveRequest,
  rejectRequest,
};
