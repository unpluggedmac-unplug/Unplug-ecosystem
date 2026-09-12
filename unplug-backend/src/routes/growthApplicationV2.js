'use strict';

const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const asId = (v) => { const n = Number.parseInt(v, 10); return Number.isInteger(n) && n > 0 ? n : null; };
const empty = (v) => v == null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length)
  || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);

async function owned(applicationId, userId, client = pool) {
  const r = await client.query(
    `SELECT id,user_id,applicant_email,applicant_type,status,form_version_id,completion_percent,last_saved_at,
            popia_consent,popia_consent_at,popia_consent_version,submitted_at,locked_at,withdrawn_at,
            external_sharing_allowed,external_sharing_consent_at,created_at,updated_at
       FROM growth_applications WHERE id=$1 AND user_id=$2`, [applicationId,userId]);
  return r.rows[0] || null;
}

async function form(versionId, applicantType, client = pool) {
  const v = await client.query(
    `SELECT v.id,v.version_number,v.title,v.intro_text,v.consent_text,f.id AS form_id,f.slug,f.name
       FROM growth_form_versions v JOIN growth_forms f ON f.id=v.form_id WHERE v.id=$1`, [versionId]);
  if (!v.rowCount) return null;
  const steps = await client.query(
    `SELECT id,step_key,title,description,display_order FROM growth_form_steps
      WHERE version_id=$1 AND is_enabled=true ORDER BY display_order,id`, [versionId]);
  const fields = await client.query(
    `SELECT f.id,f.step_id,f.field_key,f.label,f.help_text,f.placeholder,f.field_type,f.display_order,
            f.is_required,f.sensitive,f.confidential,f.allow_external_sharing,f.validation_rules,f.visibility_rules,
            COALESCE(jsonb_agg(jsonb_build_object('value',o.option_value,'label',o.option_label,'displayOrder',o.display_order)
              ORDER BY o.display_order,o.id) FILTER (WHERE o.id IS NOT NULL),'[]'::jsonb) AS options
       FROM growth_form_fields f LEFT JOIN growth_form_field_options o ON o.field_id=f.id AND o.is_enabled=true
      WHERE f.version_id=$1 AND f.is_enabled=true AND (f.sensitive=false OR f.sensitive_enabled=true)
        AND f.applicant_types ? $2
      GROUP BY f.id ORDER BY f.step_id,f.display_order,f.id`, [versionId,applicantType]);
  return { ...v.rows[0], steps: steps.rows, fields: fields.rows };
}

async function activeForm(applicantType, client = pool) {
  const v = await client.query(
    `SELECT v.id FROM growth_forms f JOIN growth_form_versions v ON v.form_id=f.id
      WHERE f.is_master=true AND f.is_active=true AND v.status='published'
      ORDER BY v.version_number DESC LIMIT 1`);
  return v.rowCount ? form(v.rows[0].id, applicantType, client) : null;
}

async function answers(applicationId, client = pool, onlyKeys = null) {
  const params = [applicationId]; let extra = '';
  if (onlyKeys && onlyKeys.length) { params.push(onlyKeys); extra = 'AND field_key=ANY($2::text[])'; }
  const r = await client.query(
    `SELECT DISTINCT ON(field_key) field_key,field_id,value_json,revision_number,created_at
       FROM growth_application_answer_revisions WHERE application_id=$1 ${extra}
      ORDER BY field_key,revision_number DESC`, params);
  return Object.fromEntries(r.rows.map(x => [x.field_key,{ value:x.value_json, revision:x.revision_number, savedAt:x.created_at }]));
}

async function infoRequests(applicationId, client = pool) {
  const r = await client.query(
    `SELECT q.id,q.request_text,q.requested_fields,q.status,q.requested_at,q.responded_at,q.closed_at,
            COALESCE(jsonb_agg(jsonb_build_object('id',x.id,'responseText',x.response_text,'responseData',x.response_data,'createdAt',x.created_at)
              ORDER BY x.created_at) FILTER(WHERE x.id IS NOT NULL),'[]'::jsonb) AS responses
       FROM growth_information_requests q LEFT JOIN growth_information_responses x ON x.request_id=q.id
      WHERE q.application_id=$1 GROUP BY q.id ORDER BY q.requested_at DESC`, [applicationId]);
  return r.rows;
}

