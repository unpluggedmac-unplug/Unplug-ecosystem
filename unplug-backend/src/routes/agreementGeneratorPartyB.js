const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { publicSubmitLimiter } = require('../middleware/rateLimit');
const { sendEmail } = require('../utils/email');
const G = require('../utils/agreementGenerator');
const S = require('../utils/agreementGeneratorService');

const router = express.Router();

function signerIdentity(access) {
  const p=access.party,s=access.submission;
  return p ? {
    partyId:p.id, role:p.role, partyType:p.party_type, legalName:p.legal_name, email:p.email,
    mobile:p.mobile, capacity:p.capacity, required:p.required, signed:!!p.signed_at, verified:!!p.verified_at,
  } : {
    partyId:null, role:'primary', partyType:s.party_b_type, legalName:s.signer_name, email:s.signer_email,
    mobile:null, capacity:s.business_signatory_capacity, required:true, signed:!!s.party_b_signed_at, verified:!!s.verified_at,
  };
}

async function activeAccess(req, res, next, options={}) {
  try {
    const access=await S.resolveSignerAccess(req.params.token);
    if(!access)return res.status(404).json({error:'This private agreement link is not valid.'});
    S.assertSignerAccess(access,req,options);
    req.signerAccess=access;return next();
  } catch(err) { return res.status(err.statusCode||500).json({error:err.message}); }
}

async function savePartyContact(client, access, draft, req) {
  if(!access.party)return;
  const p=access.party;
  const legalName=G.trim(req.body.signerName===undefined?p.legal_name:req.body.signerName,240);
  const email=G.trim(req.body.signerEmail===undefined?p.email:req.body.signerEmail,255);
  const mobile=G.trim(req.body.mobile===undefined?p.mobile:req.body.mobile,80);
  const capacity=G.trim(req.body.capacity===undefined?p.capacity:req.body.capacity,180);
  await client.query(`UPDATE agreement_submission_parties SET legal_name=$3,email=$4,mobile=$5,capacity=$6 WHERE id=$1 AND submission_id=$2`,[p.id,access.submission.id,legalName,email,mobile,capacity]);
  access.party={...p,legal_name:legalName,email,mobile,capacity};
  if(p.role==='primary')await client.query(`UPDATE agreement_submissions SET signer_name=COALESCE($2,signer_name),signer_email=COALESCE($3,signer_email),business_signatory_capacity=COALESCE($4,business_signatory_capacity) WHERE id=$1`,[access.submission.id,legalName,email,capacity]);
  draft.signerName=legalName;draft.signerEmail=email;draft.mobile=mobile;draft.capacity=capacity;
}

router.get('/generator/access/:token', async(req,res,next)=>{
  try{
    const access=await S.resolveSignerAccess(req.params.token);if(!access)return res.status(404).json({error:'This private agreement link is not valid.'});
    try{S.assertSignerAccess(access,req,{allowLocked:true});}catch(err){if(err.statusCode!==409)return res.status(err.statusCode||403).json({error:err.message});}
    const s=access.submission,snapshot=await S.snapshotForSubmission(s);if(!snapshot)return res.status(404).json({error:'Agreement definition unavailable.'});
    const draft=S.asObject(s.draft_data),identity=signerIdentity(access),partyBType=access.party?access.party.party_type:(s.party_b_type||draft.partyBType),contentLocked=await S.hasAnySignature(s.id);
    const values=contentLocked?S.asObject(s.answers):S.asObject(draft.answers),def=G.publicDefinitionFromSnapshot(snapshot,partyBType,values),delivery=S.asObject(s.delivery_config);
    const pending=await pool.query(`SELECT id,role,legal_name,email,required,signed_at FROM agreement_submission_parties WHERE submission_id=$1 AND party_side='party_b' ORDER BY sign_order,id`,[s.id]);
    res.set('Cache-Control','no-store');
    res.json({agreement:{id:s.id,reference:s.reference,status:s.workflow_status,locked:!!s.locked_at,contentLocked,verified:identity.verified,partyASigned:!!s.party_a_signed_at,partyBSigned:!!s.party_b_signed_at,...def},signer:identity,draft:{...draft,answers:values},signers:pending.rows.map(x=>({id:x.id,role:x.role,legalName:x.legal_name,email:x.email,required:x.required,signed:!!x.signed_at})),delivery:{allowDownload:delivery.allow_download!==false,emailPartyB:!!delivery.email_party_b,manualDownloadEmail:!!delivery.manual_download_email}});
  }catch(err){next(err);}
});

