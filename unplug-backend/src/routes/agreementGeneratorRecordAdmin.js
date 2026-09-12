const express = require('express');
const pool = require('../db');
const { requireRole, requireSuperAdmin } = require('../middleware/auth');
const { sendEmail } = require('../utils/email');
const G = require('../utils/agreementGenerator');
const S = require('../utils/agreementGeneratorService');

const router = express.Router();
const STATUS_TRANSITIONS = {
  draft:['sent','archived'], sent:['in_progress','archived'], in_progress:['submitted','archived'],
  submitted:['under_review','archived'], under_review:['signed','archived'], signed:['completed','archived'],
  completed:['archived'], archived:[],
};

function siteUrl() { return String(process.env.SITE_URL || 'https://www.unplugnews.com').replace(/\/$/, ''); }
function signerLink(token) { return `${siteUrl()}/unplug-agreement-generator.html?token=${encodeURIComponent(token)}`; }
function partyRole(value) { return ['primary','guardian','witness','authorised_representative','other'].includes(value) ? value : 'other'; }

async function issuePartyToken(client, partyId) {
  const token = G.randomToken(32);
  await client.query('UPDATE agreement_submission_parties SET signing_token=$2 WHERE id=$1', [partyId,token]);
  return token;
}

router.get('/generator/admin/agreements', requireRole('admin'), async(req,res,next)=>{
  try{
    const params=[],where=[];
    if(req.user.role==='staff') { params.push(req.user.id); where.push(`EXISTS(SELECT 1 FROM agreement_submission_assignments ax WHERE ax.submission_id=s.id AND ax.user_id=$${params.length})`); }
    if(req.query.status){params.push(String(req.query.status));where.push(`s.workflow_status=$${params.length}`);}
    if(req.query.q){params.push(`%${String(req.query.q).trim()}%`);where.push(`(s.reference ILIKE $${params.length} OR COALESCE(s.signer_name,'') ILIKE $${params.length} OR a.title ILIKE $${params.length})`);}
    params.push(req.user.id);const meIndex=params.length;
    const r=await pool.query(`SELECT s.id,s.reference,s.reference_original,s.workflow_status,s.agreement_version,s.party_b_type,
      s.signer_name,s.signer_email,s.started_at,s.submitted_at,s.signed_at,s.locked_at,s.superseded_by_id,
      s.party_a_signed_at,s.party_b_signed_at,a.title,a.slug,
      EXISTS(SELECT 1 FROM agreement_submission_assignments x WHERE x.submission_id=s.id AND x.user_id=$${meIndex}) assigned_to_me
      FROM agreement_submissions s JOIN agreement_forms a ON a.id=s.agreement_id
      ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY s.started_at DESC LIMIT 1000`,params);
    res.json({agreements:r.rows});
  }catch(err){next(err);}
});

