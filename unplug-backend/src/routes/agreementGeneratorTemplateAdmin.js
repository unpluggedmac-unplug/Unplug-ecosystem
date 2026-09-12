const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const G = require('../utils/agreementGenerator');
const S = require('../utils/agreementGeneratorService');

const router = express.Router();
const APPROVAL_TRANSITIONS = {
  draft:['legal_review'], legal_review:['approved','draft'], approved:['published','legal_review'],
  published:['retired'], retired:['draft'],
};

router.get('/generator/admin/templates', requireRole('admin'), async (req,res,next) => {
  try {
    const r = await pool.query(`SELECT a.*,
      (SELECT count(*)::int FROM agreement_fields f WHERE f.agreement_id=a.id) field_count,
      (SELECT count(*)::int FROM agreement_form_clauses c WHERE c.agreement_id=a.id) clause_count,
      (SELECT count(*)::int FROM agreement_form_items i WHERE i.agreement_id=a.id) item_count,
      (SELECT max(v.version) FROM agreement_form_versions v WHERE v.agreement_id=a.id AND v.approval_status IN ('approved','published')) latest_approved_version
      FROM agreement_forms a ORDER BY a.updated_at DESC,a.id DESC`);
    res.json({ templates:r.rows });
  } catch (err) { next(err); }
});

router.get('/generator/admin/templates/:id', requireRole('admin'), async (req,res,next) => {
  try {
    const d = await G.getFormDefinition(req.params.id);
    if (!d) return res.status(404).json({ error:'Agreement template not found.' });
    const history = await pool.query(`SELECT h.*,u.full_name reviewer_name,u.email reviewer_email
      FROM agreement_template_approval_history h LEFT JOIN users u ON u.id=h.reviewer_id
      WHERE h.agreement_id=$1 ORDER BY h.created_at DESC,h.id DESC`, [req.params.id]);
    res.json({ ...d, approvalHistory:history.rows });
  } catch (err) { next(err); }
});

router.patch('/generator/admin/templates/:id', requireRole('admin'), async (req,res,next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await G.getFormDefinition(req.params.id,client);
    if (!current) { await client.query('ROLLBACK'); return res.status(404).json({ error:'Agreement template not found.' }); }
    const b=req.body||{}, f=current.form;
    const signerType=b.signerType===undefined?f.signer_type:String(b.signerType);
    const accessMethod=b.accessMethod===undefined?f.access_method:String(b.accessMethod);
    const signingOrder=b.signingOrder===undefined?f.signing_order:String(b.signingOrder);
    if(!['individual','business','choice'].includes(signerType)) throw Object.assign(new Error('Party B type must be Individual, Business or Choice.'),{statusCode:400});
    if(!G.ACCESS_METHODS.includes(accessMethod)) throw Object.assign(new Error('Invalid access method.'),{statusCode:400});
    if(!G.SIGNING_ORDERS.includes(signingOrder)) throw Object.assign(new Error('Invalid signing order.'),{statusCode:400});
    await S.bumpTemplateVersion(f.id,req,client,'Agreement template details changed');
    const r=await client.query(`UPDATE agreement_forms SET
      name=COALESCE($2,name),title=COALESCE($3,title),description=$4,category=$5,signer_type=$6,
      rules=$7,terms=$8,post_signing_requirements=$9,service_scope=$10,service_name=$11,
      service_description=$12,service_reference=$13,client_name=$14,amount=$15,payment_mode=$16,
      min_age=$17,require_witness=$18,require_company_stamp=$19,access_method=$20,signing_order=$21,
      delivery_config=$22,notification_config=$23,declarations=$24,reminder_days=$25,updated_at=now()
      WHERE id=$1 RETURNING *`, [f.id,
      b.name===undefined?f.name:G.trim(b.name,160), b.title===undefined?f.title:G.trim(b.title,220),
      b.description===undefined?f.description:G.trim(b.description,10000), b.category===undefined?f.category:G.trim(b.category,120), signerType,
      b.rules===undefined?f.rules:S.cleanRichText(b.rules), b.terms===undefined?f.terms:S.cleanRichText(b.terms),
      b.postSigningRequirements===undefined?f.post_signing_requirements:S.cleanRichText(b.postSigningRequirements,30000),
      b.serviceScope===undefined?f.service_scope:(b.serviceScope==='external'?'external':'website'),
      b.serviceName===undefined?f.service_name:G.trim(b.serviceName,200), b.serviceDescription===undefined?f.service_description:G.trim(b.serviceDescription,10000),
      b.serviceReference===undefined?f.service_reference:G.trim(b.serviceReference,160), b.clientName===undefined?f.client_name:G.trim(b.clientName,200),
      b.amount===undefined?f.amount:(b.amount===''||b.amount===null?null:Math.max(0,Number(b.amount)||0)),
      b.paymentMode===undefined?f.payment_mode:(['none','before_sign','after_sign'].includes(b.paymentMode)?b.paymentMode:'none'),
      b.minAge===undefined?f.min_age:(b.minAge===''||b.minAge===null?null:Math.max(0,Number(b.minAge)||0)),
      b.requireWitness===undefined?f.require_witness:!!b.requireWitness, b.requireCompanyStamp===undefined?f.require_company_stamp:!!b.requireCompanyStamp,
      accessMethod,signingOrder,JSON.stringify(b.deliveryConfig===undefined?f.delivery_config:S.asObject(b.deliveryConfig)),
      JSON.stringify(b.notificationConfig===undefined?f.notification_config:S.asObject(b.notificationConfig)),
      JSON.stringify(b.declarations===undefined?S.asArray(f.declarations):S.asArray(b.declarations)),
      b.reminderDays===undefined?f.reminder_days:(b.reminderDays===''||b.reminderDays===null?null:Math.max(0,Number(b.reminderDays)||0))]);
    await client.query('COMMIT'); res.json({ template:r.rows[0] });
  } catch(err) { await client.query('ROLLBACK').catch(()=>{}); if(err.statusCode)return res.status(err.statusCode).json({error:err.message}); next(err); }
  finally { client.release(); }
});

