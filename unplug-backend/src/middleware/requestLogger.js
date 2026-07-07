// Minimal access log — method, path, status, response time — so
// "why did that request fail" after the fact means checking a log instead
// of guessing (flagged in the build audit as missing). Deliberately plain
// console output rather than a logging library or external service; this
// project has no other infra dependency like that yet, and a line per
// request is enough to grep through for now.
function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs.toFixed(1)}ms`);
  });
  next();
}

module.exports = requestLogger;