router.post('/generator/admin/agreements', requireRole('admin'), async(req,res,next)=>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const formId=Number(req.body.templateId||req.body.agreementId);
    if(!Number.isInteger(formId))throw Object.assign(new Error('Choose an approved agreement template.'),{statusCode:400});
    const {form,version}=await S.approvedVersionForCreate(formId,client);
    if(!form){await client.query('ROLLBACK');return res.status(404).json({error:'Agreement template not found.'});}
    if(!version)throw Object.assign(new Error('This template has no current Approved or Published version. Approve the latest version before creating a new agreement.'),{statusCode:400});
    const snapshot=version.snapshot,snapForm=snapshot.form||form;
    let partyBType=req.body.partyBType||null;
    if(['individual','business'].includes(snapForm.signer_type))partyBType=snapForm.signer_type;
    if(partyBType&&!G.PARTY_B_TYPES.includes(partyBType))throw Object.assign(new Error('Party B must be Individual or Business.'),{statusCode:400});
    const reference=await G.nextReference(client),token=G.randomToken(32);
    const accessMethod=G.ACCESS_METHODS.includes(req.body.accessMethod)?req.body.accessMethod:(snapForm.access_method||'private_link');
    const signingOrder=G.SIGNING_ORDERS.includes(req.body.signingOrder)?req.body.signingOrder:(snapForm.signing_order||'party_b_first');
    let userId=req.body.memberUserId?Number(req.body.memberUserId):null;if(userId&&!Number.isInteger(userId))userId=null;
    if(accessMethod==='member_login'&&!userId)throw Object.assign(new Error('Member-login agreements must be assigned to a member.'),{statusCode:400});
    const paymentStatus=Number(snapForm.amount)>0&&snapForm.payment_mode!=='none'?'awaiting_payment':'not_required';
    const r=await client.query(`INSERT INTO agreement_submissions
      (agreement_id,user_id,reference,reference_original,signing_token,status,workflow_status,payment_status,agreement_version,
       template_version_id,party_b_type,access_method,signing_order,delivery_config,notification_config,title_at_signing,
       description_at_signing,rules_at_signing,terms_at_signing,post_signing_requirements_at_signing,require_witness_at_signing,
       require_company_stamp_at_signing,amount_at_signing,payment_mode_at_signing,service_scope_at_signing,service_name_at_signing,
       service_description_at_signing,service_reference_at_signing,client_name_at_signing,definition_at_signing,created_by_user_id)
      VALUES($1,$2,$3,$3,$4,'started','draft',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
      RETURNING *`,[formId,userId,reference,token,paymentStatus,version.version,version.id,partyBType,accessMethod,signingOrder,
      JSON.stringify(req.body.deliveryConfig?S.asObject(req.body.deliveryConfig):S.asObject(snapForm.delivery_config)),
      JSON.stringify(req.body.notificationConfig?S.asObject(req.body.notificationConfig):S.asObject(snapForm.notification_config)),
      snapForm.title,snapForm.description,snapForm.rules,snapForm.terms,snapForm.post_signing_requirements,!!snapForm.require_witness,
      !!snapForm.require_company_stamp,snapForm.amount,snapForm.payment_mode,snapForm.service_scope,snapForm.service_name,
      snapForm.service_description,snapForm.service_reference,snapForm.client_name,JSON.stringify(snapshot),req.user.id]);
    const submission=r.rows[0];
    const parties=[];
    if(Array.isArray(req.body.partyBSigners)){
      for(const p of req.body.partyBSigners.slice(0,20)){
        const pType=G.PARTY_B_TYPES.includes(p.partyType)?p.partyType:(partyBType||'individual');
        const pr=await client.query(`INSERT INTO agreement_submission_parties
          (submission_id,party_side,party_type,role,legal_name,display_name,email,mobile,capacity,sign_order,required,metadata,member_user_id)
          VALUES($1,'party_b',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[submission.id,pType,partyRole(p.role),G.trim(p.legalName,240),G.trim(p.displayName,240),G.trim(p.email,255),G.trim(p.mobile,80),G.trim(p.capacity,180),Number(p.signOrder)||0,p.required!==false,JSON.stringify(S.asObject(p.metadata)),Number.isInteger(Number(p.memberUserId))?Number(p.memberUserId):null]);
        const pt=pr.rows[0];pt.signing_token=await issuePartyToken(client,pt.id);parties.push(pt);
      }
    }
    if(req.user.role==='staff')await client.query(`INSERT INTO agreement_submission_assignments(submission_id,user_id,assigned_by,assignment_role) VALUES($1,$2,$2,'creator') ON CONFLICT DO NOTHING`,[submission.id,req.user.id]);
    const shortCode=await S.ensureFormShortCode(formId,client);
    await G.audit({agreementId:formId,submissionId:submission.id,action:'agreement_created',toStatus:'draft',details:{templateVersion:version.version,accessMethod,signingOrder,partyCount:parties.length},req,client});
    await client.query('COMMIT');
    res.status(201).json({agreement:submission,parties:parties.map(p=>({...p,secureLink:signerLink(p.signing_token)})),shortCode,secureLink:signerLink(token),resolver:`/a/${shortCode}`});
  }catch(err){await client.query('ROLLBACK').catch(()=>{});if(err.statusCode)return res.status(err.statusCode).json({error:err.message});next(err);}finally{client.release();}
});

router.get('/generator/admin/agreements/:id', requireRole('admin'), S.requireInstanceAccess, async(req,res,next)=>{
  try{
    const s=req.agreementSubmission;
    const [parties,items,audit,assignments,signatures]=await Promise.all([
      pool.query(`SELECT p.*,CASE WHEN p.signing_token IS NULL THEN NULL ELSE $2||'/unplug-agreement-generator.html?token='||p.signing_token END secure_link FROM agreement_submission_parties p WHERE p.submission_id=$1 ORDER BY p.party_side,p.sign_order,p.id`,[s.id,siteUrl()]),
      pool.query(`SELECT si.*,fi.label,fi.kind,fi.visibility FROM agreement_submission_items si LEFT JOIN agreement_form_items fi ON fi.id=si.form_item_id WHERE si.submission_id=$1 ORDER BY si.id`,[s.id]),
      pool.query('SELECT * FROM agreement_audit_log WHERE submission_id=$1 ORDER BY created_at DESC,id DESC',[s.id]),
      pool.query(`SELECT x.*,u.full_name,u.email FROM agreement_submission_assignments x JOIN users u ON u.id=x.user_id WHERE x.submission_id=$1 ORDER BY x.created_at`,[s.id]),
      pool.query(`SELECT s.id,s.party_id,s.party_side,s.signature_type,s.signature_text,s.signature_url,s.signed_at,p.legal_name,p.role,p.capacity FROM agreement_signatures s LEFT JOIN agreement_submission_parties p ON p.id=s.party_id WHERE s.submission_id=$1 ORDER BY s.signed_at,s.id`,[s.id])]);
    res.json({agreement:s,parties:parties.rows,items:items.rows,audit:audit.rows,assignments:assignments.rows,signatures:signatures.rows});
  }catch(err){next(err);}
});

router.post('/generator/admin/agreements/:id/assign', requireSuperAdmin, async(req,res,next)=>{
  try{
    const s=await S.loadSubmission(req.params.id);if(!s)return res.status(404).json({error:'Agreement record not found.'});
    const userId=Number(req.body.userId);if(!Number.isInteger(userId))return res.status(400).json({error:'Valid staff userId required.'});
    const u=await pool.query("SELECT id,role FROM users WHERE id=$1 AND role IN ('staff','admin')",[userId]);if(!u.rowCount)return res.status(400).json({error:'Assignment must be to an admin or staff account.'});
    await pool.query(`INSERT INTO agreement_submission_assignments(submission_id,user_id,assigned_by,assignment_role) VALUES($1,$2,$3,$4) ON CONFLICT(submission_id,user_id) DO UPDATE SET assigned_by=EXCLUDED.assigned_by,assignment_role=EXCLUDED.assignment_role,created_at=now()`,[s.id,userId,req.user.id,G.trim(req.body.assignmentRole,80)]);
    await G.audit({agreementId:s.agreement_id,submissionId:s.id,action:'agreement_assigned',details:{userId},req});res.json({assigned:true});
  }catch(err){next(err);}
});

router.post('/generator/admin/agreements/:id/parties', requireRole('admin'), S.requireInstanceAccess, async(req,res,next)=>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');const s=await S.loadSubmission(req.params.id,client);if(!s){await client.query('ROLLBACK');return res.status(404).json({error:'Agreement record not found.'});}
    if(s.locked_at||['signed','completed','archived'].includes(s.workflow_status))throw Object.assign(new Error('Signed, completed or archived agreements cannot have signers changed.'),{statusCode:409});
    const type=G.PARTY_B_TYPES.includes(req.body.partyType)?req.body.partyType:(s.party_b_type||'individual');
    const pr=await client.query(`INSERT INTO agreement_submission_parties(submission_id,party_side,party_type,role,legal_name,display_name,email,mobile,capacity,sign_order,required,metadata,member_user_id)
      VALUES($1,'party_b',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[s.id,type,partyRole(req.body.role),G.trim(req.body.legalName,240),G.trim(req.body.displayName,240),G.trim(req.body.email,255),G.trim(req.body.mobile,80),G.trim(req.body.capacity,180),Number(req.body.signOrder)||0,req.body.required!==false,JSON.stringify(S.asObject(req.body.metadata)),Number.isInteger(Number(req.body.memberUserId))?Number(req.body.memberUserId):null]);
    const p=pr.rows[0],token=await issuePartyToken(client,p.id);
    await G.audit({agreementId:s.agreement_id,submissionId:s.id,action:'party_b_signer_added',details:{partyId:p.id,role:p.role,required:p.required},req,client});await client.query('COMMIT');res.status(201).json({party:{...p,signing_token:token},secureLink:signerLink(token)});
  }catch(err){await client.query('ROLLBACK').catch(()=>{});if(err.statusCode)return res.status(err.statusCode).json({error:err.message});next(err);}finally{client.release();}
});

router.patch('/generator/admin/agreements/:id/parties/:partyId', requireRole('admin'), S.requireInstanceAccess, async(req,res,next)=>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');const s=await S.loadSubmission(req.params.id,client);if(s.locked_at)throw Object.assign(new Error('This agreement is locked.'),{statusCode:423});
    const existing=await client.query(`SELECT p.*,EXISTS(SELECT 1 FROM agreement_signatures sg WHERE sg.party_id=p.id) signed FROM agreement_submission_parties p WHERE p.id=$1 AND p.submission_id=$2 AND p.party_side='party_b'`,[req.params.partyId,s.id]);if(!existing.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Signer not found.'});}if(existing.rows[0].signed)throw Object.assign(new Error('A signer who has already signed cannot be changed.'),{statusCode:409});const p=existing.rows[0];
    const type=req.body.partyType===undefined?p.party_type:(G.PARTY_B_TYPES.includes(req.body.partyType)?req.body.partyType:null);if(!type)throw Object.assign(new Error('Invalid Party B type.'),{statusCode:400});
    const r=await client.query(`UPDATE agreement_submission_parties SET party_type=$3,role=$4,legal_name=$5,display_name=$6,email=$7,mobile=$8,capacity=$9,sign_order=$10,required=$11,member_user_id=$12 WHERE id=$1 AND submission_id=$2 RETURNING *`,[p.id,s.id,type,req.body.role===undefined?p.role:partyRole(req.body.role),req.body.legalName===undefined?p.legal_name:G.trim(req.body.legalName,240),req.body.displayName===undefined?p.display_name:G.trim(req.body.displayName,240),req.body.email===undefined?p.email:G.trim(req.body.email,255),req.body.mobile===undefined?p.mobile:G.trim(req.body.mobile,80),req.body.capacity===undefined?p.capacity:G.trim(req.body.capacity,180),req.body.signOrder===undefined?p.sign_order:Number(req.body.signOrder)||0,req.body.required===undefined?p.required:!!req.body.required,req.body.memberUserId===undefined?p.member_user_id:(Number.isInteger(Number(req.body.memberUserId))?Number(req.body.memberUserId):null)]);
    await G.audit({agreementId:s.agreement_id,submissionId:s.id,action:'party_b_signer_updated',details:{partyId:p.id},req,client});await client.query('COMMIT');res.json({party:r.rows[0]});
  }catch(err){await client.query('ROLLBACK').catch(()=>{});if(err.statusCode)return res.status(err.statusCode).json({error:err.message});next(err);}finally{client.release();}
});

