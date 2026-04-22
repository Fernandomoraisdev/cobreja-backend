const { verifyAuthToken } = require('./utils/auth');
const prisma = require('./prisma');

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ message: 'Token nao fornecido', data: {} });
  }

  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

  try {
    const decoded = verifyAuthToken(token);

    // Backward compatibility: older tokens might be missing accountId/role.
    // In that case, we hydrate the session from the database.
    if (!decoded?.accountId || !decoded?.role) {
      const userId = Number(decoded?.id);
      if (!userId) {
        return res.status(401).json({ message: 'Token invalido', data: {} });
      }

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          name: true,
          email: true,
          cpf: true,
          accountId: true,
          role: true,
        },
      });

      if (!user) {
        return res.status(401).json({ message: 'Token invalido', data: {} });
      }

      req.user = {
        ...decoded,
        id: user.id,
        name: user.name,
        email: user.email,
        cpf: user.cpf,
        accountId: user.accountId,
        role: user.role,
      };
      return next();
    }

    req.user = decoded;
    return next();
  } catch (err) {
    return res.status(401).json({ message: 'Token invalido', data: {} });
  }
}

module.exports = authMiddleware;
