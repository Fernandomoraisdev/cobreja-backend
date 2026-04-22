const prisma = require('../prisma');
const {
  MONEY_EPSILON,
  simulatePaymentsForDebt,
  buildDebtUpdateFromState,
  roundMoney,
} = require('../services/debt.service');

function normalizePaymentType(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if ([ 'JUROS', 'PARCIAL', 'TOTAL', 'PARCELA' ].includes(normalized)) {
    return normalized;
  }
  return null;
}

function serializePayment(payment) {
  return {
    id: payment.id,
    type: payment.type,
    amount: payment.amount,
    principalAmount: payment.principalAmount,
    interestAmount: payment.interestAmount,
    dailyAmount: payment.dailyAmount,
    note: payment.note,
    receiptUrl: payment.receiptUrl,
    paidAt: payment.paidAt,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
    clientId: payment.clientId,
    debtId: payment.debtId,
    installmentId: payment.installmentId,
    client: payment.client
      ? {
          id: payment.client.id,
          name: payment.client.name,
          phone: payment.client.phone,
          email: payment.client.email,
          cpf: payment.client.cpf,
        }
      : null,
    debt: payment.debt
      ? {
          id: payment.debt.id,
          title: payment.debt.title,
          kind: payment.debt.kind,
          status: payment.debt.status,
          dueDate: payment.debt.dueDate,
        }
      : null,
    installment: payment.installment
      ? {
          id: payment.installment.id,
          installmentNumber: payment.installment.installmentNumber,
          amount: payment.installment.amount,
          dueDate: payment.installment.dueDate,
          status: payment.installment.status,
        }
      : null,
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
  if (!debtId) return null;

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

async function findDebtForPayment({ accountId, clientId, debtId, installmentId, tx }) {
  if (installmentId) {
    const installment = await tx.installment.findFirst({
      where: {
        id: installmentId,
        clientId,
        accountId,
      },
      include: {
        debt: true,
      },
    });

    if (!installment || !installment.debt) {
      return { debt: null, installment: null };
    }

    return { debt: installment.debt, installment };
  }

  if (debtId) {
    const debt = await tx.debt.findFirst({
      where: {
        id: debtId,
        clientId,
        accountId,
      },
    });
    return { debt, installment: null };
  }

  const debt = await tx.debt.findFirst({
    where: {
      clientId,
      accountId,
      status: 'ACTIVE',
      deletedAt: null,
    },
    orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
  });

  return { debt, installment: null };
}

async function createPayment(req, res) {
  try {
    const clientId = Number(req.body.clientId);
    const debtId = req.body.debtId ? Number(req.body.debtId) : null;
    const installmentId = req.body.installmentId ? Number(req.body.installmentId) : null;
    const amount = Number(req.body.amount || 0);
    const type = normalizePaymentType(req.body.type);
    const paidAt = req.body.paidAt
      ? new Date(req.body.paidAt)
      : req.body.date
        ? new Date(req.body.date)
        : new Date();
    const note = req.body.note ? String(req.body.note).trim() : null;
    const receiptUrl = req.body.receiptUrl ? String(req.body.receiptUrl).trim() : null;

    if (!clientId || !amount || !type) {
      return res.status(400).json({
        message: 'clientId, amount e type sao obrigatorios',
        data: {},
      });
    }

    if (type === 'PARCELA' && !installmentId) {
      return res.status(400).json({
        message: 'Pagamento de parcela exige installmentId',
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

    const createdPayment = await prisma.$transaction(async (tx) => {
      const target = await findDebtForPayment({
        accountId: req.user.accountId,
        clientId,
        debtId,
        installmentId,
        tx,
      });

      if (!target.debt) {
        throw new Error('DIVIDA_NAO_ENCONTRADA');
      }

      const payment = await tx.payment.create({
        data: {
          type,
          amount,
          clientId,
          debtId: target.debt.id,
          installmentId: target.installment ? target.installment.id : null,
          accountId: req.user.accountId,
          paidAt,
          note,
          receiptUrl,
        },
        include: {
          client: true,
          debt: true,
          installment: true,
        },
      });

      await recalculateDebtAndRelations(tx, target.debt.id);

      return payment;
    });

    const refreshedPayment = await prisma.payment.findUnique({
      where: { id: createdPayment.id },
      include: {
        client: true,
        debt: true,
        installment: true,
      },
    });

    if (!refreshedPayment || refreshedPayment.amount <= MONEY_EPSILON) {
      return res.status(400).json({
        message: 'Nenhum valor aplicavel foi registrado para este pagamento',
        data: {},
      });
    }

    return res.status(201).json({
      message: 'Pagamento registrado com sucesso',
      data: serializePayment(refreshedPayment),
    });
  } catch (err) {
    console.log(err);
    if (String(err.message).includes('DIVIDA_NAO_ENCONTRADA')) {
      return res.status(404).json({ message: 'Divida nao encontrada para pagamento', data: {} });
    }
    return res.status(500).json({ message: 'Erro ao registrar pagamento', data: {} });
  }
}

async function updatePayment(req, res) {
  try {
    const paymentId = Number(req.params.id);
    if (!paymentId) {
      return res.status(400).json({ message: 'ID do pagamento invalido', data: {} });
    }

    const existingPayment = await prisma.payment.findFirst({
      where: {
        id: paymentId,
        accountId: req.user.accountId,
      },
      include: {
        client: true,
        debt: true,
        installment: true,
      },
    });

    if (!existingPayment) {
      return res.status(404).json({ message: 'Pagamento nao encontrado', data: {} });
    }

    const nextType = req.body.type !== undefined
      ? normalizePaymentType(req.body.type)
      : existingPayment.type;

    if (!nextType) {
      return res.status(400).json({ message: 'Tipo de pagamento invalido', data: {} });
    }

    if (existingPayment.installmentId && nextType !== 'PARCELA') {
      return res.status(400).json({
        message: 'Pagamentos de parcela nao podem mudar de tipo',
        data: {},
      });
    }

    const nextAmount = req.body.amount !== undefined
      ? Number(req.body.amount)
      : existingPayment.amount;

    const nextPaidAt = req.body.paidAt
      ? new Date(req.body.paidAt)
      : req.body.date
        ? new Date(req.body.date)
        : existingPayment.paidAt;
    const nextNote = req.body.note !== undefined ? String(req.body.note || '').trim() || null : existingPayment.note;
    const nextReceiptUrl = req.body.receiptUrl !== undefined
      ? String(req.body.receiptUrl || '').trim() || null
      : existingPayment.receiptUrl;

    const updatedPayment = await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.update({
        where: { id: paymentId },
        data: {
          type: nextType,
          amount: nextAmount,
          paidAt: nextPaidAt,
          note: nextNote,
          receiptUrl: nextReceiptUrl,
        },
        include: {
          client: true,
          debt: true,
          installment: true,
        },
      });

      if (payment.debtId) {
        await recalculateDebtAndRelations(tx, payment.debtId);
      }

      return payment;
    });

    const refreshedPayment = await prisma.payment.findUnique({
      where: { id: updatedPayment.id },
      include: {
        client: true,
        debt: true,
        installment: true,
      },
    });

    return res.json({
      message: 'Pagamento atualizado com sucesso',
      data: serializePayment(refreshedPayment),
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ message: 'Erro ao atualizar pagamento', data: {} });
  }
}

async function deletePayment(req, res) {
  try {
    const paymentId = Number(req.params.id);
    if (!paymentId) {
      return res.status(400).json({ message: 'ID do pagamento invalido', data: {} });
    }

    const existingPayment = await prisma.payment.findFirst({
      where: {
        id: paymentId,
        accountId: req.user.accountId,
      },
    });

    if (!existingPayment) {
      return res.status(404).json({ message: 'Pagamento nao encontrado', data: {} });
    }

    await prisma.$transaction(async (tx) => {
      await tx.payment.delete({
        where: { id: paymentId },
      });

      if (existingPayment.debtId) {
        await recalculateDebtAndRelations(tx, existingPayment.debtId);
      }
    });

    return res.json({
      message: 'Pagamento excluido com sucesso',
      data: {},
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ message: 'Erro ao excluir pagamento', data: {} });
  }
}

async function getMyPayments(req, res) {
  try {
    const client = await prisma.client.findUnique({
      where: { userId: req.user.id },
      select: { id: true },
    });

    if (!client) {
      return res.status(404).json({ message: 'Cliente nao encontrado', data: {} });
    }

    const type = req.query.type ? normalizePaymentType(req.query.type) : null;

    const payments = await prisma.payment.findMany({
      where: {
        clientId: client.id,
        accountId: req.user.accountId,
        ...(type ? { type } : {}),
      },
      include: {
        client: true,
        debt: true,
        installment: true,
      },
      orderBy: { paidAt: 'desc' },
    });

    return res.json({
      message: 'Historico de pagamentos carregado com sucesso',
      data: payments.map(serializePayment),
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ message: 'Erro ao buscar historico de pagamentos', data: {} });
  }
}

async function getPaymentHistory(req, res) {
  try {
    const type = req.query.type ? normalizePaymentType(req.query.type) : null;

    const payments = await prisma.payment.findMany({
      where: {
        accountId: req.user.accountId,
        ...(type ? { type } : {}),
      },
      include: {
        client: true,
        debt: true,
        installment: true,
      },
      orderBy: { paidAt: 'desc' },
    });

    return res.json({
      message: 'Historico de pagamentos listado com sucesso',
      data: payments.map(serializePayment),
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ message: 'Erro ao listar historico de pagamentos', data: {} });
  }
}

async function getPaymentHistoryByClient(req, res) {
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

    const type = req.query.type ? normalizePaymentType(req.query.type) : null;

    const payments = await prisma.payment.findMany({
      where: {
        clientId,
        accountId: req.user.accountId,
        ...(type ? { type } : {}),
      },
      include: {
        client: true,
        debt: true,
        installment: true,
      },
      orderBy: { paidAt: 'desc' },
    });

    return res.json({
      message: 'Historico do cliente listado com sucesso',
      data: payments.map(serializePayment),
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ message: 'Erro ao listar historico do cliente', data: {} });
  }
}

module.exports = {
  createPayment,
  updatePayment,
  deletePayment,
  getMyPayments,
  getPaymentHistory,
  getPaymentHistoryByClient,
};