router.delete('/generator/admin/agreements/:id/parties/:partyId', requireRole('admin'), S.requireInstanceAccess, async(req,res,next)=>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');const s=await S.loadSubmission(req.params.id,client);if(s.locked_at)throw Object.assign(new Error('This agreement is locked.'),{statusCode:423});
    const signed=await client.query('SELECT 1 FROM agreement_signatures WHERE party_id=$1',[req.params.partyId]);if(signed.rowCount)throw Object.assign(new Error('A signer who has already signed cannot be removed.'),{statusCode:409});
    const r=await client.query(`DELETE FROM agreement_submission_parties WHERE id=$1 AND submission_id=$2 AND party_side='party_b' RETURNING id,role,legal_name`,[req.params.partyId,s.id]);if(!r.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Signer not found.'});}
    await G.audit({agreementId:s.agreement_id,submissionId:s.id,action:'party_b_signer_removed',details:r.rows[0],req,client});await client.query('COMMIT');res.json({deleted:true});
  }catch(err){await client.query('ROLLBACK').catch(()=>{});if(err.statusCode)return res.status(err.statusCode).json({error:err.message});next(err);}finally{client.release();}
});

router.post('/generator/admin/agreements/:id/send', requireRole('admin'), S.requireInstanceAccess, async(req,res,next)=>{
  try{
    const s=req.agreementSubmission;if(!['draft','sent','in_progress'].includes(s.workflow_status))return res.status(409).json({error:'This agreement can no longer be sent for editing.'});
    if(s.signing_order==='party_a_first'&&!s.party_a_signed_at)return res.status(409).json({error:'Party A must sign before this agreement can be sent.'});
    let recipients=[];
    if(req.body.partyId){const r=await pool.query(`SELECT * FROM agreement_submission_parties WHERE id=$1 AND submission_id=$2 AND party_side='party_b'`,[Number(req.body.partyId),s.id]);if(!r.rowCount)return res.status(404).json({error:'Signer not found.'});let p=r.rows[0];if(!p.signing_token){const token=G.randomToken(32);await pool.query('UPDATE agreement_submission_parties SET signing_token=$2 WHERE id=$1',[p.id,token]);p.signing_token=token;}recipients=[{email:p.email,name:p.legal_name,token:p.signing_token,partyId:p.id}];}
    else {const r=await pool.query(`SELECT * FROM agreement_submission_parties WHERE submission_id=$1 AND party_side='party_b' AND required=true AND signed_at IS NULL ORDER BY sign_order,id`,[s.id]);recipients=r.rows.map(p=>({email:p.email,name:p.legal_name,token:p.signing_token,partyId:p.id}));if(!recipients.length){recipients=[{email:G.trim(req.body.email||s.signer_email,255),name:s.signer_name,token:s.signing_token,partyId:null}];}}
    let sent=0;for(const recipient of recipients){if(!G.validEmail(recipient.email))continue;let token=recipient.token;if(!token&&recipient.partyId){token=G.randomToken(32);await pool.query('UPDATE agreement_submission_parties SET signing_token=$2 WHERE id=$1',[recipient.partyId,token]);}await sendEmail({to:recipient.email,subject:`Agreement for review — ${s.reference}`,text:`${recipient.name?`Hello ${recipient.name},\n\n`:''}Please review and complete your Unplug agreement.\n\n${signerLink(token||s.signing_token)}\n\nReference: ${s.reference}`});sent++;}
    if(!sent)return res.status(400).json({error:'No valid Party B email address is available to send.'});const from=s.workflow_status;await pool.query(`UPDATE agreement_submissions SET workflow_status='sent',signer_email=COALESCE(signer_email,$2) WHERE id=$1`,[s.id,G.trim(req.body.email,255)]);await G.audit({agreementId:s.agreement_id,submissionId:s.id,action:'agreement_sent',fromStatus:from,toStatus:'sent',details:{recipientCount:sent},req});res.json({sent:true,recipientCount:sent});
  }catch(err){next(err);}
});

