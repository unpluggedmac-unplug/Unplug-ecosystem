// Honeypot spam trap. Public forms include a hidden "website" field that a
// human never sees or fills, but naive bots auto-fill every field. If it
// arrives non-empty, respond with a fake success (so the bot moves on) and
// silently drop the submission — nothing is stored.
function honeypot(req, res, next) {
  if (req.body && typeof req.body.website === 'string' && req.body.website.trim() !== '') {
    return res.status(201).json({ message: 'Thanks!' });
  }
  next();
}

module.exports = honeypot;
