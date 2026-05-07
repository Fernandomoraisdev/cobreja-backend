require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const prisma = require('./prisma');
const clientRoutes = require('./routes/client.routes');
const debtRoutes = require('./routes/debt.routes');
const requestRoutes = require('./routes/request.routes');
const paymentRoutes = require('./routes/payment.routes');
const mercadoPagoRoutes = require('./routes/mercadopago.routes');
const renegotiationRoutes = require('./routes/renegotiation.routes');
const settingsRoutes = require('./routes/settings.routes');
const supportRoutes = require('./routes/support.routes');
const auditRoutes = require('./routes/audit.routes');
const collectionRoutes = require('./routes/collection.routes');
const saasRoutes = require('./routes/saas.routes');
const securityRoutes = require('./routes/security.routes');
const analyticsRoutes = require('./routes/analytics.routes');
const notificationRoutes = require('./routes/notification.routes');
const authMiddleware = require('./authMiddleware');
const { signAuthToken } = require('./utils/auth');
const { getMyDebts } = require('./controllers/debt.controller');
const { getMyPayments } = require('./controllers/payment.controller');
const { enforceClientLimit } = require('./services/saas.service');

const app = express();

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeCpf(value) {
  return String(value || '').replace(/\D+/g, '');
}

function normalizeInviteCode(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function buildInviteCode(accountName) {
  const prefix = normalizeInviteCode(accountName).slice(0, 6) || 'COBREJA';
  return `${prefix}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

async function ensureAccountInviteCode(accountId) {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account) return null;
  if (account.inviteCode) return account;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await prisma.account.update({
        where: { id: account.id },
        data: { inviteCode: buildInviteCode(account.name) },
      });
    } catch (error) {
      if (error?.code !== 'P2002') throw error;
    }
  }

  throw new Error('Nao foi possivel gerar codigo de convite');
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
  };
}

app.use(cors());
app.use(express.json());

app.use('/api/client', clientRoutes);
app.use('/api/debt', debtRoutes);
app.use('/api/request', requestRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/payments/mercadopago', mercadoPagoRoutes);
app.use('/api/renegotiation', renegotiationRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/collections', collectionRoutes);
app.use('/api/saas', saasRoutes);
app.use('/api/security', securityRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/notifications', notificationRoutes);

app.get('/teste-saas', authMiddleware, (req, res) => {
  res.json({
    message: 'SaaS funcionando',
    data: {
      accountId: req.user.accountId,
      user: req.user,
    },
  });
});

app.get('/me', authMiddleware, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { account: true },
  });

  let account = user?.account || null;
  if (user?.role === 'ADMIN' && account) {
    account = await ensureAccountInviteCode(account.id);
  }

  const client = await prisma.client.findUnique({
    where: { userId: req.user.id },
    select: {
      id: true,
      name: true,
      cpf: true,
      address: true,
      phone: true,
      email: true,
      avatarUrl: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return res.json({
    message: 'Usuario carregado com sucesso',
    data: {
      user: sanitizeUser(user),
      account,
      client: client || null,
    },
  });
});

app.get('/invite/:code', async (req, res) => {
  try {
    const inviteCode = normalizeInviteCode(req.params.code);
    if (!inviteCode) {
      return res.status(400).json({ message: 'Codigo de convite invalido', data: {} });
    }

    const account = await prisma.account.findUnique({
      where: { inviteCode },
      include: {
        users: {
          where: { role: 'ADMIN' },
          select: { name: true },
          take: 1,
        },
      },
    });

    if (!account) {
      return res.status(404).json({ message: 'Convite nao encontrado', data: {} });
    }

    return res.json({
      message: 'Convite encontrado',
      data: {
        inviteCode: account.inviteCode,
        accountName: account.name,
        adminName: account.users[0]?.name || account.name,
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Erro ao carregar convite', data: {} });
  }
});

app.get('/my-debts', authMiddleware, getMyDebts);
app.get('/my-payments', authMiddleware, getMyPayments);

app.post('/login', async (req, res) => {
  try {
    const password = String(req.body.password || '');
    const rawIdentifier = req.body.identifier || req.body.email || req.body.cpf;
    const email = normalizeEmail(rawIdentifier);
    const cpf = normalizeCpf(rawIdentifier);

    if (!rawIdentifier || !password) {
      return res.status(400).json({
        message: 'Informe email ou CPF e senha para entrar',
        data: {},
      });
    }

    const user = await prisma.user.findFirst({
      where: {
        OR: [
          ...(email ? [{ email }] : []),
          ...(cpf ? [{ cpf }] : []),
        ],
      },
      include: {
        account: true,
      },
    });

    if (!user) {
      return res.status(401).json({ message: 'Usuario nao encontrado', data: {} });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Senha invalida', data: {} });
    }

    const token = signAuthToken(user);

    try {
      await prisma.auditLog.create({
        data: {
          action: 'LOGIN_SUCCESS',
          entity: 'User',
          entityId: String(user.id),
          severity: 'INFO',
          metadata: { role: user.role },
          ip: req.ip || null,
          userAgent: req.headers?.['user-agent'] || null,
          accountId: user.accountId,
          userId: user.id,
        },
      });
    } catch (auditError) {
      console.error('Erro ao gravar auditoria de login:', auditError);
    }

    return res.json({
      message: 'Login realizado com sucesso',
      data: {
        token,
        user: sanitizeUser(user),
        account: user.account,
      },
      token,
      user: sanitizeUser(user),
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Erro ao realizar login', data: {} });
  }
});

app.post('/register', async (req, res) => {
  try {
    const adminSignupCode = String(process.env.ADMIN_SIGNUP_CODE || '').trim();
    const providedSignupCode = String(req.body.adminSignupCode || '').trim();
    if (!adminSignupCode || providedSignupCode !== adminSignupCode) {
      return res.status(403).json({
        message: 'Cadastro de administrador nao esta liberado publicamente.',
        data: {},
      });
    }

    const name = String(req.body.name || '').trim();
    const email = normalizeEmail(req.body.email);
    const cpf = normalizeCpf(req.body.cpf);
    const password = String(req.body.password || '');
    const phone = String(req.body.phone || '').trim() || null;
    const avatarUrl = String(req.body.avatarUrl || '').trim() || null;

    if (!name || !email || !password) {
      return res.status(400).json({
        message: 'Nome, email e senha sao obrigatorios',
        data: {},
      });
    }

    const duplicatedUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email },
          ...(cpf ? [{ cpf }] : []),
        ],
      },
    });

    if (duplicatedUser) {
      return res.status(400).json({
        message: 'Ja existe um usuario com este email ou CPF',
        data: {},
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        name,
        email,
        cpf: cpf || null,
        password: hashedPassword,
        phone,
        avatarUrl,
        role: 'ADMIN',
        account: {
          create: {
            name,
          },
        },
      },
      include: {
        account: true,
      },
    });

    return res.status(201).json({
      message: 'Usuario criado com sucesso',
      data: {
        user: sanitizeUser(user),
        account: user.account,
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Erro no cadastro', data: {} });
  }
});

app.post('/client-register', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = normalizeEmail(req.body.email);
    const cpf = normalizeCpf(req.body.cpf);
    const password = String(req.body.password || '');
    const phone = String(req.body.phone || '').trim() || null;
    const address = String(req.body.address || '').trim() || null;
    const requestedAccountId = req.body.accountId ? Number(req.body.accountId) : null;
    const inviteCode = normalizeInviteCode(req.body.inviteCode || req.body.convite);

    if (!name || !email || !password) {
      return res.status(400).json({
        message: 'Nome, email e senha sao obrigatorios',
        data: {},
      });
    }

    if (!cpf && !email) {
      return res.status(400).json({
        message: 'Informe CPF ou email para criar a conta de cliente',
        data: {},
      });
    }

    const duplicatedUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email },
          ...(cpf ? [{ cpf }] : []),
        ],
      },
    });

    if (duplicatedUser) {
      return res.status(400).json({
        message: 'Ja existe um usuario com este email ou CPF',
        data: {},
      });
    }

    let accountId = requestedAccountId;
    let client = null;

    if (!accountId && inviteCode) {
      const inviteAccount = await prisma.account.findUnique({
        where: { inviteCode },
      });

      if (!inviteAccount) {
        return res.status(400).json({
          message: 'Codigo de convite invalido. Confira o link enviado pelo administrador.',
          data: {},
        });
      }

      accountId = inviteAccount.id;
    }

    const matchingClients = await prisma.client.findMany({
      where: {
        status: 'ACTIVE',
        ...(accountId ? { accountId } : {}),
        OR: [
          ...(cpf ? [{ cpf }] : []),
          ...(email ? [{ email }] : []),
        ],
      },
      orderBy: { createdAt: 'asc' },
    });

    if (matchingClients.length > 1 && !requestedAccountId) {
      return res.status(409).json({
        message: 'Encontramos mais de um cadastro com estes dados. Fale com o administrador para liberar seu acesso.',
        data: {},
      });
    }

    if (matchingClients.length) {
      client = matchingClients[0];
      accountId = client.accountId;
      if (client.userId) {
        return res.status(400).json({
          message: 'Este cliente ja possui acesso ao sistema',
          data: {},
        });
      }
    }

    if (!accountId) {
      return res.status(400).json({
        message: 'Informe o codigo de convite enviado pelo administrador para criar sua conta.',
        data: {},
      });
    }

    const account = await prisma.account.findUnique({
      where: { id: accountId },
    });

    if (!account) {
      return res.status(404).json({
        message: 'Conta do administrador nao encontrada',
        data: {},
      });
    }

    const duplicatedClient = await prisma.client.findFirst({
      where: {
        accountId,
        OR: [
          ...(cpf ? [{ cpf }] : []),
          ...(email ? [{ email }] : []),
        ],
        ...(client ? { id: { not: client.id } } : {}),
      },
    });

    if (duplicatedClient) {
      return res.status(400).json({
        message: 'Ja existe outro cliente com este CPF ou email nesta conta',
        data: {},
      });
    }

    if (!client) {
      await enforceClientLimit(accountId);
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name,
          email,
          cpf: cpf || null,
          password: hashedPassword,
          phone,
          role: 'CLIENT',
          accountId,
        },
      });

      const linkedClient = client
        ? await tx.client.update({
            where: { id: client.id },
            data: {
              userId: user.id,
              name,
              email,
              cpf: cpf || client.cpf,
              phone,
              address,
            },
          })
        : await tx.client.create({
            data: {
              name,
              email,
              cpf: cpf || null,
              phone,
              address,
              status: 'ACTIVE',
              userId: user.id,
              accountId,
            },
          });

      return { user, client: linkedClient };
    });

    const token = signAuthToken(result.user);

    return res.status(201).json({
      message: 'Conta de cliente criada com sucesso',
      data: {
        token,
        user: sanitizeUser(result.user),
        client: result.client,
        account,
      },
      token,
      user: sanitizeUser(result.user),
    });
  } catch (error) {
    console.error(error);
    return res
      .status(error.statusCode || 500)
      .json({ message: error.message || 'Erro ao criar conta de cliente', data: error.data || {} });
  }
});

app.get('/', (req, res) => {
  res.send('Backend Cobreja rodando');
});

const port = Number(process.env.PORT || 3000);
app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
});