router.post('/generator/admin/agreements/:id/remind', requireRole('admin'), S.requireInstanceAccess, async(req,res,next)=>{
  try{
    const s=req.agreementSubmission;if(['signed','completed','archived'].includes(s.workflow_status))return res.status(409).json({error:'This agreement no longer needs a signing reminder.'});
    const r=await pool.query(`SELECT * FROM agreement_submission_parties WHERE submission_id=$1 AND party_side='party_b' AND required=true AND signed_at IS NULL ORDER BY sign_order,id`,[s.id]);let sent=0;
    for(let p of r.rows){if(!G.validEmail(p.email))continue;if(!p.signing_token){p.signing_token=G.randomToken(32);await pool.query('UPDATE agreement_submission_parties SET signing_token=$2 WHERE id=$1',[p.id,p.signing_token]);}await sendEmail({to:p.email,subject:`Reminder: agreement ${s.reference}`,text:`Please complete your Unplug agreement.\n\n${signerLink(p.signing_token)}\n\nReference: ${s.reference}`});sent++;}
    if(!sent&&G.validEmail(s.signer_email)){await sendEmail({to:s.signer_email,subject:`Reminder: agreement ${s.reference}`,text:`Please complete your Unplug agreement.\n\n${signerLink(s.signing_token)}\n\nReference: ${s.reference}`});sent=1;}
    if(!sent)return res.status(400).json({error:'No unsigned Party B signer has a valid email address.'});await G.audit({agreementId:s.agreement_id,submissionId:s.id,action:'agreement_reminder_sent',details:{recipientCount:sent},req});res.json({sent:true,recipientCount:sent});
  }catch(err){next(err);}
});