router.get('/form', async(req,res,next)=>{
  const type=req.query.applicantType==='business'?'business':'individual';
  try{const f=await activeForm(type);return f?res.json({form:f}):res.status(409).json({error:'The Growth Application is not currently open for new applications.'});}
  catch(e){return next(e);}
});

router.get('/applications',async(req,res,next)=>{
  try{const r=await pool.query(`SELECT id,applicant_type,status,completion_percent,last_saved_at,submitted_at,withdrawn_at,created_at,updated_at
    FROM growth_applications WHERE user_id=$1 ORDER BY created_at DESC`,[req.user.id]);return res.json({applications:r.rows});}
  catch(e){return next(e);}
});

router.post('/applications',async(req,res,next)=>{
  const type=req.body?.applicantType;if(!['individual','business'].includes(type))return res.status(400).json({error:'Choose individual or business.'});
  const client=await pool.connect();try{await client.query('BEGIN');const f=await activeForm(type,client);if(!f){await client.query('ROLLBACK');return res.status(409).json({error:'The Growth Application is not currently open for new applications.'});}
    const r=await client.query(`INSERT INTO growth_applications(user_id,applicant_email,applicant_type,status,form_version_id,current_stage,question_bank_version,last_saved_at)
      VALUES($1,$2,$3,'draft',$4,'quick_profile',$5,now()) RETURNING id,applicant_type,status,form_version_id,completion_percent,last_saved_at,created_at,updated_at`,
      [req.user.id,req.user.email,type,f.id,`growth-v2-${f.version_number}`]);
    await client.query(`INSERT INTO growth_status_history(application_id,from_status,to_status,changed_by,note) VALUES($1,NULL,'draft',$2,'Application created')`,[r.rows[0].id,req.user.id]);
    await client.query('COMMIT');return res.status(201).json({application:r.rows[0],form:f});
  }catch(e){await client.query('ROLLBACK');return next(e);}finally{client.release();}
});

router.get('/applications/:id',async(req,res,next)=>{
  const applicationId=asId(req.params.id);if(!applicationId)return res.status(400).json({error:'Invalid application id.'});
  try{const a=await owned(applicationId,req.user.id);if(!a)return res.status(404).json({error:'Growth Application not found.'});const requests=await infoRequests(applicationId);
    if(a.status!=='draft'){
      const open=await pool.query(`SELECT field_key,reason,opened_at FROM growth_application_field_reopens WHERE application_id=$1 AND closed_at IS NULL ORDER BY opened_at`,[applicationId]);
      const payload={application:a,informationRequests:requests,reopenedFields:open.rows};
      if(open.rowCount){
        const full=await form(a.form_version_id,a.applicant_type);const keys=open.rows.map(x=>x.field_key);
        payload.reopenedForm={...full,fields:full.fields.filter(x=>keys.includes(x.field_key)),steps:full.steps.filter(s=>full.fields.some(f=>keys.includes(f.field_key)&&f.step_id===s.id))};
        payload.reopenedAnswers=await answers(applicationId,pool,keys);
      }
      return res.json(payload);
    }
    return res.json({application:a,form:await form(a.form_version_id,a.applicant_type),answers:await answers(applicationId),informationRequests:requests});
  }catch(e){return next(e);}
});

router.patch('/applications/:id/consent',async(req,res,next)=>{
  const applicationId=asId(req.params.id);if(!applicationId||typeof req.body?.accepted!=='boolean')return res.status(400).json({error:'Provide accepted=true or false.'});
  try{const r=await pool.query(`UPDATE growth_applications SET popia_consent=$3,popia_consent_at=CASE WHEN $3 THEN now() ELSE NULL END,
    popia_consent_version=CASE WHEN $3 THEN COALESCE($4,popia_consent_version,'growth-v2') ELSE NULL END,updated_at=now()
    WHERE id=$1 AND user_id=$2 AND status='draft' RETURNING id,popia_consent,popia_consent_at,popia_consent_version`,
    [applicationId,req.user.id,req.body.accepted,String(req.body?.version||'').trim()||null]);
    return r.rowCount?res.json(r.rows[0]):res.status(409).json({error:'Consent can only be changed while the application is a draft.'});
  }catch(e){return next(e);}
});

