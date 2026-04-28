const prisma = require('../prisma');
const { enrichDebt, roundMoney } = require('../services/debt.service');
const { buildDashboardSummary } = require('../services/dashboard.service');
const bcrypt = require('bcrypt');

const baseClientInclude = {
  debts: {
    where: { deletedAt: null },
    orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
  },
  payments: {
    orderBy: { paidAt: 'desc' },
  },
  renegotiations: {
    include: {
      debts: {
        where: { deletedAt: null },
        orderBy: { createdAt: 'desc' },
      },
      installments: {
        orderBy: { installmentNumber: 'asc' },
      },
    },
    orderBy: { createdAt: 'desc' },
  },
  installments: {
    orderBy: [{ dueDate: 'desc' }, { installmentNumber: 'desc' }],
  },
};

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase() || null;
}

function normalizeCpf(value) {
  const digits = String(value || '').replace(/\D+/g, '');
  return digits || null;
}

function normalizeClientName(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  // Match across case/whitespace/accents (helps consolidating legacy duplicates).
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
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
    clientId: payment.clientId,
    debtId: payment.debtId,
    installmentId: payment.installmentId,
    paidAt: payment.paidAt,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
  };
}

function serializeInstallment(installment) {
  const remainingAmount = roundMoney(
    Math.max(Number(installment.amount || 0) - Number(installment.paidAmount || 0), 0),
  );

  return {
    id: installment.id,
    installmentNumber: installment.installmentNumber,
    amount: installment.amount,
    paidAmount: installment.paidAmount,
    remainingAmount,
    dueDate: installment.dueDate,
    paidAt: installment.paidAt,
    status: installment.status,
    note: installment.note,
    clientId: installment.clientId,
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
    debts: (renegotiation.debts || []).map((debt) => enrichDebt(debt)),
    installments: (renegotiation.installments || []).map(serializeInstallment),
  };
}

function serializeClient(client, { includeCollections = true } = {}) {
  const debts = (client.debts || []).map((debt) => enrichDebt(debt));
  const payments = (client.payments || []).map(serializePayment);
  const renegotiations = (client.renegotiations || []).map(serializeRenegotiation);
  const installments = (client.installments || []).map(serializeInstallment);

  const activeDebts = debts.filter((debt) => debt.status === 'ACTIVE');
  const settledDebts = debts.filter((debt) => debt.status === 'SETTLED');
  const overdueDebts = activeDebts.filter((debt) => debt.snapshot.isOverdue);
  const dueTodayDebts = activeDebts.filter((debt) => debt.snapshot.dueToday);
  const renegotiatedDebts = activeDebts.filter((debt) => debt.kind === 'RENEGOTIATED');
  const totalOpen = roundMoney(
    activeDebts.reduce((sum, debt) => sum + debt.snapshot.totalDue, 0),
  );

  const payload = {
    id: client.id,
    name: client.name,
    userId: client.userId,
    cpf: client.cpf,
    address: client.address,
    phone: client.phone,
    email: client.email,
    avatarUrl: client.avatarUrl,
    notes: client.notes,
    status: client.status,
    deletedAt: client.deletedAt,
    createdAt: client.createdAt,
    updatedAt: client.updatedAt,
    summary: {
      totalOpen,
      activeDebtCount: activeDebts.length,
      settledDebtCount: settledDebts.length,
      overdueDebtCount: overdueDebts.length,
      dueTodayCount: dueTodayDebts.length,
      renegotiatedDebtCount: renegotiatedDebts.length,
      jurosPaymentsCount: payments.filter((payment) => payment.type === 'JUROS').length,
      installmentPaymentsCount: payments.filter((payment) => payment.type === 'PARCELA').length,
    },
    tabs: {
      excluded: client.status === 'EXCLUDED',
      devendo: client.status !== 'EXCLUDED' && activeDebts.length > 0,
      emAtraso: client.status !== 'EXCLUDED' && overdueDebts.length > 0,
      venceHoje: client.status !== 'EXCLUDED' && dueTodayDebts.length > 0,
      renegociados: client.status !== 'EXCLUDED' && renegotiatedDebts.length > 0,
      quitados:
        client.status !== 'EXCLUDED' && activeDebts.length === 0 && settledDebts.length > 0,
      jurosPagos: payments.some((payment) => payment.type === 'JUROS'),
      parcelasPagas: payments.some((payment) => payment.type === 'PARCELA'),
    },
  };

  if (includeCollections) {
    payload.debts = debts;
    payload.payments = payments;
    payload.renegotiations = renegotiations;
    payload.installments = installments;
  }

  return payload;
}

function sanitizeUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    cpf: user.cpf,
    phone: user.phone,
    avatarUrl: user.avatarUrl,
    role: user.role,
    accountId: user.accountId,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

async function ensureClientUniqueness({ accountId, cpf, email, ignoreClientId = null }) {
  const duplicated = await prisma.client.findFirst({
    where: {
      accountId,
      OR: [
        ...(cpf ? [{ cpf }] : []),
        ...(email ? [{ email }] : []),
      ],
      ...(ignoreClientId ? { id: { not: ignoreClientId } } : {}),
    },
  });

  if (!duplicated) return null;

  if (cpf && duplicated.cpf === cpf) {
    return 'Ja existe um cliente com este CPF nesta conta';
  }

  if (email && duplicated.email === email) {
    return 'Ja existe um cliente com este email nesta conta';
  }

  return 'Ja existe um cliente com estes dados nesta conta';
}

async function getMyRequests(req, res) {
  try {
    const client = await prisma.client.findUnique({
      where: { userId: req.user.id },
    });

    if (!client) {
      return res.status(404).json({ message: 'Cliente nao encontrado', data: {} });
    }

    const requests = await prisma.creditRequest.findMany({
      where: {
        clientId: client.id,
        accountId: req.user.accountId,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return res.json({
      message: 'Pedidos carregados com sucesso',
      data: requests,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Erro ao buscar pedidos', data: {} });
  }
}

async function linkClient(req, res) {
  try {
    const userId = Number(req.body.userId);
    const clientId = Number(req.body.clientId);

    if (!userId || !clientId) {
      return res.status(400).json({
        message: 'userId e clientId sao obrigatorios',
        data: {},
      });
    }

    const client = await prisma.client.update({
      where: { id: clientId },
      data: { userId },
    });

    return res.json({
      message: 'Cliente vinculado ao usuario com sucesso',
      data: client,
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ message: 'Erro ao vincular cliente', data: {} });
  }
}

async function createClient(req, res) {
  try {
    const name = String(req.body.name || '').trim();
    const cpf = normalizeCpf(req.body.cpf);
    const email = normalizeEmail(req.body.email);
    const address = String(req.body.address || '').trim() || null;
    const phone = String(req.body.phone || '').trim() || null;
    const avatarUrl = String(req.body.avatarUrl || '').trim() || null;
    const notes = String(req.body.notes || '').trim() || null;

    if (!name) {
      return res.status(400).json({ message: 'Nome do cliente e obrigatorio', data: {} });
    }

    const duplicatedMessage = await ensureClientUniqueness({
      accountId: req.user.accountId,
      cpf,
      email,
    });

    if (duplicatedMessage) {
      return res.status(400).json({ message: duplicatedMessage, data: {} });
    }

    const client = await prisma.client.create({
      data: {
        name,
        cpf,
        email,
        address,
        phone,
        avatarUrl,
        notes,
        accountId: req.user.accountId,
        status: 'ACTIVE',
      },
      include: baseClientInclude,
    });

    return res.status(201).json({
      message: 'Cliente criado com sucesso',
      data: serializeClient(client),
      client: serializeClient(client),
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ message: 'Erro ao criar cliente', data: {} });
  }
}

async function createClientLogin(req, res) {
  try {
    const clientId = Number(req.params.id);
    const password = String(req.body.password || '');
    const mergeByName = Boolean(req.body.mergeByName);

    if (!clientId) {
      return res.status(400).json({ message: 'ID do cliente invalido', data: {} });
    }

    if (!password || password.length < 4) {
      return res.status(400).json({
        message: 'Informe uma senha valida para criar o login do cliente',
        data: {},
      });
    }

    const client = await prisma.client.findFirst({
      where: {
        id: clientId,
        accountId: req.user.accountId,
      },
      include: baseClientInclude,
    });

    if (!client) {
      return res.status(404).json({ message: 'Cliente nao encontrado', data: {} });
    }

    if (client.userId) {
      return res.status(400).json({
        message: 'Este cliente ja possui um login vinculado',
        data: {},
      });
    }

    const cpf = normalizeCpf(req.body.cpf ?? client.cpf);
    const clientEmail = normalizeEmail(req.body.email ?? client.email);
    // O User.email é obrigatório no banco. Se o cliente não tiver email, geramos um placeholder
    // só para fins de autenticação, mas não salvamos isso no perfil do cliente.
    const email = clientEmail ?? `cliente-${client.id}@cobreja.local`;

    if (!cpf && !clientEmail) {
      return res.status(400).json({
        message: 'Informe email ou CPF para gerar o login do cliente',
        data: {},
      });
    }

    const duplicated = await prisma.user.findFirst({
      where: {
        OR: [
          ...(email ? [{ email }] : []),
          ...(cpf ? [{ cpf }] : []),
        ],
      },
    });

    if (duplicated) {
      return res.status(400).json({
        message: 'Ja existe um usuario com este email ou CPF',
        data: {},
      });
    }

    const duplicatedMessage = await ensureClientUniqueness({
      accountId: req.user.accountId,
      cpf,
      email: clientEmail,
      ignoreClientId: clientId,
    });

    if (duplicatedMessage) {
      return res.status(400).json({ message: duplicatedMessage, data: {} });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const name = String(req.body.name || client.name || '').trim() || 'Cliente';
    const phone = String(req.body.phone || client.phone || '').trim() || null;
    const avatarUrl = String(req.body.avatarUrl || client.avatarUrl || '').trim() || null;

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name,
          email,
          cpf: cpf || null,
          password: hashedPassword,
          phone,
          avatarUrl,
          role: 'CLIENT',
          accountId: req.user.accountId,
        },
      });

      const updatedClient = await tx.client.update({
        where: { id: client.id },
        data: {
          userId: user.id,
          // Mantém o perfil do cliente preenchido com dados reais quando informados.
          ...(cpf ? { cpf } : {}),
          ...(clientEmail ? { email: clientEmail } : {}),
          ...(phone ? { phone } : {}),
          ...(avatarUrl ? { avatarUrl } : {}),
          ...(name ? { name } : {}),
        },
      });

      if (mergeByName) {
        const targetName = normalizeClientName(updatedClient.name);
        if (targetName) {
          const candidates = await tx.client.findMany({
            where: {
              accountId: req.user.accountId,
              deletedAt: null,
              status: 'ACTIVE',
            },
            select: { id: true, name: true, userId: true },
          });

          const duplicates = candidates
            .filter((candidate) => candidate.id !== updatedClient.id)
            .filter((candidate) => normalizeClientName(candidate.name) === targetName);

          const duplicateIds = duplicates.map((candidate) => candidate.id);
          const duplicateUserIds = duplicates
            .map((candidate) => candidate.userId)
            .filter((userId) => userId != null);

          if (duplicateIds.length) {
            if (duplicateUserIds.length) {
              const linkedUsers = await tx.user.findMany({
                where: { id: { in: duplicateUserIds } },
                select: { id: true, role: true },
              });

              const invalid = linkedUsers.filter((user) => user.role !== 'CLIENT');
              if (invalid.length) {
                throw new Error(
                  `Nao e possivel unificar porque existem perfis vinculados a usuarios nao-CLIENT: ${invalid
                    .map((user) => user.id)
                    .join(', ')}`,
                );
              }
            }

            await tx.debt.updateMany({
              where: {
                accountId: req.user.accountId,
                clientId: { in: duplicateIds },
              },
              data: { clientId: updatedClient.id },
            });

            await tx.payment.updateMany({
              where: {
                accountId: req.user.accountId,
                clientId: { in: duplicateIds },
              },
              data: { clientId: updatedClient.id },
            });

            await tx.renegotiation.updateMany({
              where: {
                accountId: req.user.accountId,
                clientId: { in: duplicateIds },
              },
              data: { clientId: updatedClient.id },
            });

            await tx.installment.updateMany({
              where: {
                accountId: req.user.accountId,
                clientId: { in: duplicateIds },
              },
              data: { clientId: updatedClient.id },
            });

            await tx.creditRequest.updateMany({
              where: {
                accountId: req.user.accountId,
                clientId: { in: duplicateIds },
              },
              data: { clientId: updatedClient.id },
            });

            await tx.client.updateMany({
              where: {
                accountId: req.user.accountId,
                id: { in: duplicateIds },
              },
              data: {
                status: 'EXCLUDED',
                deletedAt: new Date(),
                userId: null,
              },
            });
          }
        }
      }

      const refreshedClient = await tx.client.findFirst({
        where: { id: updatedClient.id, accountId: req.user.accountId },
        include: baseClientInclude,
      });

      return { user, updatedClient: refreshedClient || updatedClient };
    });

    return res.status(201).json({
      message: 'Login do cliente criado com sucesso',
      data: {
        user: sanitizeUser(result.user),
        client: serializeClient(result.updatedClient),
      },
    });
  } catch (err) {
    console.log(err);
    const message = err?.message || 'Erro ao criar login do cliente';
    if (String(message).startsWith('Nao e possivel unificar')) {
      return res.status(400).json({ message, data: {} });
    }
    return res.status(500).json({ message: 'Erro ao criar login do cliente', data: {} });
  }
}

async function mergeClientDuplicates(req, res) {
  try {
    const clientId = Number(req.params.id);
    const mergeByName = req.body?.mergeByName !== false;

    if (!clientId) {
      return res.status(400).json({ message: 'ID do cliente invalido', data: {} });
    }

    const client = await prisma.client.findFirst({
      where: {
        id: clientId,
        accountId: req.user.accountId,
      },
      select: {
        id: true,
        name: true,
        userId: true,
      },
    });

    if (!client) {
      return res.status(404).json({ message: 'Cliente nao encontrado', data: {} });
    }

    const targetName = normalizeClientName(client.name);
    if (!mergeByName || !targetName) {
      return res.json({
        message: 'Nenhum duplicado encontrado',
        data: {
          mergedClients: 0,
          mergedDebts: 0,
        },
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const candidates = await tx.client.findMany({
        where: {
          accountId: req.user.accountId,
          deletedAt: null,
          status: 'ACTIVE',
        },
        select: { id: true, name: true, userId: true },
      });

      const duplicates = candidates
        .filter((candidate) => candidate.id !== client.id)
        .filter((candidate) => normalizeClientName(candidate.name) === targetName);

      const duplicateIds = duplicates.map((candidate) => candidate.id);
      if (!duplicateIds.length) {
        const refreshed = await tx.client.findFirst({
          where: { id: client.id, accountId: req.user.accountId },
          include: baseClientInclude,
        });
        return { mergedClients: 0, mergedDebts: 0, client: refreshed };
      }

      const linkedUserIds = Array.from(
        new Set(
          [client.userId, ...duplicates.map((candidate) => candidate.userId)].filter(
            (userId) => userId != null,
          ),
        ),
      );

      // Regra de seguranÃ§a: nÃ£o unificamos registros com logins diferentes,
      // para nÃ£o misturar carteiras de pessoas distintas.
      if (linkedUserIds.length > 1) {
        throw new Error(
          `Nao e possivel unificar porque existem multiplos logins vinculados: ${linkedUserIds.join(
            ', ',
          )}`,
        );
      }

      if (linkedUserIds.length) {
        const linkedUsers = await tx.user.findMany({
          where: { id: { in: linkedUserIds } },
          select: { id: true, role: true },
        });

        const invalid = linkedUsers.filter((user) => user.role !== 'CLIENT');
        if (invalid.length) {
          throw new Error(
            `Nao e possivel unificar porque existem perfis vinculados a usuarios nao-CLIENT: ${invalid
              .map((user) => user.id)
              .join(', ')}`,
          );
        }
      }

      const debtUpdate = await tx.debt.updateMany({
        where: {
          accountId: req.user.accountId,
          clientId: { in: duplicateIds },
        },
        data: { clientId: client.id },
      });

      await tx.payment.updateMany({
        where: {
          accountId: req.user.accountId,
          clientId: { in: duplicateIds },
        },
        data: { clientId: client.id },
      });

      await tx.renegotiation.updateMany({
        where: {
          accountId: req.user.accountId,
          clientId: { in: duplicateIds },
        },
        data: { clientId: client.id },
      });

      await tx.installment.updateMany({
        where: {
          accountId: req.user.accountId,
          clientId: { in: duplicateIds },
        },
        data: { clientId: client.id },
      });

      await tx.creditRequest.updateMany({
        where: {
          accountId: req.user.accountId,
          clientId: { in: duplicateIds },
        },
        data: { clientId: client.id },
      });

      await tx.client.updateMany({
        where: {
          accountId: req.user.accountId,
          id: { in: duplicateIds },
        },
        data: {
          status: 'EXCLUDED',
          deletedAt: new Date(),
          // Se algum duplicado tiver login, desconectamos para evitar contas "fantasmas"
          // apontando para um perfil excluido depois da unificacao.
          userId: null,
        },
      });

      // Se o login estava no duplicado e o registro-alvo nÃ£o tinha userId, transferimos
      // o vÃ­nculo para o registro que recebeu as dÃ­vidas.
      if (!client.userId && linkedUserIds.length === 1) {
        await tx.client.update({
          where: { id: client.id },
          data: { userId: linkedUserIds[0] },
        });
      }

      const refreshed = await tx.client.findFirst({
        where: { id: client.id, accountId: req.user.accountId },
        include: baseClientInclude,
      });

      return {
        mergedClients: duplicateIds.length,
        mergedDebts: debtUpdate.count,
        detachedUsers: client.userId ? 0 : linkedUserIds.length,
        client: refreshed,
      };
    });

    return res.json({
      message: 'Duplicados unificados com sucesso',
      data: {
        mergedClients: result.mergedClients,
        mergedDebts: result.mergedDebts,
        detachedUsers: result.detachedUsers ?? 0,
        client: result.client ? serializeClient(result.client) : null,
      },
    });
  } catch (err) {
    console.log(err);
    const message = err?.message || 'Erro ao unificar duplicados';
    if (String(message).startsWith('Nao e possivel unificar')) {
      return res.status(400).json({ message, data: {} });
    }
    return res.status(500).json({ message: 'Erro ao unificar duplicados', data: {} });
  }
}

async function getClientsSummary(req, res) {
  try {
    const [clients, payments] = await prisma.$transaction([
      prisma.client.findMany({
        where: { accountId: req.user.accountId },
        include: {
          debts: {
            where: { deletedAt: null },
          },
        },
      }),
      prisma.payment.findMany({
        where: { accountId: req.user.accountId },
      }),
    ]);

    const summary = buildDashboardSummary(clients, payments);

    return res.json({
      message: 'Resumo carregado com sucesso',
      data: summary,
      ...summary,
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ message: 'Erro ao montar resumo', data: {} });
  }
}

async function getClients(req, res) {
  try {
    const clients = await prisma.client.findMany({
      where: { accountId: req.user.accountId },
      include: baseClientInclude,
      orderBy: { name: 'asc' },
    });

    return res.json({
      message: 'Clientes listados com sucesso',
      data: clients.map((client) => serializeClient(client)),
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ message: 'Erro ao listar clientes', data: {} });
  }
}

async function getClientById(req, res) {
  try {
    const clientId = Number(req.params.id);

    if (!clientId) {
      return res.status(400).json({ message: 'ID do cliente invalido', data: {} });
    }

    const client = await prisma.client.findFirst({
      where: {
        id: clientId,
        accountId: req.user.accountId,
      },
      include: baseClientInclude,
    });

    if (!client) {
      return res.status(404).json({ message: 'Cliente nao encontrado', data: {} });
    }

    return res.json({
      message: 'Cliente encontrado com sucesso',
      data: serializeClient(client),
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ message: 'Erro ao buscar cliente', data: {} });
  }
}

async function updateClient(req, res) {
  try {
    const clientId = Number(req.params.id);

    if (!clientId) {
      return res.status(400).json({ message: 'ID do cliente invalido', data: {} });
    }

    const existingClient = await prisma.client.findFirst({
      where: {
        id: clientId,
        accountId: req.user.accountId,
      },
    });

    if (!existingClient) {
      return res.status(404).json({ message: 'Cliente nao encontrado', data: {} });
    }

    const data = {};

    if (req.body.name !== undefined) data.name = String(req.body.name || '').trim();
    if (req.body.cpf !== undefined) data.cpf = normalizeCpf(req.body.cpf);
    if (req.body.email !== undefined) data.email = normalizeEmail(req.body.email);
    if (req.body.address !== undefined) data.address = String(req.body.address || '').trim() || null;
    if (req.body.phone !== undefined) data.phone = String(req.body.phone || '').trim() || null;
    if (req.body.avatarUrl !== undefined) data.avatarUrl = String(req.body.avatarUrl || '').trim() || null;
    if (req.body.notes !== undefined) data.notes = String(req.body.notes || '').trim() || null;
    if (req.body.status !== undefined) data.status = String(req.body.status).toUpperCase();

    const duplicatedMessage = await ensureClientUniqueness({
      accountId: req.user.accountId,
      cpf: data.cpf === undefined ? existingClient.cpf : data.cpf,
      email: data.email === undefined ? existingClient.email : data.email,
      ignoreClientId: clientId,
    });

    if (duplicatedMessage) {
      return res.status(400).json({ message: duplicatedMessage, data: {} });
    }

    const updatedClient = await prisma.client.update({
      where: { id: clientId },
      data,
      include: baseClientInclude,
    });

    return res.json({
      message: 'Cliente atualizado com sucesso',
      data: serializeClient(updatedClient),
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ message: 'Erro ao atualizar cliente', data: {} });
  }
}

async function deleteClient(req, res) {
  try {
    const clientId = Number(req.params.id);

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

    const updatedClient = await prisma.client.update({
      where: { id: clientId },
      data: {
        status: 'EXCLUDED',
        deletedAt: new Date(),
      },
      include: baseClientInclude,
    });

    return res.json({
      message: 'Cliente movido para excluidos',
      data: serializeClient(updatedClient),
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ message: 'Erro ao excluir cliente', data: {} });
  }
}

async function restoreClient(req, res) {
  try {
    const clientId = Number(req.params.id);

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

    const restoredClient = await prisma.client.update({
      where: { id: clientId },
      data: {
        status: 'ACTIVE',
        deletedAt: null,
      },
      include: baseClientInclude,
    });

    return res.json({
      message: 'Cliente restaurado com sucesso',
      data: serializeClient(restoredClient),
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ message: 'Erro ao restaurar cliente', data: {} });
  }
}

async function permanentlyDeleteClient(req, res) {
  try {
    const clientId = Number(req.params.id);

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

    await prisma.$transaction([
      prisma.payment.deleteMany({
        where: {
          clientId,
          accountId: req.user.accountId,
        },
      }),
      prisma.installment.deleteMany({
        where: {
          clientId,
          accountId: req.user.accountId,
        },
      }),
      prisma.debt.deleteMany({
        where: {
          clientId,
          accountId: req.user.accountId,
        },
      }),
      prisma.renegotiation.deleteMany({
        where: {
          clientId,
          accountId: req.user.accountId,
        },
      }),
      prisma.creditRequest.deleteMany({
        where: {
          clientId,
          accountId: req.user.accountId,
        },
      }),
      prisma.client.delete({
        where: { id: clientId },
      }),
    ]);

    return res.json({
      message: 'Cliente removido definitivamente com sucesso',
      data: {},
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ message: 'Erro ao remover cliente definitivamente', data: {} });
  }
}

module.exports = {
  getMyRequests,
  linkClient,
  createClient,
  createClientLogin,
  mergeClientDuplicates,
  getClientsSummary,
  getClients,
  getClientById,
  updateClient,
  deleteClient,
  restoreClient,
  permanentlyDeleteClient,
};
