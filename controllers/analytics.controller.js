const prisma = require('../prisma');
const { calculateDebtSnapshot, roundMoney } = require('../services/debt.service');

function startOfDay(date = new Date()) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function endOfDay(date = new Date()) {
  const result = new Date(date);
  result.setHours(23, 59, 59, 999);
  return result;
}

function startOfMonth(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date = new Date()) {
  return endOfDay(new Date(date.getFullYear(), date.getMonth() + 1, 0));
}

function addMonths(date, months) {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

function monthKey(date) {
  const value = new Date(date);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(date) {
  return new Date(date).toLocaleDateString('pt-BR', {
    month: 'short',
    year: '2-digit',
    timeZone: 'America/Sao_Paulo',
  });
}

async function getFinancialAnalytics(req, res) {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ message: 'Apenas ADMIN pode consultar analytics', data: {} });
    }

    const accountId = req.user.accountId;
    const now = new Date();
    const currentMonthStart = startOfMonth(now);
    const currentMonthEnd = endOfMonth(now);
    const previousMonthStart = startOfMonth(addMonths(now, -1));
    const previousMonthEnd = endOfMonth(addMonths(now, -1));
    const next30End = endOfDay(new Date(now.getTime() + 30 * 86400000));
    const chartStart = startOfMonth(addMonths(now, -5));
    const forecastEnd = endOfMonth(addMonths(now, 2));

    const [clients, payments, installments, paymentIntents] = await Promise.all([
      prisma.client.findMany({
        where: { accountId, status: { not: 'EXCLUDED' } },
        include: {
          debts: {
            where: { deletedAt: null },
          },
        },
      }),
      prisma.payment.findMany({
        where: {
          accountId,
          paidAt: { gte: chartStart, lte: currentMonthEnd },
        },
        include: {
          client: { select: { id: true, name: true } },
        },
        orderBy: { paidAt: 'desc' },
      }),
      prisma.installment.findMany({
        where: {
          accountId,
          status: { not: 'PAID' },
          dueDate: { gte: startOfDay(now), lte: forecastEnd },
        },
        include: {
          client: { select: { id: true, name: true, phone: true } },
          debt: { select: { id: true, title: true, status: true } },
        },
        orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      }),
      prisma.paymentIntent.findMany({
        where: {
          accountId,
          provider: 'MERCADO_PAGO',
          createdAt: { gte: currentMonthStart, lte: currentMonthEnd },
        },
      }),
    ]);

    const visibleDebts = clients.flatMap((client) =>
      (client.debts || []).map((debt) => ({ ...debt, client })),
    );
    const activeSnapshots = visibleDebts
      .filter((debt) => debt.status === 'ACTIVE')
      .map((debt) => ({ debt, snapshot: calculateDebtSnapshot(debt, now) }));

    const currentMonthPayments = payments.filter(
      (payment) => payment.paidAt >= currentMonthStart && payment.paidAt <= currentMonthEnd,
    );
    const previousMonthPayments = payments.filter(
      (payment) => payment.paidAt >= previousMonthStart && payment.paidAt <= previousMonthEnd,
    );

    const monthBuckets = Array.from({ length: 6 }, (_, index) => {
      const date = addMonths(now, index - 5);
      return {
        key: monthKey(date),
        label: monthLabel(date),
        received: 0,
        principal: 0,
        interest: 0,
        daily: 0,
        pix: 0,
      };
    });

    for (const payment of payments) {
      const bucket = monthBuckets.find((item) => item.key === monthKey(payment.paidAt));
      if (!bucket) continue;
      bucket.received = roundMoney(bucket.received + Number(payment.amount || 0));
      bucket.principal = roundMoney(bucket.principal + Number(payment.principalAmount || 0));
      bucket.interest = roundMoney(bucket.interest + Number(payment.interestAmount || 0));
      bucket.daily = roundMoney(bucket.daily + Number(payment.dailyAmount || 0));
      if (String(payment.note || '').toLowerCase().includes('mercado pago')) {
        bucket.pix = roundMoney(bucket.pix + Number(payment.amount || 0));
      }
    }

    const forecastBuckets = Array.from({ length: 3 }, (_, index) => {
      const date = addMonths(now, index);
      return {
        key: monthKey(date),
        label: monthLabel(date),
        expected: 0,
        installments: 0,
      };
    });

    for (const installment of installments) {
      const bucket = forecastBuckets.find((item) => item.key === monthKey(installment.dueDate));
      if (!bucket) continue;
      const remaining = Math.max(
        Number(installment.amount || 0) - Number(installment.paidAmount || 0),
        0,
      );
      bucket.expected = roundMoney(bucket.expected + remaining);
      bucket.installments += 1;
    }

    const totalOpen = roundMoney(
      activeSnapshots.reduce((sum, item) => sum + item.snapshot.totalDue, 0),
    );
    const overdueSnapshots = activeSnapshots.filter((item) => item.snapshot.isOverdue);
    const totalOverdue = roundMoney(
      overdueSnapshots.reduce((sum, item) => sum + item.snapshot.totalDue, 0),
    );
    const overdueClientIds = new Set(overdueSnapshots.map((item) => item.debt.clientId));
    const monthlyCash = roundMoney(
      currentMonthPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0),
    );
    const previousMonthlyCash = roundMoney(
      previousMonthPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0),
    );
    const pixApproved = roundMoney(
      paymentIntents
        .filter((intent) => intent.status === 'APPROVED')
        .reduce((sum, intent) => sum + Number(intent.amount || 0), 0),
    );
    const next30Forecast = roundMoney(
      installments
        .filter((installment) => installment.dueDate <= next30End)
        .reduce(
          (sum, installment) =>
            sum + Math.max(Number(installment.amount || 0) - Number(installment.paidAmount || 0), 0),
          0,
        ),
    );

    const overdueRanking = overdueSnapshots
      .map((item) => ({
        clientId: item.debt.clientId,
        clientName: item.debt.client?.name,
        debtId: item.debt.id,
        totalDue: item.snapshot.totalDue,
        overdueDays: item.snapshot.overdueDays,
        dueDate: item.debt.dueDate,
      }))
      .sort((left, right) => right.totalDue - left.totalDue)
      .slice(0, 8);

    return res.json({
      message: 'Analytics financeiro carregado',
      data: {
        period: {
          generatedAt: now,
          currentMonthStart,
          currentMonthEnd,
        },
        kpis: {
          totalOpen,
          monthlyCash,
          previousMonthlyCash,
          monthlyCashDelta: roundMoney(monthlyCash - previousMonthlyCash),
          totalOverdue,
          delinquencyRate: totalOpen > 0 ? Math.round((totalOverdue / totalOpen) * 100) : 0,
          overdueClients: overdueClientIds.size,
          next30Forecast,
          activeLoans: activeSnapshots.length,
          pixApproved,
          pixPending: roundMoney(
            paymentIntents
              .filter((intent) => ['CREATED', 'PENDING', 'IN_PROCESS'].includes(intent.status))
              .reduce((sum, intent) => sum + Number(intent.amount || 0), 0),
          ),
        },
        monthlyReceipts: monthBuckets,
        forecast: forecastBuckets,
        overdueRanking,
        alerts: [
          ...(overdueClientIds.size > 0
            ? [`${overdueClientIds.size} cliente(s) com atraso ativo`]
            : []),
          ...(installments.length > 0
            ? [`${installments.length} parcela(s) em aberto nos proximos 3 meses`]
            : []),
          ...(paymentIntents.some((intent) => ['CREATED', 'PENDING', 'IN_PROCESS'].includes(intent.status))
            ? ['Existem cobranças Pix pendentes no mes']
            : []),
        ],
      },
    });
  } catch (err) {
    console.error('Erro ao carregar analytics financeiro:', err);
    return res.status(500).json({
      message: err.message || 'Erro ao carregar analytics financeiro',
      data: {},
    });
  }
}

module.exports = {
  getFinancialAnalytics,
};
