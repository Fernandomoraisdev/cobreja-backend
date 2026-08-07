const prisma = require('../prisma');
const {
  simulatePaymentsForDebt,
  buildDebtUpdateFromState,
} = require('../services/debt.service');

async function recalculateDebt(tx, debt) {
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

async function main() {
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
    if (!debt.payments.length) continue;
    await prisma.$transaction((tx) => recalculateDebt(tx, debt));
    recalculated += 1;
  }

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
