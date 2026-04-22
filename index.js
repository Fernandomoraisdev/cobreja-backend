require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');

const prisma = require('./prisma');
const clientRoutes = require('./routes/client.routes');
const debtRoutes = require('./routes/debt.routes');
const requestRoutes = require('./routes/request.routes');
const paymentRoutes = require('./routes/payment.routes');
const renegotiationRoutes = require('./routes/renegotiation.routes');
const authMiddleware = require('./authMiddleware');
const { signAuthToken } = require('./utils/auth');
const { getMyDebts } = require('./controllers/debt.controller');
const { getMyPayments } = require('./controllers/payment.controller');

const app = express();

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeCpf(value) {
  return String(value || '').replace(/\D+/g, '');
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
app.use('/api/renegotiation', renegotiationRoutes);

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
      account: user?.account || null,
      client: client || null,
    },
  });
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

app.get('/', (req, res) => {
  res.send('Backend Cobreja rodando');
});

const port = Number(process.env.PORT || 3000);
app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
});
