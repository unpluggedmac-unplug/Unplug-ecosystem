const express = require('express');
const fs = require('fs');
const pool = require('../db');
const uploads = require('./uploads');
const { uploadProof, verifySignature, ALLOWED_PROOF_MIME_TYPES, MAX_PROOF_SIZE_BYTES } = require('../middleware/upload');
const G = require('../utils/agreementGenerator');
const S = require('../utils/agreementGeneratorService');

const router = express.Router();

router.post('/generator/access/:token/items/:itemId/upload', async (req, res, next) => {
  if (!uploads.r2PrivateConfigured) return res.status(503).json({ error:'Secure agreement upload storage is unavailable right now.' });
  let access;
  try {
    access = await S.resolveSignerAccess(req.params.token);
    S.assertSignerAccess(access, req);
    if (await S.hasAnySignature(access.submission.id)) return res.status(423).json({ error:'Agreement content is frozen because a signer has already signed.' });
  } catch (err) {
    return res.status(err.statusCode || 403).json({ error:err.message });
  }
  const submission=access.submission;
  uploadProof.single('file')(req,res,async(err)=>{
    if(err){const message=err.code==='LIMIT_FILE_SIZE'?`That file is too large. The maximum is ${Math.round(MAX_PROOF_SIZE_BYTES/(1024*1024))}MB.`:err.message;return res.status(400).json({error:message});}
    if(!req.file)return res.status(400).json({error:'Choose a JPEG, PNG, WEBP or PDF file.'});
    try{
      const signature=verifySignature(req.file,ALLOWED_PROOF_MIME_TYPES);if(!signature.ok){fs.unlink(req.file.path,()=>{});return res.status(400).json({error:signature.reason});}
      const item=await pool.query(`SELECT fi.* FROM agreement_form_items fi WHERE fi.id=$1 AND fi.agreement_id=$2 AND fi.kind='upload' AND fi.visibility IN ('party_b_visible','party_b_required')`,[Number(req.params.itemId),submission.agreement_id]);
      if(!item.rowCount){fs.unlink(req.file.path,()=>{});return res.status(404).json({error:'That upload requirement is not available on this agreement.'});}
      const bytes=fs.readFileSync(req.file.path);fs.unlink(req.file.path,()=>{});const ext=req.file.mimetype==='application/pdf'?'pdf':(req.file.mimetype==='image/jpeg'?'jpg':req.file.mimetype.split('/')[1]);
      const url=await uploads.uploadPrivateBuffer(bytes,`agreement-support-${submission.id}-${item.rows[0].id}-${G.randomToken(8)}.${ext}`,req.file.mimetype);
      await pool.query(`INSERT INTO agreement_submission_items(submission_id,form_item_id,upload_url,submitted_by_user_id) VALUES($1,$2,$3,$4) ON CONFLICT(submission_id,form_item_id) DO UPDATE SET upload_url=EXCLUDED.upload_url,submitted_by_user_id=EXCLUDED.submitted_by_user_id,updated_at=now()`,[submission.id,item.rows[0].id,url,req.user&&req.user.id]);
      await G.audit({agreementId:submission.agreement_id,submissionId:submission.id,action:'party_b_required_file_uploaded',details:{partyId:access.party&&access.party.id,itemId:item.rows[0].id,mimeType:req.file.mimetype},req});
      return res.json({uploaded:true,itemId:item.rows[0].id,filename:req.file.originalname});
    }catch(uploadErr){if(req.file&&req.file.path)fs.unlink(req.file.path,()=>{});return next(uploadErr);}
  });
});

module.exports = router;
