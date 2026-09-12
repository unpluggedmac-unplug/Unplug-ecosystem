'use strict';

const express = require('express');
const fs = require('fs');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const {
  uploadGrowthImage,
  verifySignature,
  ALLOWED_MIME_TYPES,
  MAX_GROWTH_IMAGE_SIZE_BYTES,
} = require('../middleware/upload');
const uploads = require('./uploads');

const router = express.Router();

function intId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function requireMember(req, res, next) {
  if (!req.user || req.user.role !== 'member') {
    return res.status(403).json({ error: 'Growth Applications are available to member accounts only.' });
  }
  return next();
}

// Growth Application media can contain personal/confidential material. It is
// stored in the PRIVATE R2 bucket and catalogued against the owning application.
// Production fails closed if private R2 storage is unavailable; there is no
// Render-local fallback for these files.
router.post('/', requireAuth, requireMember, (req, res) => {
  if (!uploads.r2PrivateConfigured) {
    return res.status(503).json({
      error: 'Private permanent storage is unavailable right now. Please try again later.',
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
    if (!signature.ok) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: signature.reason });
    }

    const applicationId = intId(req.body && req.body.applicationId);
    const fieldKey = String((req.body && req.body.fieldKey) || '').trim() || null;
    if (!applicationId) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'applicationId is required for a Growth upload.' });
    }

    try {
      const application = await pool.query(
        `SELECT id, status, form_version_id, applicant_type, external_sharing_allowed
           FROM growth_applications WHERE id=$1 AND user_id=$2`,
        [applicationId, req.user.id],
      );
      if (!application.rowCount) {
        fs.unlink(req.file.path, () => {});
        return res.status(404).json({ error: 'Growth Application not found.' });
      }
      const row = application.rows[0];
      if (['withdrawn','completed','closed'].includes(row.status)) {
        fs.unlink(req.file.path, () => {});
        return res.status(409).json({ error: 'This Growth Application can no longer accept uploads.' });
      }

      let field = null;
      if (fieldKey) {
        const fieldResult = await pool.query(
          `SELECT field_key, confidential, allow_external_sharing, sensitive, sensitive_enabled
             FROM growth_form_fields
            WHERE version_id=$1 AND field_key=$2 AND is_enabled=true AND applicant_types ? $3`,
          [row.form_version_id, fieldKey, row.applicant_type],
        );
        if (!fieldResult.rowCount || (fieldResult.rows[0].sensitive && !fieldResult.rows[0].sensitive_enabled)) {
          fs.unlink(req.file.path, () => {});
          return res.status(400).json({ error: 'That upload field is not enabled for this application.' });
        }
        field = fieldResult.rows[0];
      }

      if (row.status !== 'draft') {
        const reopened = fieldKey && await pool.query(
          `SELECT 1 FROM growth_application_field_reopens
            WHERE application_id=$1 AND field_key=$2 AND closed_at IS NULL`,
          [applicationId, fieldKey],
        );
        if (!reopened || !reopened.rowCount) {
          fs.unlink(req.file.path, () => {});
          return res.status(409).json({ error: 'Only a specifically reopened upload field can be changed after submission.' });
        }
      }

      const buffer = fs.readFileSync(req.file.path);
      const objectUrl = await uploads.uploadPrivateBuffer(
        buffer,
        `growth-${applicationId}-${req.file.filename}`,
        req.file.mimetype,
      );
      fs.unlink(req.file.path, () => {});

      const confidential = field ? Boolean(field.confidential || field.sensitive) : true;
      const externalSharingAllowed = Boolean(
        field && field.allow_external_sharing && row.external_sharing_allowed,
      );
      const saved = await pool.query(
        `INSERT INTO growth_uploads
          (application_id,field_key,object_key,original_filename,mime_type,size_bytes,
           confidential,external_sharing_allowed,uploaded_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id,application_id,field_key,original_filename,mime_type,size_bytes,
                   confidential,external_sharing_allowed,created_at`,
        [applicationId, fieldKey, objectUrl, req.file.originalname || req.file.filename,
          req.file.mimetype, req.file.size, confidential, externalSharingAllowed, req.user.id],
      );
      return res.status(201).json({ upload: saved.rows[0], storage: 'r2-private' });
    } catch (storageErr) {
      fs.unlink(req.file.path, () => {});
      console.error('[growth-application] private R2 upload failed:', storageErr.message);
      return res.status(502).json({
        error: 'The file could not be saved to private permanent storage. Please try again.',
      });
    }
  });
});

// Members may retrieve only their own Growth uploads. Staff/admin retrieval is
// intentionally handled through the Growth Admin sensitive surface instead.
router.get('/:uploadId', requireAuth, requireMember, async (req, res, next) => {
  const uploadId = intId(req.params.uploadId);
  if (!uploadId) return res.status(400).json({ error: 'Invalid upload id.' });
  try {
    const result = await pool.query(
      `SELECT gu.object_key, gu.mime_type, gu.original_filename
         FROM growth_uploads gu
         JOIN growth_applications ga ON ga.id=gu.application_id
        WHERE gu.id=$1 AND ga.user_id=$2`,
      [uploadId, req.user.id],
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Growth upload not found.' });
    const stored = await uploads.fetchPrivateObject(result.rows[0].object_key);
    if (!stored.ok) return res.status(502).json({ error: 'The stored file could not be retrieved.' });
    const bytes = Buffer.from(await stored.arrayBuffer());
    res.setHeader('Content-Type', result.rows[0].mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${String(result.rows[0].original_filename || 'growth-upload').replace(/["\r\n]/g, '')}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(bytes);
  } catch (err) { return next(err); }
});

module.exports = router;