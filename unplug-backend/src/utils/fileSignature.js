// What a file actually IS, read from its first bytes.
//
// WHY THIS IS NEEDED. Every upload here was accepted or rejected on
// `file.mimetype`, which multer takes from the Content-Type the BROWSER put in
// the multipart body. That value is whatever the client chose to send. Anyone
// can post a file of any kind and label it "image/png"; nothing was looking.
//
// WHAT THAT ACTUALLY RISKS, for a site that stores uploads in a public bucket
// and hands out the URL:
//
//   - An HTML file served from our own storage domain, which is a stored XSS
//     against anyone who opens the link.
//   - An SVG, which is a document that can carry script, not a picture.
//   - A PDF passed off as an image, or anything at all passed off as a PDF.
//
// The container format is the one part of an upload the sender cannot lie
// about, because the bytes have to parse as that format to be usable at all.
//
// THIS IS A SECOND GATE, NOT A REPLACEMENT. The declared type is still
// checked first — it is cheap and rejects the obvious. This catches the case
// where the two disagree, which is the case worth caring about.

const fs = require('fs');

// Magic numbers, from the format specifications.
//
// Deliberately a short, explicit list rather than a library: these are the
// only formats this site accepts, the signatures do not change, and a
// dependency that guesses at two hundred formats is a larger surface than the
// problem it solves.
const SIGNATURES = [
  { mime: 'image/jpeg', offset: 0, bytes: [0xFF, 0xD8, 0xFF] },
  { mime: 'image/png',  offset: 0, bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  { mime: 'image/gif',  offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] },              // GIF8
  { mime: 'application/pdf', offset: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2D] },   // %PDF-
];

// RIFF-based formats carry their real type at offset 8, after the container
// header and length: "RIFF....WEBP". Checking only "RIFF" would also accept a
// WAV file.
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

// AVIF and other ISO base media files start with a length, then "ftyp", then a
// brand. Not accepted on upload today — sharp produces them, people do not
// send them — but recognised so a genuine AVIF is reported honestly rather
// than as "unknown".
const FTYP = [0x66, 0x74, 0x79, 0x70];

function matches(buffer, offset, bytes) {
  if (buffer.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buffer[offset + i] !== bytes[i]) return false;
  }
  return true;
}

// The MIME type the bytes say this is, or null when nothing recognises them.
function detect(buffer) {
  if (!buffer || buffer.length < 12) return null;

  for (const sig of SIGNATURES) {
    if (matches(buffer, sig.offset, sig.bytes)) return sig.mime;
  }
  if (matches(buffer, 0, RIFF) && matches(buffer, 8, WEBP)) return 'image/webp';
  if (matches(buffer, 4, FTYP)) {
    const brand = buffer.slice(8, 12).toString('ascii');
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    return 'video/mp4'; // some other ISO media file; not an image
  }
  return null;
}

// Reads just the head of a file rather than the whole thing. A 60 MB magazine
// PDF does not need to be in memory to know it is a PDF.
function detectFile(path) {
  let fd;
  try {
    fd = fs.openSync(path, 'r');
    const head = Buffer.alloc(32);
    const read = fs.readSync(fd, head, 0, 32, 0);
    return detect(head.slice(0, read));
  } catch (err) {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) { /* already gone */ } }
  }
}

// Is what arrived one of the types this endpoint accepts?
//
// Returns { ok, detected, reason }. The reason is written for the person who
// uploaded the file, not for a log: they are usually not an attacker, they are
// someone whose phone saved a photo in a format we do not take.
function verify(path, allowedMimes) {
  const detected = detectFile(path);

  if (!detected) {
    return {
      ok: false, detected: null,
      reason: 'That file is not one we can read. Please upload a JPEG, PNG or WEBP image.',
    };
  }

  // JPEG has two names in the wild and browsers send both.
  const normalised = detected === 'image/jpg' ? 'image/jpeg' : detected;
  if (!allowedMimes.includes(normalised)) {
    return {
      ok: false, detected: normalised,
      reason: `That file is actually a ${normalised.split('/')[1].toUpperCase()}, which is not accepted here.`,
    };
  }
  return { ok: true, detected: normalised, reason: null };
}

module.exports = { detect, detectFile, verify, SIGNATURES };
