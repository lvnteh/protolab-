// src/middleware/adminAuth.js
function adminAuth(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.redirect('/admin/login');
}

module.exports = adminAuth;
