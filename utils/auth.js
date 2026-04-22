const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'cobreja-super-secreta';

function signAuthToken(user) {
  return jwt.sign(
    {
      id: user.id,
      name: user.name,
      email: user.email,
      cpf: user.cpf,
      accountId: user.accountId,
      role: user.role,
    },
    SECRET,
    { expiresIn: '7d' },
  );
}

function verifyAuthToken(token) {
  return jwt.verify(token, SECRET);
}

module.exports = {
  SECRET,
  signAuthToken,
  verifyAuthToken,
};
