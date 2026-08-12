const prisma = require('../prisma');
const {
  isFrozenRenegotiatedSourceDebt,
  simulatePaymentsForDebt,
  buildDebtUpdateFromState,
} = require('../services/debt.service');

async function recalculateDebt(tx, debt) {
  if (isFrozenRenegotiatedSourceDebt(debt)) return;

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

  await tx.debt.update({
    where: { id: debt.id },
    data: buildDebtUpdateFromState(simulation.state),
  });
}

async function restoreFrozenSources() {
  const activeRenegotiations = await prisma.renegotiation.findMany({
    where: { status: 'ACTIVE' },
    select: {
      id: true,
      accountId: true,
      sourceDebtIds: true,
    },
  });

  let restored = 0;
  for (const renegotiation of activeRenegotiations) {
    const sourceDebtIds = Array.isArray(renegotiation.sourceDebtIds)
      ? renegotiation.sourceDebtIds.map((item) => Number(item)).filter(Boolean)
      : [];

    if (!sourceDebtIds.length) continue;

    const result = await prisma.debt.updateMany({
      where: {
        id: { in: sourceDebtIds },
        accountId: renegotiation.accountId,
        kind: { not: 'RENEGOTIATED' },
        deletedAt: null,
        status: { not: 'RENEGOTIATED' },
      },
      data: {
        status: 'RENEGOTIATED',
      },
    });
    restored += result.count;
  }

  return restored;
}

async function main() {
  const restored = await restoreFrozenSources();

  const debts = await prisma.debt.findMany({
    where: {
      deletedAt: null,
    },
    include: {
      payments: {
        where: { deletedAt: null },
        orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
      },
    },
    orderBy: { id: 'asc' },
  });

  let recalculated = 0;
  for (const debt of debts) {
    if (isFrozenRenegotiatedSourceDebt(debt)) continue;
    if (!debt.payments.length) continue;
    await prisma.$transaction((tx) => recalculateDebt(tx, debt));
    recalculated += 1;
  }

  console.log(`Restored ${restored} frozen source debt(s).`);
  console.log(`Recalculated ${recalculated} debt(s).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