router.post('/generator/admin/agreements/:id/reference-override', requireSuperAdmin, async(req,res,next)=>{
  try{const s=await S.loadSubmission(req.params.id);if(!s)return res.status(404).json({error:'Agreement record not found.'});const reference=G.trim(req.body.reference,80),reason=G.trim(req.body.reason,5000);if(!reference||!reason)return res.status(400).json({error:'New reference and audit reason are required.'});const r=await pool.query(`UPDATE agreement_submissions SET reference=$2,reference_original=COALESCE(reference_original,reference),reference_override_reason=$3 WHERE id=$1 RETURNING *`,[s.id,reference,reason]);await G.audit({agreementId:s.agreement_id,submissionId:s.id,action:'reference_overridden',reason,details:{original:s.reference,newReference:reference},req});res.json({agreement:r.rows[0]});}catch(err){if(err.code==='23505')return res.status(409).json({error:'That agreement reference is already in use.'});next(err);}
});

router.post('/generator/admin/agreements/:id/status', requireRole('admin'), S.requireInstanceAccess, async(req,res,next)=>{
  try{
    const s=req.agreementSubmission,to=String(req.body.status||'');if(!G.WORKFLOW_STATUSES.includes(to))return res.status(400).json({error:'Invalid agreement status.'});
    if(!(STATUS_TRANSITIONS[s.workflow_status]||[]).includes(to))return res.status(409).json({error:`Status cannot move from ${s.workflow_status} to ${to}. Use Reopen or Restore when appropriate.`});
    if(to==='signed'){const bComplete=await S.requiredPartyBSignaturesComplete(s.id);if(!s.party_a_signed_at||!bComplete)return res.status(409).json({error:'Party A and every required Party B signer must sign before status can become Signed.'});}
    await pool.query('UPDATE agreement_submissions SET workflow_status=$2 WHERE id=$1',[s.id,to]);await G.audit({agreementId:s.agreement_id,submissionId:s.id,action:'workflow_status_changed',fromStatus:s.workflow_status,toStatus:to,reason:req.body.reason,req});res.json({status:to});
  }catch(err){next(err);}
});

