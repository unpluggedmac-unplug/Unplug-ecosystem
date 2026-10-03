// Stable authentication import path.
// auth-entry handles repeated-unverified-signup recovery, then delegates the
// full authentication surface to auth-v2.
module.exports = require('./auth-entry');
