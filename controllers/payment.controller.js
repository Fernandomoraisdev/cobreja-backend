const prisma = require('../prisma');
const {
  MONEY_EPSILON,
  calculateDebtSnapshot,
  simulatePaymentsForDebt,
  buildDebtUpdateFromState,
  addMonthsKeepingDay,
  roundMoney,
} = require('../services/debt.service');
const { writeAuditLog } = require('../services/audit.service');

function startOfDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function isSameDay(left, right) {
  if (!left || !right) return false;
  return startOfDay(left).getTime() === startOfDay(right).getTime();
}

function normalizePaymentType(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if ([ 'JUROS', 'PARCIAL', 'TOTAL', 'PARCELA' ].includes(normalized)) {
    return normalized;
  }
  return null;
}

function assertValidPaymentInput({ amount, paidAt }) {
  if (!Number.isFinite(amount) || amount <= MONEY_EPSILON) {
    const err = new Error('VALOR_INVALIDO');
    err.statusCode = 400;
    throw err;
  }

  if (!(paidAt instanceof Date) || Number.isNaN(paidAt.getTime())) {
    const err = new Error('DATA_INVALIDA');
    err.statusCode = 400;
    throw err;
  }
}

function installmentPrincipalPaid(payment) {
  const principalAmount = Number(payment.principalAmount || 0);
  if (principalAmount > MONEY_EPSILON) return principalAmount;
  return String(payment.type || '').toUpperCase() === 'PARCELA'
    ? Number(payment.amount || 0)
    : 0;
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

function serializePreviewSnapshot(state, now) {
  return {
    ...calculateDebtSnapshot(state, now),
    dueDate: state.dueDate,
    lastInterestPaidAt: state.lastInterestPaidAt,
    settledAt: state.settledAt,
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
  let nextOpenInstallment = null;

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

    if (status !== 'PAID' && !nextOpenInstallment) {
      nextOpenInstallment = installment;
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

  const renegotiatedDebts = await tx.debt.findMany({
    where: {
      renegotiationId,
      kind: 'RENEGOTIATED',
      deletedAt: null,
    },
  });

  for (const debt of renegotiatedDebts) {
    await tx.debt.update({
      where: { id: debt.id },
      data: {
        dueDate: nextOpenInstallment ? nextOpenInstallment.dueDate : debt.dueDate,
        status: allPaid ? 'SETTLED' : debt.status,
        settledAt: allPaid ? new Date() : debt.settledAt,
      },
    });
  }
}

async function recalculateDebtAndRelations(tx, debtId) {
  if (!debtId) return null;

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

    if (installment.status === 'PAID') {
      const err = new Error('PARCELA_JA_PAGA');
      err.statusCode = 409;
      throw err;
    }

    if (installment.debt.deletedAt || installment.debt.status !== 'ACTIVE') {
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
        status: 'ACTIVE',
        deletedAt: null,
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

async function buildPaymentPlan({ accountId, target, type, amount, note, tx }) {
  const paymentsToCreate = [];

  if (target.installment && type === 'PARCIAL') {
    const existingPayments = await tx.payment.findMany({
      where: {
        installmentId: target.installment.id,
        accountId,
        deletedAt: null,
      },
    });
    const alreadyPaidPrincipal = roundMoney(
      existingPayments.reduce(
        (sum, payment) => sum + installmentPrincipalPaid(payment),
        0,
      ),
    );
    const principalNeeded = roundMoney(
      Math.max(Number(target.installment.amount || 0) - alreadyPaidPrincipal, 0),
    );
    const principalForInstallment = roundMoney(Math.min(amount, principalNeeded));
    const extraForCharges = roundMoney(Math.max(amount - principalForInstallment, 0));

    if (extraForCharges > MONEY_EPSILON) {
      paymentsToCreate.push({
        type: 'PARCIAL',
        amount: extraForCharges,
        installmentId: target.installment.id,
        note: note ? `${note} (diaria/juros)` : 'Diaria/juros da parcela renegociada',
      });
    }

    if (principalForInstallment > MONEY_EPSILON) {
      paymentsToCreate.push({
        type: 'PARCELA',
        amount: principalForInstallment,
        installmentId: target.installment.id,
        note: note ? `${note} (principal da parcela)` : 'Principal da parcela renegociada',
      });
    }
  }

  if (!paymentsToCreate.length) {
    paymentsToCreate.push({
      type,
      amount,
      installmentId: target.installment ? target.installment.id : null,
      note,
    });
  }

  return paymentsToCreate;
}

async function previewPayment(req, res) {
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

    if (!clientId || !amount || !type) {
      return res.status(400).json({
        message: 'clientId, amount e type sao obrigatorios',
        data: {},
      });
    }

    assertValidPaymentInput({ amount, paidAt });

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

    const preview = await prisma.$transaction(async (tx) => {
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

      const paymentPlan = await buildPaymentPlan({
        accountId: req.user.accountId,
        target,
        type,
        amount,
        note,
        tx,
      });

      const existingPayments = await tx.payment.findMany({
        where: {
          debtId: target.debt.id,
          accountId: req.user.accountId,
          deletedAt: null,
        },
        orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
      });

      const beforeSimulation = simulatePaymentsForDebt(target.debt, existingPayments);
      const draftPayments = paymentPlan.map((item, index) => ({
        id: 2147483000 + index,
        type: item.type,
        amount: item.amount,
        paidAt,
        installmentId: item.installmentId,
        note: item.note,
      }));
      const afterSimulation = simulatePaymentsForDebt(target.debt, [
        ...existingPayments,
        ...draftPayments,
      ]);
      const appliedPayments = afterSimulation.computedPayments.slice(-draftPayments.length);
      const applied = appliedPayments.reduce(
        (acc, payment) => ({
          amount: roundMoney(acc.amount + Number(payment.amount || 0)),
          principalAmount: roundMoney(acc.principalAmount + Number(payment.principalAmount || 0)),
          interestAmount: roundMoney(acc.interestAmount + Number(payment.interestAmount || 0)),
          dailyAmount: roundMoney(acc.dailyAmount + Number(payment.dailyAmount || 0)),
        }),
        { amount: 0, principalAmount: 0, interestAmount: 0, dailyAmount: 0 },
      );

      return {
        debt: {
          id: target.debt.id,
          title: target.debt.title,
          kind: target.debt.kind,
          debtType: target.debt.debtType,
          dueDate: target.debt.dueDate,
        },
        installment: target.installment
          ? {
              id: target.installment.id,
              installmentNumber: target.installment.installmentNumber,
              amount: target.installment.amount,
              dueDate: target.installment.dueDate,
              status: target.installment.status,
            }
          : null,
        requested: {
          amount: roundMoney(amount),
          type,
          paidAt,
        },
        before: serializePreviewSnapshot(beforeSimulation.state, paidAt),
        applied,
        payments: appliedPayments,
        after: serializePreviewSnapshot(afterSimulation.state, paidAt),
      };
    });

    return res.json({
      message: 'Previa de pagamento calculada',
      data: preview,
    });
  } catch (err) {
    console.log(err);
    if (String(err.message).includes('DIVIDA_NAO_ENCONTRADA')) {
      return res.status(404).json({ message: 'Divida nao encontrada para pagamento', data: {} });
    }
    if (String(err.message).includes('PARCELA_JA_PAGA')) {
      return res.status(409).json({ message: 'Esta parcela ja esta paga', data: {} });
    }
    if (String(err.message).includes('VALOR_INVALIDO')) {
      return res.status(400).json({ message: 'Informe um valor de pagamento maior que zero', data: {} });
    }
    if (String(err.message).includes('DATA_INVALIDA')) {
      return res.status(400).json({ message: 'Informe uma data de pagamento valida', data: {} });
    }
    return res.status(500).json({ message: 'Erro ao calcular previa de pagamento', data: {} });
  }
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

    assertValidPaymentInput({ amount, paidAt });

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

      const paymentsToCreate = await buildPaymentPlan({
        accountId: req.user.accountId,
        target,
        type,
        amount,
        note,
        tx,
      });

      const createdPaymentIds = [];
      let payment = null;
      for (const item of paymentsToCreate) {
        payment = await tx.payment.create({
          data: {
            type: item.type,
            amount: item.amount,
            clientId,
            debtId: target.debt.id,
            installmentId: item.installmentId,
            accountId: req.user.accountId,
            paidAt,
            note: item.note,
            receiptUrl,
          },
          include: {
            client: true,
            debt: true,
            installment: true,
          },
        });
        createdPaymentIds.push(payment.id);
      }

      await recalculateDebtAndRelations(tx, target.debt.id);

      const refreshedPayments = await tx.payment.findMany({
        where: { id: { in: createdPaymentIds } },
        include: {
          client: true,
          debt: true,
          installment: true,
        },
        orderBy: { id: 'asc' },
      });

      if (
        !refreshedPayments.length ||
        refreshedPayments.every((item) => Number(item.amount || 0) <= MONEY_EPSILON)
      ) {
        throw new Error('PAGAMENTO_SEM_VALOR_APLICAVEL');
      }

      return refreshedPayments[refreshedPayments.length - 1];
    });

    await writeAuditLog({
      req,
      action: 'PAYMENT_CREATED',
      entity: 'Payment',
      entityId: createdPayment.id,
      severity: 'INFO',
      metadata: {
        type: createdPayment.type,
        amount: createdPayment.amount,
        clientId: createdPayment.clientId,
        debtId: createdPayment.debtId,
        installmentId: createdPayment.installmentId,
        paidAt: createdPayment.paidAt,
      },
    });

    return res.status(201).json({
      message: 'Pagamento registrado com sucesso',
      data: serializePayment(createdPayment),
    });
  } catch (err) {
    console.log(err);
    if (String(err.message).includes('DIVIDA_NAO_ENCONTRADA')) {
      return res.status(404).json({ message: 'Divida nao encontrada para pagamento', data: {} });
    }
    if (String(err.message).includes('PARCELA_JA_PAGA')) {
      return res.status(409).json({ message: 'Esta parcela ja esta paga', data: {} });
    }
    if (String(err.message).includes('PAGAMENTO_SEM_VALOR_APLICAVEL')) {
      return res.status(400).json({ message: 'Nenhum valor aplicavel foi registrado para este pagamento', data: {} });
    }
    if (String(err.message).includes('VALOR_INVALIDO')) {
      return res.status(400).json({ message: 'Informe um valor de pagamento maior que zero', data: {} });
    }
    if (String(err.message).includes('DATA_INVALIDA')) {
      return res.status(400).json({ message: 'Informe uma data de pagamento valida', data: {} });
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
        deletedAt: null,
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
    assertValidPaymentInput({ amount: nextAmount, paidAt: nextPaidAt });
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

    await writeAuditLog({
      req,
      action: 'PAYMENT_UPDATED',
      entity: 'Payment',
      entityId: refreshedPayment.id,
      severity: 'WARNING',
      metadata: {
        before: {
          type: existingPayment.type,
          amount: existingPayment.amount,
          paidAt: existingPayment.paidAt,
          note: existingPayment.note,
        },
        after: {
          type: refreshedPayment.type,
          amount: refreshedPayment.amount,
          paidAt: refreshedPayment.paidAt,
          note: refreshedPayment.note,
        },
        clientId: refreshedPayment.clientId,
        debtId: refreshedPayment.debtId,
        installmentId: refreshedPayment.installmentId,
      },
    });

    return res.json({
      message: 'Pagamento atualizado com sucesso',
      data: serializePayment(refreshedPayment),
    });
  } catch (err) {
    console.log(err);
    if (String(err.message).includes('VALOR_INVALIDO')) {
      return res.status(400).json({ message: 'Informe um valor de pagamento maior que zero', data: {} });
    }
    if (String(err.message).includes('DATA_INVALIDA')) {
      return res.status(400).json({ message: 'Informe uma data de pagamento valida', data: {} });
    }
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
        deletedAt: null,
      },
      include: {
        debt: true,
      },
    });

    if (!existingPayment) {
      return res.status(404).json({ message: 'Pagamento nao encontrado', data: {} });
    }

    const debtBefore = existingPayment.debtId ? existingPayment.debt : null;
    const shouldRollbackCycle =
      Boolean(debtBefore) &&
      Boolean(debtBefore.lastInterestPaidAt) &&
      [ 'JUROS', 'PARCIAL' ].includes(String(existingPayment.type || '').toUpperCase()) &&
      new Date(debtBefore.lastInterestPaidAt).getTime() === new Date(existingPayment.paidAt).getTime();

    const expectedDueDate = shouldRollbackCycle
      ? addMonthsKeepingDay(new Date(debtBefore.dueDate), -1)
      : null;

    await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: paymentId },
        data: { deletedAt: new Date() },
      });

      if (existingPayment.debtId) {
        let updatedDebt = await recalculateDebtAndRelations(tx, existingPayment.debtId);

        // Se o pagamento removido era exatamente o ultimo juros (ciclo) registrado, esperamos que o vencimento
        // volte 1 mes. Se isso nao acontecer, geralmente eh sinal de `originalDueDate` ter sido sobrescrito
        // anteriormente. Tentamos reparar ajustando o `originalDueDate` para o valor coerente com o rollback.
        if (shouldRollbackCycle && updatedDebt && expectedDueDate && !isSameDay(updatedDebt.dueDate, expectedDueDate)) {
          const debtAfter = await tx.debt.findFirst({
            where: { id: existingPayment.debtId },
            include: {
              payments: {
                where: { deletedAt: null },
                orderBy: { paidAt: 'asc' },
              },
            },
          });

          if (!debtAfter) return;

          const payments = debtAfter.payments || [];
          const maxAttempts = Math.min(120, Math.max(payments.length + 24, 12));

          for (let monthsBack = 0; monthsBack <= maxAttempts; monthsBack += 1) {
            const candidateOriginalDueDate = addMonthsKeepingDay(expectedDueDate, -monthsBack);
            const simulation = simulatePaymentsForDebt(
              {
                ...debtAfter,
                originalDueDate: candidateOriginalDueDate,
                dueDate: candidateOriginalDueDate,
              },
              payments,
            );

            if (isSameDay(simulation.state.dueDate, expectedDueDate)) {
              await tx.debt.update({
                where: { id: existingPayment.debtId },
                data: {
                  originalDueDate: candidateOriginalDueDate,
                },
              });

              updatedDebt = await recalculateDebtAndRelations(tx, existingPayment.debtId);
              break;
            }
          }
        }
      }
    });

    await writeAuditLog({
      req,
      action: 'PAYMENT_DELETED',
      entity: 'Payment',
      entityId: existingPayment.id,
      severity: 'WARNING',
      metadata: {
        type: existingPayment.type,
        amount: existingPayment.amount,
        clientId: existingPayment.clientId,
        debtId: existingPayment.debtId,
        installmentId: existingPayment.installmentId,
        paidAt: existingPayment.paidAt,
        note: existingPayment.note,
      },
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
        deletedAt: null,
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
        deletedAt: null,
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
        deletedAt: null,
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
  previewPayment,
  updatePayment,
  deletePayment,
  getMyPayments,
  getPaymentHistory,
  getPaymentHistoryByClient,
};

