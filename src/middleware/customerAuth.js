// src/middleware/customerAuth.js
function customerAuth(req, res, next) {
  if (req.session && req.session.customerEmail && req.session.prototypeId) {
    return next();
  }
  res.status(401).send('Unauthorised. Please use your share link to access this prototype.');
}

module.exports = customerAuth;
