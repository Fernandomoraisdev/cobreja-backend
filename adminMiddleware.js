function adminMiddleware(req, res, next) {
   if (req.user.role !== 'ADMIN') {
     return res.status(403).json({ message: 'Acesso negado' });
   }
 
   next();
 }
 
 module.exports = adminMiddleware;