const express = require('express');
const { upload } = require('../middleware/upload');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// POST /uploads — member uploads a single image, gets back a URL to use
// as imageUrl / posterImageUrl / photoUrl in any of the other endpoints
// (gallery, marketplace listings, birthdays, etc).
//
// NOTE: this stores files on local disk, served back via express.static
// at the same /uploads path (wired in app.js). That's fine for local
// development and small deployments, but per the Backend Spec (Section 1)
// the production recommendation is S3-compatible object storage — when
// moving to that, only this file needs to change (swap multer's
// diskStorage for a multer-s3 storage engine); every other route that
// accepts an `imageUrl` string doesn't care where it actually lives.
router.post('/', requireAuth, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file was uploaded (expected multipart field "file").' });
    }

    const url = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    res.status(201).json({ url, filename: req.file.filename, sizeBytes: req.file.size });
  });
});

module.exports = router;