router.post('/generator/admin/templates/:id/approval', requireRole('admin'), async(req,res,next)=>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN'); const d=await G.getFormDefinition(req.params.id,client);
    if(!d){await client.query('ROLLBACK');return res.status(404).json({error:'Agreement template not found.'});}
    const from=d.form.approval_status||'draft',to=String(req.body.status||'');
    if(!(APPROVAL_TRANSITIONS[from]||[]).includes(to)) throw Object.assign(new Error(`Template status cannot move from ${from} to ${to}.`),{statusCode:400});
    if(['approved','published'].includes(to)){if(!(d.fields||[]).length)throw Object.assign(new Error('Add at least one field before approval.'),{statusCode:400});for(const field of d.fields)G.validatePopia(field);}
    const sets=['approval_status=$2','reviewed_by=$3','reviewed_at=now()','updated_at=now()'];
    if(to==='approved')sets.push('approved_by=$3','approved_at=now()');
    if(to==='published')sets.push("published=true","status='active'",'published_at=now()');
    if(to==='retired')sets.push("published=false","status='archived'",'retired_at=now()');
    if(to==='draft')sets.push("published=false","status='draft'");
    const r=await client.query(`UPDATE agreement_forms SET ${sets.join(',')} WHERE id=$1 RETURNING *`,[d.form.id,to,req.user.id]);
    await client.query(`INSERT INTO agreement_template_approval_history(agreement_id,version,from_status,to_status,reviewer_id,reason) VALUES($1,$2,$3,$4,$5,$6)`,[d.form.id,d.form.version,from,to,req.user.id,G.trim(req.body.reason,5000)]);
    await G.ensureVersionSnapshot(d.form.id,req.user.id,client,to);
    await G.audit({agreementId:d.form.id,action:'template_approval_status',fromStatus:from,toStatus:to,reason:req.body.reason,details:{version:d.form.version},req,client});
    await client.query('COMMIT');res.json({template:r.rows[0]});
  }catch(err){await client.query('ROLLBACK').catch(()=>{});if(err.statusCode)return res.status(err.statusCode).json({error:err.message});next(err);}finally{client.release();}
});

