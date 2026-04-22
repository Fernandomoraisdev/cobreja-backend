const { calculateDebtSnapshot, roundMoney } = require('./debt.service');

function buildDashboardSummary(clients, payments, now = new Date()) {
  const visibleClients = clients.filter((client) => client.status !== 'EXCLUDED');
  const allDebts = visibleClients.flatMap((client) => client.debts || []);
  const activeDebts = allDebts.filter((debt) => debt.status === 'ACTIVE');
  const standardDebts = allDebts.filter(
    (debt) => debt.kind === 'STANDARD' && debt.status !== 'EXCLUDED' && !debt.deletedAt,
  );

  let totalToReceive = 0;
  let totalOverdue = 0;
  let totalLoss = 0;

  const activeDebtSnapshots = activeDebts.map((debt) => {
    const snapshot = calculateDebtSnapshot(debt, now);
    totalToReceive = roundMoney(totalToReceive + snapshot.totalDue);
    if (snapshot.isOverdue) {
      totalOverdue = roundMoney(totalOverdue + snapshot.totalDue);
    }
    if (snapshot.overdueDays > 90) {
      totalLoss = roundMoney(totalLoss + snapshot.totalDue);
    }

    return { debt, snapshot };
  });

  const totalReceived = roundMoney(
    payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0),
  );
  const totalProfit = roundMoney(
    payments.reduce(
      (sum, payment) =>
        sum + Number(payment.interestAmount || 0) + Number(payment.dailyAmount || 0),
      0,
    ),
  );
  const totalLent = roundMoney(
    standardDebts.reduce((sum, debt) => sum + Number(debt.principalAmount || 0), 0),
  );

  const clientsSummary = visibleClients.map((client) => {
    const clientDebts = activeDebtSnapshots.filter((item) => item.debt.clientId === client.id);
    const clientPayments = payments.filter((payment) => payment.clientId === client.id);
    const totalOpen = roundMoney(
      clientDebts.reduce((sum, item) => sum + item.snapshot.totalDue, 0),
    );
    const overdueCount = clientDebts.filter((item) => item.snapshot.isOverdue).length;
    const dueTodayCount = clientDebts.filter((item) => item.snapshot.dueToday).length;
    const renegotiatedCount = clientDebts.filter(
      (item) => item.debt.kind === 'RENEGOTIATED',
    ).length;

    return {
      id: client.id,
      name: client.name,
      status: client.status,
      totalOpen,
      activeDebtCount: clientDebts.length,
      overdueCount,
      dueTodayCount,
      renegotiatedCount,
      jurosPaymentsCount: clientPayments.filter((payment) => payment.type === 'JUROS').length,
      installmentPaymentsCount: clientPayments.filter((payment) => payment.type === 'PARCELA').length,
    };
  });

  return {
    activeClients: clientsSummary.filter((client) => client.activeDebtCount > 0).length,
    clientsCount: clientsSummary.length,
    totalToReceive,
    totalReceived,
    totalOverdue,
    totalProfit,
    totalLent,
    totalLoss,
    cards: {
      totalToReceive,
      totalReceived,
      totalOverdue,
      totalProfit,
      totalLent,
      totalLoss,
    },
    clients: clientsSummary,
  };
}

module.exports = {
  buildDashboardSummary,
};