router.patch('/generator/access/:token/draft', publicSubmitLimiter, (req,res,next)=>activeAccess(req,res,next), async(req,res,next)=>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');const access=await S.resolveSignerAccess(req.params.token,client);S.assertSignerAccess(access,req);
    const s=access.submission;if(await S.hasAnySignature(s.id,client))throw Object.assign(new Error('Agreement content is frozen because a signer has already signed. You may review and sign, but the agreement details can no longer be changed.'),{statusCode:423});
    const snapshot=await S.snapshotForSubmission(s,client);if(!snapshot)throw Object.assign(new Error('Agreement definition unavailable.'),{statusCode:404});
    let partyBType=access.party?access.party.party_type:(req.body.partyBType||s.party_b_type||null);const fixed=snapshot.form&&snapshot.form.signer_type;if(['individual','business'].includes(fixed))partyBType=fixed;if(!G.PARTY_B_TYPES.includes(partyBType))throw Object.assign(new Error('Choose whether Party B is an Individual or Business.'),{statusCode:400});
    const prior=S.asObject(s.draft_data),draft={...prior,...S.asObject(req.body),partyBType,answers:{...S.asObject(prior.answers),...S.asObject(req.body.answers)}};
    await savePartyContact(client,access,draft,req);
    const from=s.workflow_status,to=['draft','sent'].includes(from)?'in_progress':from;
    await client.query(`UPDATE agreement_submissions SET draft_data=$2,party_b_type=COALESCE(party_b_type,$3),last_saved_at=now(),workflow_status=$4,user_id=COALESCE(user_id,$5),signer_name=COALESCE($6,signer_name),signer_email=COALESCE($7,signer_email) WHERE id=$1`,[s.id,JSON.stringify(draft),partyBType,to,req.user&&req.user.id,G.trim(req.body.signerName,200),G.trim(req.body.signerEmail,255)]);
    if(Array.isArray(req.body.items))for(const item of req.body.items.slice(0,100)){const formItem=(snapshot.items||[]).find(x=>Number(x.id)===Number(item.id));if(!formItem||formItem.visibility==='internal_admin'||formItem.kind!=='note')continue;await client.query(`INSERT INTO agreement_submission_items(submission_id,form_item_id,note_text,submitted_by_user_id) VALUES($1,$2,$3,$4) ON CONFLICT(submission_id,form_item_id) DO UPDATE SET note_text=EXCLUDED.note_text,submitted_by_user_id=EXCLUDED.submitted_by_user_id,updated_at=now()`,[s.id,formItem.id,G.trim(item.noteText,10000),req.user&&req.user.id]);}
    await G.audit({agreementId:s.agreement_id,submissionId:s.id,action:'party_b_draft_saved',fromStatus:from,toStatus:to,details:{partyId:access.party&&access.party.id},req,client});await client.query('COMMIT');res.json({saved:true,status:to,lastSavedAt:new Date().toISOString()});
  }catch(err){await client.query('ROLLBACK').catch(()=>{});if(err.statusCode)return res.status(err.statusCode).json({error:err.message});next(err);}finally{client.release();}
});

