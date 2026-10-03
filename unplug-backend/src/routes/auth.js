// Authentication routes are implemented in auth-v2.js.
// Keeping this file as the stable import path avoids changing app.js and any
// existing tests/utilities that require ./routes/auth directly.
module.exports = require('./auth-v2');
