const multer = require('multer');
const { verify } = require('../utils/fileSignature');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024; // 8MB — generous for photos, still bounded

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // Random filename rather than the original — avoids path traversal
    // tricks and collisions, and doesn't leak the uploader's local filename.
    const ext = path.extname(file.originalname).toLowerCase();
    const randomName = crypto.randomBytes(16).toString('hex');
    cb(null, `${randomName}${ext}`);
  },
});

function fileFilter(req, file, cb) {
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    return cb(new Error(`File type ${file.mimetype} is not allowed. Use JPEG, PNG, WEBP, or GIF.`));
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
});

// Magazine edition PDFs need their own uploader: the image filter above would
// reject them outright, and a print-quality monthly edition is comfortably
// larger than the 8MB photo limit.
const MAX_PDF_SIZE_BYTES = 60 * 1024 * 1024; // 60MB — a full magazine issue

function pdfFileFilter(req, file, cb) {
  if (file.mimetype !== 'application/pdf') {
    return cb(new Error(`File type ${file.mimetype} is not allowed here. Upload a PDF.`));
  }
  cb(null, true);
}

const uploadPdf = multer({
  storage,
  fileFilter: pdfFileFilter,
  limits: { fileSize: MAX_PDF_SIZE_BYTES },
});

// Proof of payment (bank app screenshot or an emailed PDF confirmation) —
// unlike the image uploader above, a PDF is a completely normal thing for
// this one specifically to receive.
const ALLOWED_PROOF_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_PROOF_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

function proofFileFilter(req, file, cb) {
  if (!ALLOWED_PROOF_MIME_TYPES.includes(file.mimetype)) {
    return cb(new Error(`File type ${file.mimetype} is not allowed. Upload a JPEG, PNG, WEBP or PDF.`));
  }
  cb(null, true);
}

const uploadProof = multer({
  storage,
  fileFilter: proofFileFilter,
  limits: { fileSize: MAX_PROOF_SIZE_BYTES },
});

// Checks that the file on disk really is what it claimed to be, and removes it
// if not.
//
// This CANNOT be done in multer's fileFilter. That runs before any bytes are
// written — it sees only the Content-Type the browser supplied, which is the
// very thing being verified. So the check happens here, immediately after
// multer has saved the file and before anything else is allowed to touch it.
//
// The temp file is deleted on failure. A rejected upload that stays on disk is
// a file an attacker put on our server, and the fact that no URL points at it
// is not much comfort.
function verifySignature(file, allowedMimes) {
  if (!file) return { ok: false, reason: 'No file was uploaded.' };
  const result = verify(file.path, allowedMimes);
  if (!result.ok) {
    fs.unlink(file.path, () => {});
    // Logged with both types, because a mismatch is worth being able to see:
    // an honest one is a phone saving in an odd format, and a dishonest one
    // is somebody probing what this endpoint will store for them.
    console.warn(`[upload] rejected: declared ${file.mimetype}, actually ${result.detected || 'unrecognised'}`);
  }
  return result;
}

module.exports = {
  upload, uploadPdf, uploadProof, verifySignature,
  ALLOWED_MIME_TYPES, ALLOWED_PROOF_MIME_TYPES,
  UPLOAD_DIR, MAX_PDF_SIZE_BYTES, MAX_PROOF_SIZE_BYTES,
};