router.post('/generator/access/:token/verify/request', publicSubmitLimiter, (req,res,next)=>activeAccess(req,res,next), async(req,res,next)=>{
  try{
    const access=req.signerAccess,s=access.submission,p=access.party,channel=req.body.channel==='mobile'?'mobile':'email',draft=S.asObject(s.draft_data);
    let destination=G.trim(req.body.destination||(channel==='email'?(p&&p.email||draft.signerEmail||s.signer_email):(p&&p.mobile||draft.mobile)),255);
    if(channel==='email'&&!G.validEmail(destination))return res.status(400).json({error:'A valid email address is required.'});if(channel==='mobile'&&!destination)return res.status(400).json({error:'A mobile number is required.'});
    if(p&&channel==='email'&&p.email&&String(p.email).toLowerCase()!==String(destination).toLowerCase())return res.status(400).json({error:'Verify using the email address assigned to this signer.'});
    if(p&&channel==='mobile'&&p.mobile&&String(p.mobile).replace(/\D/g,'')!==String(destination).replace(/\D/g,''))return res.status(400).json({error:'Verify using the mobile number assigned to this signer.'});
    const code=String(Math.floor(100000+Math.random()*900000)),partyId=p?p.id:null;
    await pool.query(`UPDATE agreement_verification_codes SET consumed_at=COALESCE(consumed_at,now()) WHERE submission_id=$1 AND channel=$2 AND consumed_at IS NULL AND (($3::bigint IS NULL AND party_id IS NULL) OR party_id=$3)`,[s.id,channel,partyId]);
    await pool.query(`INSERT INTO agreement_verification_codes(submission_id,party_id,channel,destination,code_hash,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')`,[s.id,partyId,channel,destination,G.codeHash(`${s.id}:${partyId||0}`,code)]);
    if(channel==='email')await sendEmail({to:destination,subject:`Unplug agreement verification — ${s.reference}`,text:`Your one-time verification code is ${code}. It expires in 10 minutes. If you did not request this code, ignore this email.`});else{const webhook=process.env.AGREEMENT_SMS_WEBHOOK_URL;if(!webhook)return res.status(503).json({error:'Mobile-code delivery is not configured. Please verify by email instead.'});const response=await fetch(webhook,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to:destination,message:`Unplug verification code: ${code}. Expires in 10 minutes.`})});if(!response.ok)throw Object.assign(new Error('Mobile-code delivery failed. Please use email verification.'),{statusCode:502});}
    await G.audit({agreementId:s.agreement_id,submissionId:s.id,action:'verification_code_requested',details:{partyId,channel},req});res.json({sent:true,channel,...(process.env.NODE_ENV==='test'?{testCode:code}:{})});
  }catch(err){if(err.statusCode)return res.status(err.statusCode).json({error:err.message});next(err);}
});

router.post('/generator/access/:token/verify/confirm', publicSubmitLimiter, (req,res,next)=>activeAccess(req,res,next), async(req,res,next)=>{
  try{
    const access=req.signerAccess,s=access.submission,p=access.party,partyId=p?p.id:null,channel=req.body.channel==='mobile'?'mobile':'email';
    const r=await pool.query(`SELECT * FROM agreement_verification_codes WHERE submission_id=$1 AND channel=$2 AND consumed_at IS NULL AND expires_at>now() AND (($3::bigint IS NULL AND party_id IS NULL) OR party_id=$3) ORDER BY created_at DESC LIMIT 1`,[s.id,channel,partyId]);if(!r.rowCount)return res.status(400).json({error:'No active verification code was found. Request a new code.'});const row=r.rows[0];if(row.attempts>=5)return res.status(429).json({error:'Too many incorrect attempts. Request a new code.'});
    if(G.codeHash(`${s.id}:${partyId||0}`,String(req.body.code||''))!==row.code_hash){await pool.query('UPDATE agreement_verification_codes SET attempts=attempts+1 WHERE id=$1',[row.id]);return res.status(400).json({error:'That verification code is not correct.'});}
    await pool.query('UPDATE agreement_verification_codes SET consumed_at=now() WHERE id=$1',[row.id]);if(p)await pool.query('UPDATE agreement_submission_parties SET verified_at=now(),verification_channel=$2 WHERE id=$1',[p.id,channel]);else await pool.query('UPDATE agreement_submissions SET verified_at=now(),verification_channel=$2 WHERE id=$1',[s.id,channel]);
    await G.audit({agreementId:s.agreement_id,submissionId:s.id,action:'party_b_verified',details:{partyId,channel},req});res.json({verified:true});
  }catch(err){next(err);}
});