router.post('/generator/admin/templates/:id/fields', requireRole('admin'), async(req,res,next)=>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');const d=await G.getFormDefinition(req.params.id,client);if(!d){await client.query('ROLLBACK');return res.status(404).json({error:'Agreement template not found.'});}
    const b=req.body||{},kind=['text','email','phone','textarea','number','date','select','radio','checkbox','file'].includes(b.kind)?b.kind:null;
    const key=String(b.key||b.fieldKey||'').toLowerCase().replace(/[^a-z0-9_]+/g,'_').replace(/^_|_$/g,'').slice(0,60),label=G.trim(b.label,200);
    if(!kind||!key||!label)throw Object.assign(new Error('kind, key and label are required.'),{statusCode:400});
    const sensitiveType=b.sensitiveType==='identity_document'?'identity_document':null,popia=G.validatePopia({...b,sensitiveType});
    await S.bumpTemplateVersion(d.form.id,req,client,`Field added: ${label}`);
    const r=await client.query(`INSERT INTO agreement_fields(agreement_id,position,kind,field_key,label,placeholder,help,required,options,max_length,section_key,party_scope,condition_json,config,sensitive_type,popia_enabled,popia_purpose,popia_retention,popia_access,popia_ack_required)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,[d.form.id,Number(b.position)||0,kind,key,label,G.trim(b.placeholder,200),G.trim(b.help,2000),!!b.required,JSON.stringify(S.asArray(b.options)),b.maxLength?Math.min(10000,Math.max(1,Number(b.maxLength)||0)):null,G.MASTER_SECTIONS.includes(b.sectionKey)?b.sectionKey:'agreement_specific_questions',G.trim(b.partyScope,40),JSON.stringify(S.asObject(b.condition)),JSON.stringify(S.asObject(b.config)),sensitiveType,!!b.popiaEnabled,popia&&popia.purpose,popia&&popia.retention,popia&&popia.access,!!b.popiaAckRequired]);
    await client.query('COMMIT');res.status(201).json({field:r.rows[0]});
  }catch(err){await client.query('ROLLBACK').catch(()=>{});if(err.code==='23505')return res.status(409).json({error:'That field key is already used.'});if(err.statusCode)return res.status(err.statusCode).json({error:err.message});next(err);}finally{client.release();}
});

router.patch('/generator/admin/templates/:id/fields/:fieldId', requireRole('admin'), async(req,res,next)=>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');const d=await G.getFormDefinition(req.params.id,client);if(!d){await client.query('ROLLBACK');return res.status(404).json({error:'Agreement template not found.'});}
    const found=d.fields.find(x=>Number(x.id)===Number(req.params.fieldId));if(!found){await client.query('ROLLBACK');return res.status(404).json({error:'Field not found.'});}
    const b=req.body||{},sensitiveType=b.sensitiveType===undefined?found.sensitive_type:(b.sensitiveType==='identity_document'?'identity_document':null);
    const merged={sensitiveType,popiaEnabled:b.popiaEnabled===undefined?found.popia_enabled:!!b.popiaEnabled,popiaPurpose:b.popiaPurpose===undefined?found.popia_purpose:b.popiaPurpose,popiaRetention:b.popiaRetention===undefined?found.popia_retention:b.popiaRetention,popiaAccess:b.popiaAccess===undefined?found.popia_access:b.popiaAccess};const popia=G.validatePopia(merged);
    await S.bumpTemplateVersion(d.form.id,req,client,`Field edited: ${found.label}`);
    const r=await client.query(`UPDATE agreement_fields SET position=$3,label=$4,placeholder=$5,help=$6,required=$7,options=$8,max_length=$9,section_key=$10,party_scope=$11,condition_json=$12,config=$13,sensitive_type=$14,popia_enabled=$15,popia_purpose=$16,popia_retention=$17,popia_access=$18,popia_ack_required=$19 WHERE id=$1 AND agreement_id=$2 RETURNING *`,[found.id,d.form.id,b.position===undefined?found.position:Number(b.position)||0,b.label===undefined?found.label:G.trim(b.label,200),b.placeholder===undefined?found.placeholder:G.trim(b.placeholder,200),b.help===undefined?found.help:G.trim(b.help,2000),b.required===undefined?found.required:!!b.required,JSON.stringify(b.options===undefined?S.asArray(found.options):S.asArray(b.options)),b.maxLength===undefined?found.max_length:(b.maxLength?Math.min(10000,Math.max(1,Number(b.maxLength)||0)):null),b.sectionKey===undefined?found.section_key:(G.MASTER_SECTIONS.includes(b.sectionKey)?b.sectionKey:'agreement_specific_questions'),b.partyScope===undefined?found.party_scope:G.trim(b.partyScope,40),JSON.stringify(b.condition===undefined?S.asObject(found.condition_json):S.asObject(b.condition)),JSON.stringify(b.config===undefined?S.asObject(found.config):S.asObject(b.config)),sensitiveType,merged.popiaEnabled,popia&&popia.purpose,popia&&popia.retention,popia&&popia.access,b.popiaAckRequired===undefined?found.popia_ack_required:!!b.popiaAckRequired]);
    await client.query('COMMIT');res.json({field:r.rows[0]});
  }catch(err){await client.query('ROLLBACK').catch(()=>{});if(err.statusCode)return res.status(err.statusCode).json({error:err.message});next(err);}finally{client.release();}
});

router.post('/generator/admin/templates/:id/fields/reorder', requireRole('admin'), async(req,res,next)=>{
  const client=await pool.connect();try{await client.query('BEGIN');const d=await G.getFormDefinition(req.params.id,client);if(!d){await client.query('ROLLBACK');return res.status(404).json({error:'Agreement template not found.'});}const ids=Array.isArray(req.body.fieldIds)?req.body.fieldIds.map(Number).filter(Number.isInteger):[];if(!ids.length)throw Object.assign(new Error('fieldIds is required.'),{statusCode:400});await S.bumpTemplateVersion(d.form.id,req,client,'Form fields reordered');for(let i=0;i<ids.length;i++)await client.query('UPDATE agreement_fields SET position=$3 WHERE agreement_id=$1 AND id=$2',[d.form.id,ids[i],(i+1)*10]);await client.query('COMMIT');res.json({reordered:true});}catch(err){await client.query('ROLLBACK').catch(()=>{});if(err.statusCode)return res.status(err.statusCode).json({error:err.message});next(err);}finally{client.release();}
});

router.delete('/generator/admin/templates/:id/fields/:fieldId', requireRole('admin'), async(req,res,next)=>{
  const client=await pool.connect();try{await client.query('BEGIN');const d=await G.getFormDefinition(req.params.id,client);if(!d){await client.query('ROLLBACK');return res.status(404).json({error:'Agreement template not found.'});}const found=d.fields.find(x=>Number(x.id)===Number(req.params.fieldId));if(!found){await client.query('ROLLBACK');return res.status(404).json({error:'Field not found.'});}await S.bumpTemplateVersion(d.form.id,req,client,`Field removed: ${found.label}`);await client.query('DELETE FROM agreement_fields WHERE id=$1 AND agreement_id=$2',[found.id,d.form.id]);await client.query('COMMIT');res.json({deleted:true});}catch(err){await client.query('ROLLBACK').catch(()=>{});next(err);}finally{client.release();}
});

router.get('/generator/admin/clauses', requireRole('admin'), async(req,res,next)=>{try{const r=await pool.query('SELECT * FROM agreement_clause_blocks ORDER BY active DESC,name');res.json({clauses:r.rows});}catch(err){next(err);}});
router.post('/generator/admin/clauses', requireRole('admin'), async(req,res,next)=>{try{const name=G.trim(req.body.name,180),body=S.cleanRichText(req.body.bodyHtml);if(!name||!body)return res.status(400).json({error:'Clause name and text are required.'});const r=await pool.query(`INSERT INTO agreement_clause_blocks(name,category,body_html,created_by,updated_by) VALUES($1,$2,$3,$4,$4) RETURNING *`,[name,G.trim(req.body.category,120),body,req.user.id]);res.status(201).json({clause:r.rows[0]});}catch(err){if(err.code==='23505')return res.status(409).json({error:'A clause already uses that name.'});next(err);}});
router.patch('/generator/admin/clauses/:id', requireRole('admin'), async(req,res,next)=>{try{const r=await pool.query(`UPDATE agreement_clause_blocks SET name=COALESCE($2,name),category=COALESCE($3,category),body_html=COALESCE($4,body_html),active=COALESCE($5,active),updated_by=$6,updated_at=now() WHERE id=$1 RETURNING *`,[req.params.id,G.trim(req.body.name,180),req.body.category===undefined?null:G.trim(req.body.category,120),req.body.bodyHtml===undefined?null:S.cleanRichText(req.body.bodyHtml),req.body.active===undefined?null:!!req.body.active,req.user.id]);if(!r.rowCount)return res.status(404).json({error:'Clause not found.'});res.json({clause:r.rows[0]});}catch(err){next(err);}});

router.post('/generator/admin/templates/:id/clauses', requireRole('admin'), async(req,res,next)=>{const client=await pool.connect();try{await client.query('BEGIN');const d=await G.getFormDefinition(req.params.id,client);if(!d){await client.query('ROLLBACK');return res.status(404).json({error:'Agreement template not found.'});}await S.bumpTemplateVersion(d.form.id,req,client,'Agreement clause added');const r=await client.query(`INSERT INTO agreement_form_clauses(agreement_id,clause_block_id,position,title,body_html,condition_json,excluded) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[d.form.id,req.body.clauseBlockId||null,Number(req.body.position)||0,G.trim(req.body.title,220),req.body.bodyHtml?S.cleanRichText(req.body.bodyHtml):null,JSON.stringify(S.asObject(req.body.condition)),!!req.body.excluded]);await client.query('COMMIT');res.status(201).json({clause:r.rows[0]});}catch(err){await client.query('ROLLBACK').catch(()=>{});next(err);}finally{client.release();}});
router.patch('/generator/admin/templates/:id/clauses/:clauseId', requireRole('admin'), async(req,res,next)=>{const client=await pool.connect();try{await client.query('BEGIN');const d=await G.getFormDefinition(req.params.id,client);if(!d){await client.query('ROLLBACK');return res.status(404).json({error:'Agreement template not found.'});}const found=d.clauses.find(x=>Number(x.id)===Number(req.params.clauseId));if(!found){await client.query('ROLLBACK');return res.status(404).json({error:'Clause not found.'});}await S.bumpTemplateVersion(d.form.id,req,client,'Agreement clause changed');const r=await client.query(`UPDATE agreement_form_clauses SET position=$3,title=$4,body_html=$5,condition_json=$6,excluded=$7 WHERE id=$1 AND agreement_id=$2 RETURNING *`,[found.id,d.form.id,req.body.position===undefined?found.position:Number(req.body.position)||0,req.body.title===undefined?found.title:G.trim(req.body.title,220),req.body.bodyHtml===undefined?found.body_html:S.cleanRichText(req.body.bodyHtml),JSON.stringify(req.body.condition===undefined?S.asObject(found.condition_json):S.asObject(req.body.condition)),req.body.excluded===undefined?found.excluded:!!req.body.excluded]);await client.query('COMMIT');res.json({clause:r.rows[0]});}catch(err){await client.query('ROLLBACK').catch(()=>{});next(err);}finally{client.release();}});
router.delete('/generator/admin/templates/:id/clauses/:clauseId', requireRole('admin'), async(req,res,next)=>{const client=await pool.connect();try{await client.query('BEGIN');const d=await G.getFormDefinition(req.params.id,client);if(!d){await client.query('ROLLBACK');return res.status(404).json({error:'Agreement template not found.'});}await S.bumpTemplateVersion(d.form.id,req,client,'Agreement clause removed');const r=await client.query('DELETE FROM agreement_form_clauses WHERE id=$1 AND agreement_id=$2 RETURNING id',[req.params.clauseId,d.form.id]);if(!r.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Clause not found.'});}await client.query('COMMIT');res.json({deleted:true});}catch(err){await client.query('ROLLBACK').catch(()=>{});next(err);}finally{client.release();}});

router.post('/generator/admin/templates/:id/items', requireRole('admin'), async(req,res,next)=>{const client=await pool.connect();try{await client.query('BEGIN');const d=await G.getFormDefinition(req.params.id,client);if(!d){await client.query('ROLLBACK');return res.status(404).json({error:'Agreement template not found.'});}const kind=['note','upload'].includes(req.body.kind)?req.body.kind:null,visibility=['internal_admin','party_b_visible','party_b_required'].includes(req.body.visibility)?req.body.visibility:null,label=G.trim(req.body.label,220);if(!kind||!visibility||!label)throw Object.assign(new Error('kind, visibility and label are required.'),{statusCode:400});await S.bumpTemplateVersion(d.form.id,req,client,`${kind} requirement added`);const r=await client.query(`INSERT INTO agreement_form_items(agreement_id,position,kind,label,help,visibility,required,condition_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[d.form.id,Number(req.body.position)||0,kind,label,G.trim(req.body.help,3000),visibility,!!req.body.required||visibility==='party_b_required',JSON.stringify(S.asObject(req.body.condition))]);await client.query('COMMIT');res.status(201).json({item:r.rows[0]});}catch(err){await client.query('ROLLBACK').catch(()=>{});if(err.statusCode)return res.status(err.statusCode).json({error:err.message});next(err);}finally{client.release();}});
router.patch('/generator/admin/templates/:id/items/:itemId', requireRole('admin'), async(req,res,next)=>{const client=await pool.connect();try{await client.query('BEGIN');const d=await G.getFormDefinition(req.params.id,client);if(!d){await client.query('ROLLBACK');return res.status(404).json({error:'Agreement template not found.'});}const found=d.items.find(x=>Number(x.id)===Number(req.params.itemId));if(!found){await client.query('ROLLBACK');return res.status(404).json({error:'Item not found.'});}const visibility=req.body.visibility===undefined?found.visibility:(['internal_admin','party_b_visible','party_b_required'].includes(req.body.visibility)?req.body.visibility:null);if(!visibility)throw Object.assign(new Error('Invalid item visibility.'),{statusCode:400});await S.bumpTemplateVersion(d.form.id,req,client,'Note/upload requirement changed');const r=await client.query(`UPDATE agreement_form_items SET position=$3,label=$4,help=$5,visibility=$6,required=$7,condition_json=$8 WHERE id=$1 AND agreement_id=$2 RETURNING *`,[found.id,d.form.id,req.body.position===undefined?found.position:Number(req.body.position)||0,req.body.label===undefined?found.label:G.trim(req.body.label,220),req.body.help===undefined?found.help:G.trim(req.body.help,3000),visibility,req.body.required===undefined?found.required:!!req.body.required,JSON.stringify(req.body.condition===undefined?S.asObject(found.condition_json):S.asObject(req.body.condition))]);await client.query('COMMIT');res.json({item:r.rows[0]});}catch(err){await client.query('ROLLBACK').catch(()=>{});if(err.statusCode)return res.status(err.statusCode).json({error:err.message});next(err);}finally{client.release();}});
router.delete('/generator/admin/templates/:id/items/:itemId', requireRole('admin'), async(req,res,next)=>{const client=await pool.connect();try{await client.query('BEGIN');const d=await G.getFormDefinition(req.params.id,client);if(!d){await client.query('ROLLBACK');return res.status(404).json({error:'Agreement template not found.'});}await S.bumpTemplateVersion(d.form.id,req,client,'Note/upload requirement removed');const r=await client.query('DELETE FROM agreement_form_items WHERE id=$1 AND agreement_id=$2 RETURNING id',[req.params.itemId,d.form.id]);if(!r.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Item not found.'});}await client.query('COMMIT');res.json({deleted:true});}catch(err){await client.query('ROLLBACK').catch(()=>{});next(err);}finally{client.release();}});

module.exports = router;
