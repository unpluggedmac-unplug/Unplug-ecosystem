const net = require('net');

// Opens a plain TCP connection and reports what happened. This exists to
// answer one question we cannot answer from a laptop: can THIS server reach
// mail ports at all? A host that blocks outbound SMTP and a mail server that
// refuses us look identical from the outside — both are "Connection timeout"
// — so the only way to tell them apart is to test several targets from here
// and compare.
function probe(host, port, timeoutMs = 6000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (result, detail) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ host, port, result, detail: detail || null, ms: Date.now() - started });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish('open'));
    socket.once('timeout', () => finish('timeout', 'no response within ' + timeoutMs + 'ms'));
    socket.once('error', (err) => finish('error', err.code || err.message));
    socket.connect(port, host);
  });
}

module.exports = { probe };
