// Taking a backup: dump, encrypt, upload to everywhere configured, prune.
//
// THE ORDER MATTERS, and it is: make the new one, verify it, upload it, and
// only then consider deleting an old one. Pruning first would mean a failure
// halfway leaves fewer backups than there were before it started — the one
// outcome a backup system must never produce.
//
// EVERY BACKUP IS VERIFIED BEFORE IT COUNTS. The dump is decrypted again in
// memory and checked for the markers a real dump ends with. An encrypted file
// that cannot be decrypted is indistinguishable from a good one until the day
// somebody needs it, and that is the day it must not be a surprise.
//
// UPLOADED TO EVERY CONFIGURED DESTINATION, and a failure at one does not stop
// the others. Two providers exist precisely so that a problem with one account
// is not a problem with the backups.

const backupDump = require('./backupDump');
const crypto = require('./backupCrypto');
const storage = require('./backupStorage');

// How many to keep, per destination. Enough that a problem introduced weeks
// ago is still recoverable from before it happened — the common case is not
// "the database died", it is "something has been quietly wrong since the
// fourteenth".
const KEEP = Number(process.env.UNPLUG_BACKUP_KEEP || 14);

function filename(when = new Date()) {
  // Sortable, so listing gives newest last and pruning is obvious.
  return `unplug-${when.toISOString().replace(/[:.]/g, '-')}.unplugbk`;
}

// Reads the dump into memory. Bounded deliberately: this instance has 512 MB,
// and a dump that would not fit is a signal to change the approach rather
// than something to discover during an out-of-memory kill.
const MAX_DUMP_BYTES = 200 * 1024 * 1024;

async function buildDump() {
  const parts = [];
  let bytes = 0;
  const summary = await backupDump.dumpTo((chunk) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_DUMP_BYTES) {
      throw new Error(
        `The dump passed ${Math.round(MAX_DUMP_BYTES / 1024 / 1024)}MB. `
        + 'That is beyond what this instance can hold in memory — the backup '
        + 'needs to stream to disk or storage directly before it can be taken.');
    }
    parts.push(chunk);
  });
  return { text: parts.join(''), summary };
}

// Proves the file that was just made can actually be opened again.
function verify(encrypted, passphrase, expected) {
  const plain = crypto.decrypt(encrypted, passphrase).toString('utf8');
  if (!plain.startsWith('-- Unplug Magazine')) {
    throw new Error('The decrypted backup does not start like a backup.');
  }
  if (!plain.trimEnd().endsWith('COMMIT;')) {
    throw new Error('The decrypted backup is truncated — it does not end with COMMIT.');
  }
  if (expected && plain.length !== expected.length) {
    throw new Error('The decrypted backup does not match what was encrypted.');
  }
  return true;
}

// Takes one backup.
//
// Returns a report. Throws only when NO destination succeeded — if one of two
// providers is having a bad day, the backup still happened.
async function run(options = {}) {
  const started = Date.now();
  const pass = crypto.passphrase();          // throws early, before any work
  const destinations = storage.providers();

  const { text, summary } = await buildDump();
  const encrypted = crypto.encrypt(text, pass);
  verify(encrypted, pass, text);

  const name = filename();
  const results = [];
  for (const provider of destinations) {
    try {
      const put = await provider.put(name, encrypted);
      results.push({ provider: provider.name, ok: true, ...put, warning: provider.warning });
    } catch (err) {
      console.error(`[backup] ${provider.name} failed:`, err.message);
      results.push({ provider: provider.name, ok: false, error: err.message });
    }
  }

  const stored = results.filter((r) => r.ok);
  if (!stored.length) {
    throw new Error('The backup was taken and encrypted, but no destination accepted it.');
  }

  // Only now, with a verified copy safely stored somewhere.
  const pruned = [];
  if (!options.keepAll) {
    for (const provider of destinations) {
      try {
        const existing = await provider.list();
        for (const old of existing.slice(KEEP)) {
          await provider.remove(old.key);
          pruned.push({ provider: provider.name, key: old.key });
        }
      } catch (err) {
        // Failing to prune leaves too many backups, which is not a problem.
        console.warn(`[backup] could not prune ${provider.name}:`, err.message);
      }
    }
  }

  return {
    filename: name,
    rows: summary.rows,
    tables: summary.tables.length,
    sequences: summary.sequences,
    plainBytes: Buffer.byteLength(text),
    encryptedBytes: encrypted.length,
    destinations: results,
    pruned,
    keep: KEEP,
    ms: Date.now() - started,
  };
}

// What is currently stored, per destination. The screen somebody looks at when
// they want to know whether this is actually working.
async function inventory() {
  const out = [];
  for (const provider of storage.providers()) {
    try {
      const items = await provider.list();
      out.push({
        provider: provider.name,
        warning: provider.warning,
        count: items.length,
        newest: items[0] || null,
        items: items.slice(0, 20),
      });
    } catch (err) {
      out.push({ provider: provider.name, error: err.message, count: 0, items: [] });
    }
  }
  return out;
}

// Fetches and decrypts one, without restoring anything. Used by the admin
// download and by the restore script's dry run.
async function fetchDecrypted(key) {
  const pass = crypto.passphrase();
  let lastError;
  for (const provider of storage.providers()) {
    try {
      const buffer = await provider.get(key);
      if (!crypto.looksLikeBackup(buffer)) {
        throw new Error('That file is not an Unplug backup.');
      }
      return { sql: crypto.decrypt(buffer, pass).toString('utf8'), provider: provider.name };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('No destination had that backup.');
}

module.exports = { run, inventory, fetchDecrypted, verify, filename, buildDump, KEEP, MAX_DUMP_BYTES };
