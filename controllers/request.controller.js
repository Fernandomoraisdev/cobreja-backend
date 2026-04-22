const prisma = require('../prisma');
const { enrichDebt } = require('../services/debt.service');

async function createRequest(req, res) {
  try {
    const amount = Number(req.body.amount || 0);
    const description = req.body.description ? String(req.body.description).trim() : null;
    const type = String(req.body.type || '').trim();

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

    const debt = await prisma.debt.create({
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
        borrowedAt: request.createdAt ? new Date(request.createdAt) : new Date(),
        originalDueDate: dueDate,
        dueDate,
        clientId: request.clientId,
        accountId: req.user.accountId,
      },
    });

    await prisma.creditRequest.update({
      where: { id: request.id },
      data: {
        status: 'APPROVED',
      },
    });

    return res.json({
      message: 'Pedido aprovado e divida criada',
      data: enrichDebt(debt),
      debt: enrichDebt(debt),
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

