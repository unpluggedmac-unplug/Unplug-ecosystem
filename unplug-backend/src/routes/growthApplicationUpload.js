'use strict';

const express = require('express');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');
const {
  uploadGrowthImage,
  verifySignature,
  ALLOWED_MIME_TYPES,
  MAX_GROWTH_IMAGE_SIZE_BYTES,
} = require('../middleware/upload');
const uploads = require('./uploads');

const router = express.Router();

// Growth Application has an explicit 10MB/image requirement. This endpoint is
// intentionally separate from POST /uploads (8MB) so the Growth feature does
// not loosen upload limits for the rest of Unplug.
//
// It also FAILS CLOSED whenever R2 is unavailable. A Growth image is part of a
// resumable application and must survive redeploys; accepting it onto Render's
// ephemeral disk would create a draft that appears saved but later loses media.
router.post('/', requireAuth, (req, res) => {
  if (!uploads.r2Configured) {
    return res.status(503).json({
      error: 'Permanent image storage is unavailable right now. Please try again later.',
    });
  }

  uploadGrowthImage.single('file')(req, res, async (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? `That image is too large. The maximum is ${Math.round(MAX_GROWTH_IMAGE_SIZE_BYTES / (1024 * 1024))}MB.`
        : err.message;
      return res.status(400).json({ error: message });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No image was uploaded (expected multipart field "file").' });
    }

    const signature = verifySignature(req.file, ALLOWED_MIME_TYPES);
    if (!signature.ok) return res.status(400).json({ error: signature.reason });

    try {
      const buffer = fs.readFileSync(req.file.path);
      // multer already replaced the original local filename with a random,
      // extension-preserving filename. Prefixing it makes Growth assets easy
      // to audit in R2 without revealing anything from the user's computer.
      const url = await uploads.uploadPublicBuffer(
        buffer,
        `growth-${req.file.filename}`,
        req.file.mimetype,
      );
      fs.unlink(req.file.path, () => {});
      return res.status(201).json({
        url,
        filename: req.file.filename,
        sizeBytes: req.file.size,
        storage: 'r2',
        maxBytes: MAX_GROWTH_IMAGE_SIZE_BYTES,
      });
    } catch (storageErr) {
      fs.unlink(req.file.path, () => {});
      console.error('[growth-application] R2 upload failed:', storageErr.message);
      return res.status(502).json({
        error: 'The image could not be saved to permanent storage. Please try again.',
      });
    }
  });
});

module.exports = router;