router.post('/generator/admin/agreements/:id/archive', requireRole('admin'), S.requireInstanceAccess, async(req,res,next)=>{try{const s=req.agreementSubmission;if(s.workflow_status==='archived')return res.json({archived:true});await pool.query("UPDATE agreement_submissions SET workflow_status='archived' WHERE id=$1",[s.id]);await G.audit({agreementId:s.agreement_id,submissionId:s.id,action:'agreement_archived',fromStatus:s.workflow_status,toStatus:'archived',reason:req.body.reason,details:{archivedFrom:s.workflow_status},req});res.json({archived:true});}catch(err){next(err);}});
router.post('/generator/admin/agreements/:id/restore', requireRole('admin'), S.requireInstanceAccess, async(req,res,next)=>{try{const s=req.agreementSubmission;if(s.workflow_status!=='archived')return res.status(409).json({error:'Only archived agreements can be restored.'});const bComplete=await S.requiredPartyBSignaturesComplete(s.id),to=s.party_a_signed_at&&bComplete?'completed':(s.party_b_signed_at?'submitted':'draft');await pool.query('UPDATE agreement_submissions SET workflow_status=$2 WHERE id=$1',[s.id,to]);await G.audit({agreementId:s.agreement_id,submissionId:s.id,action:'agreement_restored',fromStatus:'archived',toStatus:to,reason:req.body.reason,req});res.json({restored:true,status:to});}catch(err){next(err);}});