router.post('/generator/access/:token/submit', publicSubmitLimiter, (req,res,next)=>activeAccess(req,res,next), async(req,res,next)=>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');const access=await S.resolveSignerAccess(req.params.token,client);S.assertSignerAccess(access,req);const s=access.submission,p=access.party;
    const verified=p?!!p.verified_at:!!s.verified_at;if(!verified)throw Object.assign(new Error('Verify your email or mobile number before signing.'),{statusCode:400});
    if(s.signing_order==='party_a_first'&&!s.party_a_signed_at)throw Object.assign(new Error('Party A must sign before Party B can sign this agreement.'),{statusCode:409});
    if(Number(s.amount_at_signing)>0&&s.payment_mode_at_signing==='before_sign'&&s.payment_status!=='confirmed')throw Object.assign(new Error('Payment must be confirmed before this agreement can be signed.'),{statusCode:402});
    const snapshot=await S.snapshotForSubmission(s,client);if(!snapshot)throw Object.assign(new Error('Agreement definition unavailable.'),{statusCode:404});const contentLocked=await S.hasAnySignature(s.id,client);
    const draft={...S.asObject(s.draft_data),...(!contentLocked?S.asObject(req.body):{})},partyBType=p?p.party_type:(req.body.partyBType||s.party_b_type||draft.partyBType),fixed=snapshot.form&&snapshot.form.signer_type;
    if(['individual','business'].includes(fixed)&&partyBType!==fixed)throw Object.assign(new Error(`This agreement requires Party B to be ${fixed}.`),{statusCode:400});if(!G.PARTY_B_TYPES.includes(partyBType))throw Object.assign(new Error('Choose whether Party B is an Individual or Business.'),{statusCode:400});
    const declarations=S.asObject(req.body.declarationsAccepted||draft.declarationsAccepted);
    const answerSource=contentLocked?S.asObject(s.answers):{...S.asObject(draft.answers),...S.asObject(req.body.answers)};
    const answers=G.validateAnswers(snapshot,partyBType,answerSource,declarations);
    await S.validateRequiredItems(snapshot,answers,s.id,client);
    const signerName=G.trim(req.body.signerName||(p&&p.legal_name)||draft.signerName||s.signer_name,200),signerEmail=G.trim(req.body.signerEmail||(p&&p.email)||draft.signerEmail||s.signer_email,255);if(!signerName)throw Object.assign(new Error('Signer name is required.'),{statusCode:400});if(signerEmail&&!G.validEmail(signerEmail))throw Object.assign(new Error('Signer email is not valid.'),{statusCode:400});
    const signatureType=G.SIGNATURE_TYPES.includes(req.body.signatureType)?req.body.signatureType:null;if(!signatureType)throw Object.assign(new Error('Choose typed, drawn or uploaded signature.'),{statusCode:400});let signatureText=null,signatureUrl=null;if(signatureType==='typed'){signatureText=G.trim(req.body.signatureText||signerName,500);if(!signatureText)throw Object.assign(new Error('Type your signature.'),{statusCode:400});}else signatureUrl=await G.storePrivateSignature(req.body.signatureDataUrl,'party-b');
    let party=p;
    if(!party){let found=await client.query(`SELECT * FROM agreement_submission_parties WHERE submission_id=$1 AND party_side='party_b' AND role='primary' ORDER BY id LIMIT 1`,[s.id]);if(found.rowCount)party=found.rows[0];else{const made=await client.query(`INSERT INTO agreement_submission_parties(submission_id,party_side,party_type,role,legal_name,email,mobile,capacity,sign_order,required,verified_at,verification_channel) VALUES($1,'party_b',$2,'primary',$3,$4,$5,$6,0,true,$7,$8) RETURNING *`,[s.id,partyBType,signerName,signerEmail,G.trim(draft.mobile,80),G.trim(req.body.capacity||draft.capacity,180),s.verified_at,s.verification_channel]);party=made.rows[0];}}
    if(await client.query('SELECT 1 FROM agreement_signatures WHERE party_id=$1',[party.id]).then(r=>r.rowCount>0))throw Object.assign(new Error('This signer has already signed the agreement.'),{statusCode:409});
    await client.query(`UPDATE agreement_submission_parties SET legal_name=COALESCE($2,legal_name),email=COALESCE($3,email),mobile=COALESCE($4,mobile),capacity=COALESCE($5,capacity),signed_at=now() WHERE id=$1`,[party.id,signerName,signerEmail,G.trim(draft.mobile,80),G.trim(req.body.capacity||draft.capacity,180)]);
    await client.query(`INSERT INTO agreement_signatures(submission_id,party_id,party_side,signature_type,signature_text,signature_url,declaration_accepted,ip,user_agent,metadata) VALUES($1,$2,'party_b',$3,$4,$5,true,$6,$7,$8)`,[s.id,party.id,signatureType,signatureText,signatureUrl,req.ip,G.trim(req.get('user-agent'),1000),JSON.stringify({declarations,role:party.role,capacity:req.body.capacity||party.capacity||draft.capacity||null})]);
    const allB=await S.requiredPartyBSignaturesComplete(s.id,client),workflow=allB?'submitted':'in_progress';
    await client.query(`UPDATE agreement_submissions SET answers=$2,draft_data=$3,declarations_accepted=$4,party_b_type=COALESCE(party_b_type,$5),signer_name=COALESCE(signer_name,$6),signer_email=COALESCE(signer_email,$7),${allB?"party_b_signed_at=now(),submitted_at=now(),signed_at=now(),workflow_status='submitted',status='complete',locked_at=now()":"workflow_status='in_progress'"},definition_at_signing=$8 WHERE id=$1`,[s.id,JSON.stringify(answers),JSON.stringify({...draft,answers}),JSON.stringify(declarations),partyBType,signerName,signerEmail,JSON.stringify(snapshot)]);
    await G.audit({agreementId:s.agreement_id,submissionId:s.id,action:'party_b_signer_signed',fromStatus:s.workflow_status,toStatus:workflow,details:{partyId:party.id,role:party.role,signatureType,allRequiredPartyBSigned:allB},req,client});await client.query('COMMIT');
    const updated=await S.loadSubmission(s.id),delivery=S.asObject(updated.delivery_config);if(allB){const pdf=await S.renderPdfForSubmission(updated);await S.notifySubmission(updated,snapshot,pdf,updated.signer_email||signerEmail).catch(async err=>{console.error('[agreement generator notification]',err);await G.audit({agreementId:s.agreement_id,submissionId:s.id,action:'notification_failed',details:{message:err.message},req}).catch(()=>{});});}
    res.json({signed:true,allRequiredPartyBSigned:allB,reference:updated.reference,status:workflow,downloadAllowed:allB&&delivery.allow_download!==false,downloadUrl:allB&&delivery.allow_download!==false?`/agreement-forms/generator/access/${encodeURIComponent(req.params.token)}/pdf`:null});
  }catch(err){await client.query('ROLLBACK').catch(()=>{});if(err.statusCode)return res.status(err.statusCode).json({error:err.message});next(err);}finally{client.release();}
});

