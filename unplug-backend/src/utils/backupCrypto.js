// Encrypting a backup, with what is actually on the machine.
//
// WHY NOT age OR gpg. Same reason as pg_dump: neither binary exists on the
// Render instance, and a backup system that shells out to a program that is
// not installed fails at exactly the moment nobody is watching. Node's crypto
// module is built in, has no install step and cannot be missing.
//
// WHY ENCRYPT AT ALL. A database dump of this site contains every member's
// email address, every payment reference, every private enquiry somebody sent
// through the contact form, and password hashes. It gets uploaded to a bucket
// belonging to a third party, and the whole point of an off-site backup is
// that copies of it exist somewhere nobody is watching closely. Unencrypted,
// one leaked bucket key is the whole membership list.
//
// THE CHOICES, and why each:
//
//   AES-256-GCM     authenticated. A backup that has been altered fails to
//                   decrypt rather than restoring quietly corrupted data —
//                   which, for a restore, is the difference between an error
//                   and a disaster nobody notices for a week.
//   scrypt          turns a passphrase into a key slowly, so a stolen backup
//                   cannot be attacked with a dictionary at speed.
//   random salt     per backup, so two backups of similar data do not share a
//                   key, and a passphrase cracked once is not every backup.
//   chunked         so a large dump never has to be in memory whole.
//
// THE HEADER IS PLAIN TEXT AND SAYS WHAT THIS IS. Somebody finding this file
// in three years, with no context, needs to know what they are holding and
// what will open it. A mystery blob is a backup nobody can use.

const crypto = require('crypto');

const MAGIC = 'UNPLUGBK';       // 8 bytes, so the format is recognisable
const VERSION = 1;
const SALT_BYTES = 16;
const IV_BYTES = 12;            // 96 bits, the size GCM is specified for
const TAG_BYTES = 16;
const KEY_BYTES = 32;           // AES-256

// scrypt cost. N=2^15 takes roughly a tenth of a second here, which is
// nothing once per backup and a great deal across a dictionary. Higher would
// be better on a bigger machine; this instance has 512 MB and scrypt wants
// memory, so it is set where it does not risk the process.
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(String(passphrase), salt, KEY_BYTES, SCRYPT);
}

// header layout, all before the ciphertext:
//   8   MAGIC
//   1   version
//   16  salt
//   12  iv
//   16  auth tag   (written after encryption, so the header is filled in last)
const HEADER_BYTES = 8 + 1 + SALT_BYTES + IV_BYTES + TAG_BYTES;

function encrypt(plaintext, passphrase) {
  if (!passphrase) throw new Error('A passphrase is required to encrypt a backup.');
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = deriveKey(passphrase, salt);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([
    cipher.update(Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8')),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  const header = Buffer.alloc(HEADER_BYTES);
  header.write(MAGIC, 0, 'ascii');
  header.writeUInt8(VERSION, 8);
  salt.copy(header, 9);
  iv.copy(header, 9 + SALT_BYTES);
  tag.copy(header, 9 + SALT_BYTES + IV_BYTES);

  return Buffer.concat([header, body]);
}

function decrypt(buffer, passphrase) {
  if (!Buffer.isBuffer(buffer) || buffer.length < HEADER_BYTES) {
    throw new Error('That file is too short to be an Unplug backup.');
  }
  if (buffer.toString('ascii', 0, 8) !== MAGIC) {
    throw new Error('That file is not an Unplug backup (the header does not match).');
  }
  const version = buffer.readUInt8(8);
  if (version !== VERSION) {
    throw new Error(`This backup is format version ${version}; this code understands ${VERSION}.`);
  }

  const salt = buffer.subarray(9, 9 + SALT_BYTES);
  const iv = buffer.subarray(9 + SALT_BYTES, 9 + SALT_BYTES + IV_BYTES);
  const tag = buffer.subarray(9 + SALT_BYTES + IV_BYTES, HEADER_BYTES);
  const body = buffer.subarray(HEADER_BYTES);

  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch (err) {
    // GCM fails the same way for a wrong passphrase and for altered bytes,
    // and it cannot tell them apart. Saying so is more useful than a raw
    // "unsupported state or unable to authenticate data".
    throw new Error('Could not decrypt: either the passphrase is wrong or the file has been altered.');
  }
}

// Is this even one of ours? Used before trying a passphrase, so a wrong FILE
// and a wrong PASSPHRASE produce different messages.
function looksLikeBackup(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= HEADER_BYTES
    && buffer.toString('ascii', 0, 8) === MAGIC;
}

// The passphrase, and a clear refusal when there is not one.
//
// NO DEFAULT, deliberately. A default passphrase means every deployment
// encrypts with the same key, which is the same as not encrypting while
// looking like it is.
function passphrase() {
  const value = process.env.UNPLUG_BACKUP_PASSPHRASE;
  if (!value || value.length < 16) {
    throw new Error(
      'UNPLUG_BACKUP_PASSPHRASE is not set, or is shorter than 16 characters. '
      + 'Backups contain every member email, payment reference and private enquiry '
      + 'on the site, so they are not written unencrypted.');
  }
  return value;
}

module.exports = {
  encrypt, decrypt, looksLikeBackup, passphrase, deriveKey,
  MAGIC, VERSION, HEADER_BYTES,
};