router.post('/generator/admin/agreements/:id/reopen', requireRole('admin'), S.requireInstanceAccess, async(req,res,next)=>{
  const client=await pool.connect();
  try{
    const reason=G.trim(req.body.reason,5000);if(!reason)throw Object.assign(new Error('A reopen reason is required for the audit history.'),{statusCode:400});
    await client.query('BEGIN');const s=await S.loadSubmission(req.params.id,client);if(!s){await client.query('ROLLBACK');return res.status(404).json({error:'Agreement record not found.'});}
    const bComplete=await S.requiredPartyBSignaturesComplete(s.id,client),fullySigned=!!s.party_a_signed_at&&bComplete;
    if(fullySigned||['signed','completed'].includes(s.workflow_status)){
      const ref=await G.nextReference(client),token=G.randomToken(32);
      const r=await client.query(`INSERT INTO agreement_submissions
        (agreement_id,user_id,reference,reference_original,signing_token,status,workflow_status,payment_status,agreement_version,template_version_id,party_b_type,access_method,signing_order,delivery_config,notification_config,draft_data,title_at_signing,description_at_signing,rules_at_signing,terms_at_signing,post_signing_requirements_at_signing,require_witness_at_signing,require_company_stamp_at_signing,amount_at_signing,payment_mode_at_signing,service_scope_at_signing,service_name_at_signing,service_description_at_signing,service_reference_at_signing,client_name_at_signing,definition_at_signing,created_by_user_id)
        SELECT agreement_id,user_id,$2,$2,$3,'started','in_progress',payment_status,agreement_version,template_version_id,party_b_type,access_method,signing_order,delivery_config,notification_config,answers,title_at_signing,description_at_signing,rules_at_signing,terms_at_signing,post_signing_requirements_at_signing,require_witness_at_signing,require_company_stamp_at_signing,amount_at_signing,payment_mode_at_signing,service_scope_at_signing,service_name_at_signing,service_description_at_signing,service_reference_at_signing,client_name_at_signing,definition_at_signing,$4 FROM agreement_submissions WHERE id=$1 RETURNING *`,[s.id,ref,token,req.user.id]);
      const replacement=r.rows[0],parties=await client.query(`SELECT * FROM agreement_submission_parties WHERE submission_id=$1 AND party_side='party_b' ORDER BY sign_order,id`,[s.id]);
      for(const p of parties.rows){await client.query(`INSERT INTO agreement_submission_parties(submission_id,party_side,party_type,role,legal_name,display_name,email,mobile,capacity,sign_order,required,metadata,member_user_id,signing_token) VALUES($1,'party_b',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[replacement.id,p.party_type,p.role,p.legal_name,p.display_name,p.email,p.mobile,p.capacity,p.sign_order,p.required,p.metadata,p.member_user_id,G.randomToken(32)]);}
      await client.query('UPDATE agreement_submissions SET superseded_by_id=$2 WHERE id=$1',[s.id,replacement.id]);
      await G.audit({agreementId:s.agreement_id,submissionId:s.id,action:'signed_agreement_superseded',fromStatus:s.workflow_status,toStatus:s.workflow_status,reason,details:{supersededBy:replacement.id,newReference:ref},req,client});
      await G.audit({agreementId:s.agreement_id,submissionId:replacement.id,action:'agreement_reopened_as_new_record',toStatus:'in_progress',reason,details:{supersedes:s.id},req,client});
      await client.query('COMMIT');return res.status(201).json({reopened:true,superseded:true,agreement:replacement});
    }
    await client.query(`UPDATE agreement_submissions SET workflow_status='in_progress',locked_at=NULL,reopened_at=now() WHERE id=$1`,[s.id]);
    await G.audit({agreementId:s.agreement_id,submissionId:s.id,action:'agreement_reopened',fromStatus:s.workflow_status,toStatus:'in_progress',reason,req,client});await client.query('COMMIT');res.json({reopened:true,superseded:false,status:'in_progress'});
  }catch(err){await client.query('ROLLBACK').catch(()=>{});if(err.statusCode)return res.status(err.statusCode).json({error:err.message});next(err);}finally{client.release();}
});

router.post('/generator/admin/agreements/:id/party-a-sign', requireRole('admin'), S.requireInstanceAccess, async(req,res,next)=>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');const s=await S.loadSubmission(req.params.id,client);if(!s){await client.query('ROLLBACK');return res.status(404).json({error:'Agreement record not found.'});}
    if(s.party_a_signed_at)throw Object.assign(new Error('Party A has already signed this agreement.'),{statusCode:409});
    if(s.signing_order==='party_b_first'&&!(await S.requiredPartyBSignaturesComplete(s.id,client)))throw Object.assign(new Error('Every required Party B signer must sign first for this agreement.'),{statusCode:409});
    const type=G.SIGNATURE_TYPES.includes(req.body.signatureType)?req.body.signatureType:'typed',name=G.trim(req.body.name,220);if(!name)throw Object.assign(new Error('Party A signer name is required.'),{statusCode:400});
    const signatureText=type==='typed'?G.trim(req.body.signatureText||name,500):null;let signatureUrl=null;if(type!=='typed')signatureUrl=await G.storePrivateSignature(req.body.signatureDataUrl,'party-a');
    const p=await client.query(`INSERT INTO agreement_submission_parties(submission_id,party_side,party_type,role,legal_name,email,capacity,sign_order,required,signed_at) VALUES($1,'party_a','business','authorised_representative',$2,$3,$4,0,true,now()) RETURNING *`,[s.id,name,G.trim(req.body.email,255),G.trim(req.body.capacity,180)]);
    await client.query(`INSERT INTO agreement_signatures(submission_id,party_id,party_side,signature_type,signature_text,signature_url,declaration_accepted,ip,user_agent,metadata) VALUES($1,$2,'party_a',$3,$4,$5,true,$6,$7,$8)`,[s.id,p.rows[0].id,type,signatureText,signatureUrl,req.ip,G.trim(req.get('user-agent'),1000),JSON.stringify({capacity:req.body.capacity||null})]);
    await client.query('UPDATE agreement_submissions SET party_a_signed_at=now() WHERE id=$1',[s.id]);await G.audit({agreementId:s.agreement_id,submissionId:s.id,action:'party_a_signed',details:{name,type},req,client});await client.query('COMMIT');res.json({signed:true});
  }catch(err){await client.query('ROLLBACK').catch(()=>{});if(err.statusCode)return res.status(err.statusCode).json({error:err.message});next(err);}finally{client.release();}
});

router.get('/generator/admin/agreements/:id/pdf', requireRole('admin'), S.requireInstanceAccess, async(req,res,next)=>{try{const pdf=await S.renderPdfForSubmission(req.agreementSubmission);if(!pdf)return res.status(404).json({error:'Agreement definition unavailable.'});res.type('application/pdf').attachment(`${req.agreementSubmission.reference}.pdf`).send(pdf);}catch(err){next(err);}});

module.exports = router;