router.get('/generator/access/:token/pdf', async(req,res,next)=>{
  try{
    const access=await S.resolveSignerAccess(req.params.token);if(!access)return res.status(404).json({error:'This private agreement link is not valid.'});const s=access.submission;
    if(!s.party_b_signed_at||!s.locked_at)return res.status(409).json({error:'Every required Party B signer must sign before the completed PDF can be downloaded.'});const delivery=S.asObject(s.delivery_config);if(delivery.allow_download===false)return res.status(403).json({error:'Download is disabled for this agreement.'});const pdf=await S.renderPdfForSubmission(s);if(!pdf)return res.status(404).json({error:'Agreement definition unavailable.'});res.type('application/pdf').attachment(`${s.reference}.pdf`).send(pdf);
  }catch(err){next(err);}
});

router.get('/generator/member/agreements', requireAuth, async(req,res,next)=>{
  try{
    const r=await pool.query(`SELECT DISTINCT s.id,s.reference,s.workflow_status,s.agreement_version,s.started_at,s.submitted_at,s.signed_at,a.title,a.slug
      FROM agreement_submissions s JOIN agreement_forms a ON a.id=s.agreement_id
      LEFT JOIN agreement_submission_parties p ON p.submission_id=s.id AND p.party_side='party_b'
      WHERE (s.user_id=$1 OR p.member_user_id=$1) AND s.access_method IN ('member_login','both') ORDER BY s.started_at DESC`,[req.user.id]);res.json({agreements:r.rows});
  }catch(err){next(err);}
});

module.exports = router;