router.patch('/applications/:id/external-sharing',async(req,res,next)=>{
  const applicationId=asId(req.params.id);if(!applicationId||typeof req.body?.allowed!=='boolean')return res.status(400).json({error:'Provide allowed=true or false.'});
  try{const r=await pool.query(`UPDATE growth_applications SET external_sharing_allowed=$3,external_sharing_consent_at=CASE WHEN $3 THEN now() ELSE NULL END,updated_at=now()
    WHERE id=$1 AND user_id=$2 AND status='draft' RETURNING id,external_sharing_allowed,external_sharing_consent_at`,[applicationId,req.user.id,req.body.allowed]);
    return r.rowCount?res.json(r.rows[0]):res.status(409).json({error:'External-sharing consent can only be changed while the application is a draft.'});
  }catch(e){return next(e);}
});

router.put('/applications/:id/answers',async(req,res,next)=>{
  const applicationId=asId(req.params.id),input=req.body?.answers;if(!applicationId||!input||typeof input!=='object'||Array.isArray(input))return res.status(400).json({error:'Provide answers keyed by field key.'});
  const keys=Object.keys(input);if(!keys.length)return res.status(400).json({error:'No answers supplied.'});
  const client=await pool.connect();try{await client.query('BEGIN');const ar=await client.query(`SELECT * FROM growth_applications WHERE id=$1 AND user_id=$2 FOR UPDATE`,[applicationId,req.user.id]);
    if(!ar.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Growth Application not found.'});}const a=ar.rows[0];if(['withdrawn','completed','closed'].includes(a.status)){await client.query('ROLLBACK');return res.status(409).json({error:'This Growth Application can no longer be edited.'});}
    const valid=await client.query(`SELECT id,field_key FROM growth_form_fields WHERE version_id=$1 AND is_enabled=true AND (sensitive=false OR sensitive_enabled=true) AND applicant_types ? $2 AND field_key=ANY($3::text[])`,[a.form_version_id,a.applicant_type,keys]);
    const map=new Map(valid.rows.map(x=>[x.field_key,x.id]));if(map.size!==keys.length){await client.query('ROLLBACK');return res.status(400).json({error:'One or more fields are invalid for this application.'});}
    if(a.status!=='draft'){const open=await client.query(`SELECT field_key FROM growth_application_field_reopens WHERE application_id=$1 AND closed_at IS NULL AND field_key=ANY($2::text[])`,[applicationId,keys]);if(open.rowCount!==keys.length){await client.query('ROLLBACK');return res.status(409).json({error:'Only fields specifically reopened by Unplug can be edited after submission.'});}}
    for(const key of keys){const rev=await client.query(`SELECT COALESCE(MAX(revision_number),0)+1 AS n FROM growth_application_answer_revisions WHERE application_id=$1 AND field_key=$2`,[applicationId,key]);
      await client.query(`INSERT INTO growth_application_answer_revisions(application_id,field_id,field_key,revision_number,value_json,saved_by,save_source) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`,[applicationId,map.get(key),key,rev.rows[0].n,JSON.stringify(input[key]??null),req.user.id,a.status==='draft'?'member':'admin_reopen']);}
    if(a.status!=='draft')await client.query(`UPDATE growth_application_field_reopens SET closed_at=now() WHERE application_id=$1 AND closed_at IS NULL AND field_key=ANY($2::text[])`,[applicationId,keys]);
    const required=await client.query(`SELECT field_key FROM growth_form_fields WHERE version_id=$1 AND is_enabled=true AND is_required=true AND (sensitive=false OR sensitive_enabled=true) AND applicant_types ? $2`,[a.form_version_id,a.applicant_type]);
    const now=await answers(applicationId,client);const done=required.rows.filter(x=>now[x.field_key]&&!empty(now[x.field_key].value)).length;const pct=required.rowCount?Math.round(done/required.rowCount*100):100;
    await client.query(`UPDATE growth_applications SET completion_percent=$2,last_saved_at=now(),updated_at=now() WHERE id=$1`,[applicationId,pct]);await client.query('COMMIT');return res.json({saved:keys,completionPercent:pct});
  }catch(e){await client.query('ROLLBACK');return next(e);}finally{client.release();}
});

router.post('/applications/:id/submit',async(req,res,next)=>{
  const applicationId=asId(req.params.id);if(!applicationId)return res.status(400).json({error:'Invalid application id.'});const client=await pool.connect();
  try{await client.query('BEGIN');const ar=await client.query(`SELECT * FROM growth_applications WHERE id=$1 AND user_id=$2 FOR UPDATE`,[applicationId,req.user.id]);if(!ar.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Growth Application not found.'});}const a=ar.rows[0];
    if(a.status!=='draft'){await client.query('ROLLBACK');return res.status(409).json({error:'Only a draft can be submitted.'});}if(!a.popia_consent){await client.query('ROLLBACK');return res.status(400).json({error:'POPIA consent is required before submission.'});}
    const required=await client.query(`SELECT field_key,label FROM growth_form_fields WHERE version_id=$1 AND is_enabled=true AND is_required=true AND (sensitive=false OR sensitive_enabled=true) AND applicant_types ? $2`,[a.form_version_id,a.applicant_type]);const now=await answers(applicationId,client);const missing=required.rows.filter(x=>!now[x.field_key]||empty(now[x.field_key].value));if(missing.length){await client.query('ROLLBACK');return res.status(400).json({error:'Complete all required fields before submitting.',missingFields:missing});}
    await client.query(`UPDATE growth_applications SET status='submitted',submitted_at=now(),locked_at=now(),current_stage='submitted',completion_percent=100,last_saved_at=now(),updated_at=now() WHERE id=$1`,[applicationId]);
    await client.query(`INSERT INTO growth_status_history(application_id,from_status,to_status,changed_by,note) VALUES($1,'draft','submitted',$2,'Member submitted application')`,[applicationId,req.user.id]);await client.query('COMMIT');return res.json({application:{id:applicationId,status:'submitted',completionPercent:100}});
  }catch(e){await client.query('ROLLBACK');return next(e);}finally{client.release();}
});

router.post('/applications/:id/withdraw',async(req,res,next)=>{
  const applicationId=asId(req.params.id);if(!applicationId)return res.status(400).json({error:'Invalid application id.'});const client=await pool.connect();try{await client.query('BEGIN');const old=await client.query(`SELECT status FROM growth_applications WHERE id=$1 AND user_id=$2 FOR UPDATE`,[applicationId,req.user.id]);if(!old.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Growth Application not found.'});}if(['withdrawn','completed','closed'].includes(old.rows[0].status)){await client.query('ROLLBACK');return res.status(409).json({error:'This Growth Application cannot be withdrawn.'});}
    await client.query(`UPDATE growth_applications SET status='withdrawn',withdrawn_at=now(),withdrawn_reason=$3,locked_at=COALESCE(locked_at,now()),updated_at=now() WHERE id=$1 AND user_id=$2`,[applicationId,req.user.id,String(req.body?.reason||'').trim()||null]);
    await client.query(`INSERT INTO growth_status_history(application_id,from_status,to_status,changed_by,note) VALUES($1,$2,'withdrawn',$3,'Member withdrew application')`,[applicationId,old.rows[0].status,req.user.id]);await client.query('COMMIT');return res.json({application:{id:applicationId,status:'withdrawn'}});
  }catch(e){await client.query('ROLLBACK');return next(e);}finally{client.release();}
});

router.post('/information-requests/:id/respond',async(req,res,next)=>{
  const requestId=asId(req.params.id),responseText=String(req.body?.responseText||'').trim(),responseData=obj(req.body?.responseData);if(!requestId||(!responseText&&!Object.keys(responseData).length))return res.status(400).json({error:'Provide a response.'});const client=await pool.connect();
  try{await client.query('BEGIN');const q=await client.query(`SELECT q.id,q.application_id,q.status FROM growth_information_requests q JOIN growth_applications a ON a.id=q.application_id WHERE q.id=$1 AND a.user_id=$2 FOR UPDATE OF q`,[requestId,req.user.id]);if(!q.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Information request not found.'});}if(q.rows[0].status!=='open'){await client.query('ROLLBACK');return res.status(409).json({error:'This information request is no longer open.'});}
    await client.query(`INSERT INTO growth_information_responses(request_id,application_id,response_text,response_data,responded_by) VALUES($1,$2,$3,$4::jsonb,$5)`,[requestId,q.rows[0].application_id,responseText||null,JSON.stringify(responseData),req.user.id]);await client.query(`UPDATE growth_information_requests SET status='responded',responded_at=now() WHERE id=$1`,[requestId]);await client.query(`UPDATE growth_applications SET status='under_review',updated_at=now() WHERE id=$1 AND status='information_requested'`,[q.rows[0].application_id]);await client.query('COMMIT');return res.status(201).json({responded:true});
  }catch(e){await client.query('ROLLBACK');return next(e);}finally{client.release();}
});

module.exports = router;
