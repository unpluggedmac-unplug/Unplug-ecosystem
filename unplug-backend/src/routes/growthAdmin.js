'use strict';

const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireRole('admin'));

const STATUSES = new Set([
  'new','submitted','under_review','information_requested','assessment_in_progress',
  'plan_in_progress','in_progress','completed','withdrawn','closed','contacted',
]);
const FIELD_TYPES = new Set([
  'text','textarea','number','email','tel','date','url','select','multiselect','radio','checkbox','yes_no','upload',
]);
const ENTITY_TYPES = new Set(['member','business','opportunity','service_order','campaign','agreement']);
const PRIORITY_STATUSES = new Set(['identified','planned','in_progress','completed','dismissed']);
const OPPORTUNITY_STATUSES = new Set(['identified','considering','actioned','completed','declined']);
const PLAN_STATUSES = new Set(['draft','active','paused','completed','archived']);
const PLAN_ITEM_STATUSES = new Set(['not_started','in_progress','blocked','completed','cancelled']);

const asId = (v) => { const n = Number.parseInt(v, 10); return Number.isInteger(n) && n > 0 ? n : null; };
const str = (v) => String(v == null ? '' : v).trim();
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);

async function getMaster(client = pool, lock = false) {
  const q = `SELECT id,slug,name,description,is_active,created_at,updated_at
               FROM growth_forms WHERE is_master=true LIMIT 1${lock ? ' FOR UPDATE' : ''}`;
  const r = await client.query(q);
  return r.rows[0] || null;
}

async function versionTree(versionId, includeSensitive = false) {
  const version = await pool.query(
    `SELECT v.id,v.form_id,v.version_number,v.status,v.title,v.intro_text,v.consent_text,
            v.created_at,v.published_at,v.retired_at,f.slug AS form_slug,f.name AS form_name
       FROM growth_form_versions v JOIN growth_forms f ON f.id=v.form_id WHERE v.id=$1`, [versionId]);
  if (!version.rowCount) return null;
  const steps = await pool.query(
    `SELECT id,step_key,title,description,display_order,is_enabled
       FROM growth_form_steps WHERE version_id=$1 ORDER BY display_order,id`, [versionId]);
  const fields = await pool.query(
    `SELECT f.id,f.version_id,f.step_id,f.field_key,f.label,f.help_text,f.placeholder,
            f.field_type,f.display_order,f.is_required,f.is_enabled,f.sensitive,f.sensitive_enabled,
            f.confidential,f.allow_external_sharing,f.applicant_types,f.validation_rules,f.visibility_rules,
            COALESCE(jsonb_agg(jsonb_build_object('id',o.id,'value',o.option_value,'label',o.option_label,
              'displayOrder',o.display_order,'enabled',o.is_enabled) ORDER BY o.display_order,o.id)
              FILTER (WHERE o.id IS NOT NULL),'[]'::jsonb) AS options
       FROM growth_form_fields f
       LEFT JOIN growth_form_field_options o ON o.field_id=f.id
      WHERE f.version_id=$1 ${includeSensitive ? '' : 'AND f.sensitive=false'}
      GROUP BY f.id ORDER BY f.step_id,f.display_order,f.id`, [versionId]);
  return { ...version.rows[0], steps: steps.rows, fields: fields.rows };
}

async function latestAnswers(applicationId, includeSensitive = false) {
  const r = await pool.query(
    `SELECT DISTINCT ON (r.field_key) r.field_key,r.field_id,r.value_json,r.revision_number,r.created_at,
            f.label,f.field_type,COALESCE(f.sensitive,false) AS sensitive,COALESCE(f.confidential,false) AS confidential
       FROM growth_application_answer_revisions r
       LEFT JOIN growth_form_fields f ON f.id=r.field_id
      WHERE r.application_id=$1 ${includeSensitive ? '' : 'AND COALESCE(f.sensitive,false)=false'}
      ORDER BY r.field_key,r.revision_number DESC`, [applicationId]);
  return r.rows;
}

async function adminDetail(applicationId, includeSensitive = false) {
  const a = await pool.query(
    `SELECT a.id,a.user_id,a.applicant_email,a.applicant_type,a.status,a.form_version_id,
            a.completion_percent,a.last_saved_at,a.submitted_at,a.locked_at,a.withdrawn_at,a.withdrawn_reason,
            a.external_sharing_allowed,a.external_sharing_consent_at,a.admin_notes,a.research_notes,a.closed_reason,
            a.created_at,a.updated_at,u.email AS member_email
       FROM growth_applications a LEFT JOIN users u ON u.id=a.user_id WHERE a.id=$1`, [applicationId]);
  if (!a.rowCount) return null;
  const [answers, requests, assessment, priorities, opportunities, plan, progress, outcome, links, reopens, history] = await Promise.all([
    latestAnswers(applicationId, includeSensitive),
    pool.query(`SELECT id,request_text,requested_fields,status,requested_by,requested_at,responded_at,closed_at FROM growth_information_requests WHERE application_id=$1 ORDER BY requested_at DESC`, [applicationId]),
    pool.query(`SELECT * FROM growth_assessments WHERE application_id=$1`, [applicationId]),
    pool.query(`SELECT * FROM growth_priorities WHERE application_id=$1 ORDER BY priority_order,id`, [applicationId]),
    pool.query(`SELECT * FROM growth_opportunities WHERE application_id=$1 ORDER BY created_at DESC`, [applicationId]),
    pool.query(`SELECT * FROM growth_plans WHERE application_id=$1`, [applicationId]),
    pool.query(`SELECT * FROM growth_progress_updates WHERE application_id=$1 ORDER BY created_at DESC`, [applicationId]),
    pool.query(`SELECT * FROM growth_outcomes WHERE application_id=$1`, [applicationId]),
    pool.query(`SELECT * FROM growth_application_entity_links WHERE application_id=$1 ORDER BY created_at DESC`, [applicationId]),
    pool.query(`SELECT * FROM growth_application_field_reopens WHERE application_id=$1 ORDER BY opened_at DESC`, [applicationId]),
    pool.query(`SELECT * FROM growth_status_history WHERE application_id=$1 ORDER BY created_at DESC`, [applicationId]),
  ]);
  let growthPlan = plan.rows[0] || null;
  if (growthPlan) {
    const items = await pool.query(`SELECT * FROM growth_plan_items WHERE plan_id=$1 ORDER BY display_order,id`, [growthPlan.id]);
    growthPlan = { ...growthPlan, items: items.rows };
  }
  const detail = {
    application: a.rows[0], answers, informationRequests: requests.rows,
    assessment: assessment.rows[0] || null, priorities: priorities.rows, opportunities: opportunities.rows,
    growthPlan, progress: progress.rows, outcome: outcome.rows[0] || null,
    entityLinks: links.rows, reopenedFields: reopens.rows, statusHistory: history.rows,
  };
  if (includeSensitive) {
    const legacy = await pool.query(
      `SELECT quick_profile,growth_assessment,deep_discovery_individual,deep_discovery_business,
              brand_style_images,applicant_team_images
         FROM growth_applications WHERE id=$1`, [applicationId]);
    const uploads = await pool.query(
      `SELECT id,application_id,field_key,original_filename,mime_type,size_bytes,confidential,
              external_sharing_allowed,created_at FROM growth_uploads WHERE application_id=$1 ORDER BY created_at DESC`,
      [applicationId]);
    detail.legacyPayload = legacy.rows[0] || null;
    detail.uploads = uploads.rows;
  }
  return detail;
}

// ----- Master form builder -----
router.get('/form', async (req, res, next) => {
  try {
    const form = await getMaster();
    if (!form) return res.status(404).json({ error: 'Master Growth Application form not found.' });
    const versions = await pool.query(
      `SELECT id,version_number,status,title,intro_text,consent_text,created_at,published_at,retired_at
         FROM growth_form_versions WHERE form_id=$1 ORDER BY version_number DESC`, [form.id]);
    return res.json({ form, versions: versions.rows });
  } catch (e) { return next(e); }
});

router.get('/versions/:id', async (req, res, next) => {
  const versionId = asId(req.params.id);
  if (!versionId) return res.status(400).json({ error: 'Invalid version id.' });
  try {
    const v = await versionTree(versionId, false);
    return v ? res.json({ version: v }) : res.status(404).json({ error: 'Version not found.' });
  } catch (e) { return next(e); }
});

router.get('/versions/:id/sensitive', async (req, res, next) => {
  const versionId = asId(req.params.id);
  if (!versionId) return res.status(400).json({ error: 'Invalid version id.' });
  try {
    const v = await versionTree(versionId, true);
    return v ? res.json({ version: v }) : res.status(404).json({ error: 'Version not found.' });
  } catch (e) { return next(e); }
});

router.post('/form/versions', async (req, res, next) => {
  const sourceId = asId(req.body?.sourceVersionId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const form = await getMaster(client, true);
    if (!form) throw new Error('Master Growth Application form not found.');
    const n = await client.query(`SELECT COALESCE(MAX(version_number),0)+1 AS n FROM growth_form_versions WHERE form_id=$1`, [form.id]);
    const created = await client.query(
      `INSERT INTO growth_form_versions(form_id,version_number,status,title,intro_text,consent_text,created_by)
       VALUES($1,$2,'draft',$3,$4,$5,$6) RETURNING *`,
      [form.id,n.rows[0].n,str(req.body?.title)||`Growth Application v${n.rows[0].n}`,
        str(req.body?.introText)||null,str(req.body?.consentText)||null,req.user.id]);
    if (sourceId) {
      const source = await client.query(`SELECT 1 FROM growth_form_versions WHERE id=$1 AND form_id=$2`, [sourceId,form.id]);
      if (!source.rowCount) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Invalid source version.' }); }
      const oldSteps = await client.query(`SELECT * FROM growth_form_steps WHERE version_id=$1 ORDER BY display_order,id`, [sourceId]);
      for (const s of oldSteps.rows) {
        const ns = await client.query(
          `INSERT INTO growth_form_steps(version_id,step_key,title,description,display_order,is_enabled)
           VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
          [created.rows[0].id,s.step_key,s.title,s.description,s.display_order,s.is_enabled]);
        const oldFields = await client.query(`SELECT * FROM growth_form_fields WHERE step_id=$1 ORDER BY display_order,id`, [s.id]);
        for (const f of oldFields.rows) {
          const nf = await client.query(
            `INSERT INTO growth_form_fields(version_id,step_id,field_key,label,help_text,placeholder,field_type,display_order,
               is_required,is_enabled,sensitive,sensitive_enabled,confidential,allow_external_sharing,applicant_types,validation_rules,visibility_rules)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb) RETURNING id`,
            [created.rows[0].id,ns.rows[0].id,f.field_key,f.label,f.help_text,f.placeholder,f.field_type,f.display_order,
              f.is_required,f.is_enabled,f.sensitive,f.sensitive_enabled,f.confidential,f.allow_external_sharing,
              JSON.stringify(f.applicant_types),JSON.stringify(f.validation_rules),JSON.stringify(f.visibility_rules)]);
          await client.query(
            `INSERT INTO growth_form_field_options(field_id,option_value,option_label,display_order,is_enabled)
             SELECT $1,option_value,option_label,display_order,is_enabled FROM growth_form_field_options WHERE field_id=$2`,
            [nf.rows[0].id,f.id]);
        }
      }
    }
    await client.query('COMMIT');
    return res.status(201).json({ version: created.rows[0] });
  } catch (e) { await client.query('ROLLBACK'); return next(e); }
  finally { client.release(); }
});

router.patch('/versions/:id', async (req, res, next) => {
  const versionId = asId(req.params.id);
  if (!versionId) return res.status(400).json({ error: 'Invalid version id.' });
  try {
    const current = await pool.query(`SELECT * FROM growth_form_versions WHERE id=$1`, [versionId]);
    if (!current.rowCount) return res.status(404).json({ error: 'Version not found.' });
    if (current.rows[0].status !== 'draft') return res.status(409).json({ error: 'Published or retired versions are immutable. Create a new draft version to make changes.' });
    const c = current.rows[0];
    const r = await pool.query(
      `UPDATE growth_form_versions SET title=$2,intro_text=$3,consent_text=$4 WHERE id=$1 RETURNING *`,
      [versionId,has(req.body,'title')?(str(req.body.title)||c.title):c.title,
        has(req.body,'introText')?(str(req.body.introText)||null):c.intro_text,
        has(req.body,'consentText')?(str(req.body.consentText)||null):c.consent_text]);
    return res.json({ version: r.rows[0] });
  } catch (e) { return next(e); }
});

router.post('/versions/:id/steps', async (req, res, next) => {
  const versionId=asId(req.params.id), title=str(req.body?.title);
  const key=str(req.body?.stepKey).toLowerCase().replace(/[^a-z0-9_]+/g,'_').replace(/^_+|_+$/g,'');
  if(!versionId||!title||!key)return res.status(400).json({error:'stepKey and title are required.'});
  try{
    const r=await pool.query(`INSERT INTO growth_form_steps(version_id,step_key,title,description,display_order,is_enabled)
      SELECT $1,$2,$3,$4,$5,$6 WHERE EXISTS(SELECT 1 FROM growth_form_versions WHERE id=$1 AND status='draft') RETURNING *`,
      [versionId,key,title,str(req.body?.description)||null,Number.isInteger(req.body?.displayOrder)?req.body.displayOrder:0,req.body?.enabled!==false]);
    return r.rowCount?res.status(201).json({step:r.rows[0]}):res.status(409).json({error:'Only draft versions can be edited.'});
  }catch(e){return next(e);}
});

router.patch('/steps/:id', async (req, res, next) => {
  const stepId=asId(req.params.id); if(!stepId)return res.status(400).json({error:'Invalid step id.'});
  try{
    const c=await pool.query(`SELECT s.*,v.status AS version_status FROM growth_form_steps s JOIN growth_form_versions v ON v.id=s.version_id WHERE s.id=$1`,[stepId]);
    if(!c.rowCount)return res.status(404).json({error:'Step not found.'});
    if(c.rows[0].version_status!=='draft')return res.status(409).json({error:'Only draft versions can be edited.'});
    const s=c.rows[0];
    const r=await pool.query(`UPDATE growth_form_steps SET title=$2,description=$3,display_order=$4,is_enabled=$5 WHERE id=$1 RETURNING *`,[
      stepId,has(req.body,'title')?(str(req.body.title)||s.title):s.title,
      has(req.body,'description')?(str(req.body.description)||null):s.description,
      Number.isInteger(req.body?.displayOrder)?req.body.displayOrder:s.display_order,
      typeof req.body?.enabled==='boolean'?req.body.enabled:s.is_enabled]);
    return res.json({step:r.rows[0]});
  }catch(e){return next(e);}
});

router.post('/steps/:id/fields', async (req,res,next)=>{
  const stepId=asId(req.params.id), label=str(req.body?.label), type=str(req.body?.fieldType);
  const key=str(req.body?.fieldKey).toLowerCase().replace(/[^a-z0-9_]+/g,'_').replace(/^_+|_+$/g,'');
  if(!stepId||!label||!key||!FIELD_TYPES.has(type))return res.status(400).json({error:'fieldKey, label and valid fieldType are required.'});
  const sensitive=req.body?.sensitive===true, sensitiveEnabled=sensitive&&req.body?.sensitiveEnabled===true;
  const enabled=sensitive&&!sensitiveEnabled?false:req.body?.enabled!==false;
  const types=arr(req.body?.applicantTypes).filter(x=>['individual','business'].includes(x)); if(!types.length)types.push('individual','business');
  try{
    const r=await pool.query(`INSERT INTO growth_form_fields(version_id,step_id,field_key,label,help_text,placeholder,field_type,display_order,
      is_required,is_enabled,sensitive,sensitive_enabled,confidential,allow_external_sharing,applicant_types,validation_rules,visibility_rules)
      SELECT s.version_id,s.id,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16::jsonb
      FROM growth_form_steps s JOIN growth_form_versions v ON v.id=s.version_id WHERE s.id=$1 AND v.status='draft' RETURNING *`,
      [stepId,key,label,str(req.body?.helpText)||null,str(req.body?.placeholder)||null,type,
        Number.isInteger(req.body?.displayOrder)?req.body.displayOrder:0,req.body?.required===true,enabled,sensitive,sensitiveEnabled,
        req.body?.confidential===true,req.body?.allowExternalSharing===true,JSON.stringify(types),JSON.stringify(obj(req.body?.validationRules)),JSON.stringify(obj(req.body?.visibilityRules))]);
    return r.rowCount?res.status(201).json({field:r.rows[0]}):res.status(409).json({error:'Only draft versions can be edited.'});
  }catch(e){return next(e);}
});

router.patch('/fields/:id', async (req,res,next)=>{
  const fieldId=asId(req.params.id); if(!fieldId)return res.status(400).json({error:'Invalid field id.'});
  try{
    const c=await pool.query(`SELECT f.*,v.status AS version_status FROM growth_form_fields f JOIN growth_form_versions v ON v.id=f.version_id WHERE f.id=$1`,[fieldId]);
    if(!c.rowCount)return res.status(404).json({error:'Field not found.'});
    const f=c.rows[0]; if(f.version_status!=='draft')return res.status(409).json({error:'Published fields are immutable. Create a new draft version.'});
    const type=has(req.body,'fieldType')?str(req.body.fieldType):f.field_type;if(!FIELD_TYPES.has(type))return res.status(400).json({error:'Invalid field type.'});
    const sensitive=typeof req.body?.sensitive==='boolean'?req.body.sensitive:f.sensitive;
    const sensitiveEnabled=sensitive?(typeof req.body?.sensitiveEnabled==='boolean'?req.body.sensitiveEnabled:f.sensitive_enabled):false;
    let enabled=typeof req.body?.enabled==='boolean'?req.body.enabled:f.is_enabled;if(sensitive&&!sensitiveEnabled)enabled=false;
    let applicantTypes=f.applicant_types;if(has(req.body,'applicantTypes')){applicantTypes=arr(req.body.applicantTypes).filter(x=>['individual','business'].includes(x));if(!applicantTypes.length)return res.status(400).json({error:'At least one applicant type is required.'});}
    const r=await pool.query(`UPDATE growth_form_fields SET label=$2,help_text=$3,placeholder=$4,field_type=$5,display_order=$6,
      is_required=$7,is_enabled=$8,sensitive=$9,sensitive_enabled=$10,confidential=$11,allow_external_sharing=$12,
      applicant_types=$13::jsonb,validation_rules=$14::jsonb,visibility_rules=$15::jsonb WHERE id=$1 RETURNING *`,[
      fieldId,has(req.body,'label')?(str(req.body.label)||f.label):f.label,
      has(req.body,'helpText')?(str(req.body.helpText)||null):f.help_text,
      has(req.body,'placeholder')?(str(req.body.placeholder)||null):f.placeholder,type,
      Number.isInteger(req.body?.displayOrder)?req.body.displayOrder:f.display_order,
      typeof req.body?.required==='boolean'?req.body.required:f.is_required,enabled,sensitive,sensitiveEnabled,
      typeof req.body?.confidential==='boolean'?req.body.confidential:f.confidential,
      typeof req.body?.allowExternalSharing==='boolean'?req.body.allowExternalSharing:f.allow_external_sharing,
      JSON.stringify(applicantTypes),JSON.stringify(has(req.body,'validationRules')?obj(req.body.validationRules):f.validation_rules),
      JSON.stringify(has(req.body,'visibilityRules')?obj(req.body.visibilityRules):f.visibility_rules)]);
    return res.json({field:r.rows[0]});
  }catch(e){return next(e);}
});

router.post('/fields/:id/options', async(req,res,next)=>{
  const fieldId=asId(req.params.id),value=str(req.body?.value),label=str(req.body?.label);
  if(!fieldId||!value||!label)return res.status(400).json({error:'value and label are required.'});
  try{const r=await pool.query(`INSERT INTO growth_form_field_options(field_id,option_value,option_label,display_order,is_enabled)
    SELECT f.id,$2,$3,$4,$5 FROM growth_form_fields f JOIN growth_form_versions v ON v.id=f.version_id
    WHERE f.id=$1 AND v.status='draft' RETURNING *`,[fieldId,value,label,Number.isInteger(req.body?.displayOrder)?req.body.displayOrder:0,req.body?.enabled!==false]);
    return r.rowCount?res.status(201).json({option:r.rows[0]}):res.status(409).json({error:'Only draft fields can be edited.'});
  }catch(e){return next(e);}
});

router.patch('/options/:id', async(req,res,next)=>{
  const optionId=asId(req.params.id);if(!optionId)return res.status(400).json({error:'Invalid option id.'});
  try{
    const c=await pool.query(`SELECT o.*,v.status AS version_status FROM growth_form_field_options o JOIN growth_form_fields f ON f.id=o.field_id JOIN growth_form_versions v ON v.id=f.version_id WHERE o.id=$1`,[optionId]);
    if(!c.rowCount)return res.status(404).json({error:'Option not found.'});const o=c.rows[0];if(o.version_status!=='draft')return res.status(409).json({error:'Only draft options can be edited.'});
    const r=await pool.query(`UPDATE growth_form_field_options SET option_value=$2,option_label=$3,display_order=$4,is_enabled=$5 WHERE id=$1 RETURNING *`,[
      optionId,has(req.body,'value')?(str(req.body.value)||o.option_value):o.option_value,
      has(req.body,'label')?(str(req.body.label)||o.option_label):o.option_label,
      Number.isInteger(req.body?.displayOrder)?req.body.displayOrder:o.display_order,
      typeof req.body?.enabled==='boolean'?req.body.enabled:o.is_enabled]);return res.json({option:r.rows[0]});
  }catch(e){return next(e);}
});

router.post('/versions/:id/publish', async(req,res,next)=>{
  const versionId=asId(req.params.id); if(!versionId)return res.status(400).json({error:'Invalid version id.'});
  const client=await pool.connect();
  try{await client.query('BEGIN');const v=await client.query(`SELECT * FROM growth_form_versions WHERE id=$1 FOR UPDATE`,[versionId]);
    if(!v.rowCount||v.rows[0].status!=='draft'){await client.query('ROLLBACK');return res.status(409).json({error:'Only a draft version can be published.'});}
    const c=await client.query(`SELECT COUNT(DISTINCT s.id)::int AS steps,COUNT(f.id)::int AS fields FROM growth_form_steps s
      LEFT JOIN growth_form_fields f ON f.step_id=s.id AND f.is_enabled=true WHERE s.version_id=$1 AND s.is_enabled=true`,[versionId]);
    if(!c.rows[0].steps||!c.rows[0].fields){await client.query('ROLLBACK');return res.status(400).json({error:'At least one enabled step and field are required.'});}
    await client.query(`UPDATE growth_form_versions SET status='retired',retired_at=now() WHERE form_id=$1 AND status='published'`,[v.rows[0].form_id]);
    const p=await client.query(`UPDATE growth_form_versions SET status='published',published_at=now(),published_by=$2 WHERE id=$1 RETURNING *`,[versionId,req.user.id]);
    await client.query('COMMIT');return res.json({version:p.rows[0]});
  }catch(e){await client.query('ROLLBACK');return next(e);}finally{client.release();}
});

// ----- Application review -----
router.get('/applications', async(req,res,next)=>{
  try{const requested=str(req.query.status).split(',').filter(x=>STATUSES.has(x));const params=[];let where='';
    if(requested.length){params.push(requested);where=`WHERE a.status=ANY($1::text[])`;}
    const r=await pool.query(`SELECT a.id,a.user_id,a.applicant_email,a.applicant_type,a.status,a.completion_percent,
      a.submitted_at,a.withdrawn_at,a.created_at,a.updated_at,u.email AS member_email
      FROM growth_applications a LEFT JOIN users u ON u.id=a.user_id ${where} ORDER BY a.updated_at DESC LIMIT 250`,params);
    return res.json({applications:r.rows});
  }catch(e){return next(e);}
});

router.get('/applications/:id',async(req,res,next)=>{
  const applicationId=asId(req.params.id);if(!applicationId)return res.status(400).json({error:'Invalid application id.'});
  try{const d=await adminDetail(applicationId,false);return d?res.json(d):res.status(404).json({error:'Growth Application not found.'});}catch(e){return next(e);}
});

router.get('/applications/:id/sensitive',async(req,res,next)=>{
  const applicationId=asId(req.params.id);if(!applicationId)return res.status(400).json({error:'Invalid application id.'});
  try{const d=await adminDetail(applicationId,true);return d?res.json(d):res.status(404).json({error:'Growth Application not found.'});}catch(e){return next(e);}
});

router.post('/applications/:id/status',async(req,res,next)=>{
  const applicationId=asId(req.params.id),to=str(req.body?.status);if(!applicationId||!STATUSES.has(to))return res.status(400).json({error:'Valid status required.'});
  const client=await pool.connect();try{await client.query('BEGIN');const old=await client.query(`SELECT status FROM growth_applications WHERE id=$1 FOR UPDATE`,[applicationId]);
    if(!old.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Growth Application not found.'});}
    await client.query(`UPDATE growth_applications SET status=$2,closed_at=CASE WHEN $2 IN('completed','closed') THEN now() ELSE closed_at END,updated_at=now() WHERE id=$1`,[applicationId,to]);
    await client.query(`INSERT INTO growth_status_history(application_id,from_status,to_status,changed_by,note) VALUES($1,$2,$3,$4,$5)`,[applicationId,old.rows[0].status,to,req.user.id,str(req.body?.note)||null]);
    await client.query('COMMIT');return res.json({application:{id:applicationId,status:to}});
  }catch(e){await client.query('ROLLBACK');return next(e);}finally{client.release();}
});

router.post('/applications/:id/reopen-field',async(req,res,next)=>{
  const applicationId=asId(req.params.id),fieldKey=str(req.body?.fieldKey);if(!applicationId||!fieldKey)return res.status(400).json({error:'fieldKey is required.'});
  try{const valid=await pool.query(`SELECT 1 FROM growth_applications a JOIN growth_form_fields f ON f.version_id=a.form_version_id WHERE a.id=$1 AND f.field_key=$2`,[applicationId,fieldKey]);if(!valid.rowCount)return res.status(400).json({error:'Field does not belong to this application.'});
    const already=await pool.query(`SELECT id FROM growth_application_field_reopens WHERE application_id=$1 AND field_key=$2 AND closed_at IS NULL`,[applicationId,fieldKey]);
    if(already.rowCount)return res.json({reopen:{id:already.rows[0].id,application_id:applicationId,field_key:fieldKey,already_open:true}});
    const r=await pool.query(`INSERT INTO growth_application_field_reopens(application_id,field_key,reason,opened_by) VALUES($1,$2,$3,$4) RETURNING *`,[applicationId,fieldKey,str(req.body?.reason)||null,req.user.id]);return res.status(201).json({reopen:r.rows[0]});
  }catch(e){return next(e);}
});

router.post('/applications/:id/information-requests',async(req,res,next)=>{
  const applicationId=asId(req.params.id),requestText=str(req.body?.requestText);if(!applicationId||!requestText)return res.status(400).json({error:'requestText is required.'});
  const client=await pool.connect();try{await client.query('BEGIN');const a=await client.query(`SELECT status FROM growth_applications WHERE id=$1 FOR UPDATE`,[applicationId]);if(!a.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Growth Application not found.'});}
    const r=await client.query(`INSERT INTO growth_information_requests(application_id,request_text,requested_fields,requested_by) VALUES($1,$2,$3::jsonb,$4) RETURNING *`,[applicationId,requestText,JSON.stringify(arr(req.body?.requestedFields)),req.user.id]);
    if(!['withdrawn','completed','closed'].includes(a.rows[0].status)){await client.query(`UPDATE growth_applications SET status='information_requested',updated_at=now() WHERE id=$1`,[applicationId]);await client.query(`INSERT INTO growth_status_history(application_id,from_status,to_status,changed_by,note) VALUES($1,$2,'information_requested',$3,'Additional information requested')`,[applicationId,a.rows[0].status,req.user.id]);}
    await client.query('COMMIT');return res.status(201).json({request:r.rows[0]});
  }catch(e){await client.query('ROLLBACK');return next(e);}finally{client.release();}
});

router.patch('/information-requests/:id',async(req,res,next)=>{
  const requestId=asId(req.params.id),status=str(req.body?.status);if(!requestId||!['closed','cancelled'].includes(status))return res.status(400).json({error:'status must be closed or cancelled.'});
  try{const r=await pool.query(`UPDATE growth_information_requests SET status=$2,closed_at=CASE WHEN $2='closed' THEN now() ELSE closed_at END WHERE id=$1 RETURNING *`,[requestId,status]);return r.rowCount?res.json({request:r.rows[0]}):res.status(404).json({error:'Information request not found.'});}catch(e){return next(e);}
});

router.put('/applications/:id/assessment',async(req,res,next)=>{
  const applicationId=asId(req.params.id);if(!applicationId)return res.status(400).json({error:'Invalid application id.'});
  const names=['readinessScore','credibilityScore','exposureScore','opportunityScore','growthScore'];const scores=names.map(k=>req.body?.[k]==null?null:Number(req.body[k]));if(scores.some(x=>x!=null&&(!Number.isFinite(x)||x<0||x>100)))return res.status(400).json({error:'Scores must be between 0 and 100.'});
  try{const r=await pool.query(`INSERT INTO growth_assessments(application_id,strengths,challenges,readiness_score,credibility_score,exposure_score,opportunity_score,growth_score,internal_notes,assessed_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(application_id) DO UPDATE SET strengths=EXCLUDED.strengths,challenges=EXCLUDED.challenges,readiness_score=EXCLUDED.readiness_score,credibility_score=EXCLUDED.credibility_score,exposure_score=EXCLUDED.exposure_score,opportunity_score=EXCLUDED.opportunity_score,growth_score=EXCLUDED.growth_score,internal_notes=EXCLUDED.internal_notes,assessed_by=EXCLUDED.assessed_by,updated_at=now() RETURNING *`,
    [applicationId,str(req.body?.strengths)||null,str(req.body?.challenges)||null,...scores,str(req.body?.internalNotes)||null,req.user.id]);return res.json({assessment:r.rows[0]});}catch(e){return next(e);}
});

router.post('/applications/:id/priorities',async(req,res,next)=>{
  const applicationId=asId(req.params.id),title=str(req.body?.title);if(!applicationId||!title)return res.status(400).json({error:'title required.'});
  try{const r=await pool.query(`INSERT INTO growth_priorities(application_id,title,detail,priority_order,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *`,[applicationId,title,str(req.body?.detail)||null,Number.isInteger(req.body?.priorityOrder)?req.body.priorityOrder:0,req.user.id]);return res.status(201).json({priority:r.rows[0]});}catch(e){return next(e);}
});

router.patch('/priorities/:id',async(req,res,next)=>{
  const priorityId=asId(req.params.id);if(!priorityId)return res.status(400).json({error:'Invalid priority id.'});
  try{const c=await pool.query(`SELECT * FROM growth_priorities WHERE id=$1`,[priorityId]);if(!c.rowCount)return res.status(404).json({error:'Priority not found.'});const p=c.rows[0];const status=has(req.body,'status')?str(req.body.status):p.status;if(!PRIORITY_STATUSES.has(status))return res.status(400).json({error:'Invalid priority status.'});
    const r=await pool.query(`UPDATE growth_priorities SET title=$2,detail=$3,priority_order=$4,status=$5,updated_at=now() WHERE id=$1 RETURNING *`,[priorityId,has(req.body,'title')?(str(req.body.title)||p.title):p.title,has(req.body,'detail')?(str(req.body.detail)||null):p.detail,Number.isInteger(req.body?.priorityOrder)?req.body.priorityOrder:p.priority_order,status]);return res.json({priority:r.rows[0]});}catch(e){return next(e);}
});

router.post('/applications/:id/opportunities',async(req,res,next)=>{
  const applicationId=asId(req.params.id),title=str(req.body?.title);if(!applicationId||!title)return res.status(400).json({error:'title required.'});
  try{const r=await pool.query(`INSERT INTO growth_opportunities(application_id,title,detail,opportunity_type,internal_only,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[applicationId,title,str(req.body?.detail)||null,str(req.body?.opportunityType)||null,req.body?.internalOnly!==false,req.user.id]);return res.status(201).json({opportunity:r.rows[0]});}catch(e){return next(e);}
});

router.patch('/opportunities/:id',async(req,res,next)=>{
  const opportunityId=asId(req.params.id);if(!opportunityId)return res.status(400).json({error:'Invalid opportunity id.'});
  try{const c=await pool.query(`SELECT * FROM growth_opportunities WHERE id=$1`,[opportunityId]);if(!c.rowCount)return res.status(404).json({error:'Opportunity not found.'});const o=c.rows[0];const status=has(req.body,'status')?str(req.body.status):o.status;if(!OPPORTUNITY_STATUSES.has(status))return res.status(400).json({error:'Invalid opportunity status.'});
    const r=await pool.query(`UPDATE growth_opportunities SET title=$2,detail=$3,opportunity_type=$4,internal_only=$5,status=$6,updated_at=now() WHERE id=$1 RETURNING *`,[opportunityId,has(req.body,'title')?(str(req.body.title)||o.title):o.title,has(req.body,'detail')?(str(req.body.detail)||null):o.detail,has(req.body,'opportunityType')?(str(req.body.opportunityType)||null):o.opportunity_type,typeof req.body?.internalOnly==='boolean'?req.body.internalOnly:o.internal_only,status]);return res.json({opportunity:r.rows[0]});}catch(e){return next(e);}
});

router.put('/applications/:id/growth-plan',async(req,res,next)=>{
  const applicationId=asId(req.params.id);if(!applicationId)return res.status(400).json({error:'Invalid application id.'});const status=PLAN_STATUSES.has(req.body?.status)?req.body.status:'draft';
  try{const r=await pool.query(`INSERT INTO growth_plans(application_id,objective,strategy,internal_notes,status,review_at,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$7)
    ON CONFLICT(application_id) DO UPDATE SET objective=EXCLUDED.objective,strategy=EXCLUDED.strategy,internal_notes=EXCLUDED.internal_notes,status=EXCLUDED.status,review_at=EXCLUDED.review_at,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,[applicationId,str(req.body?.objective)||null,str(req.body?.strategy)||null,str(req.body?.internalNotes)||null,status,req.body?.reviewAt||null,req.user.id]);return res.json({growthPlan:r.rows[0]});}catch(e){return next(e);}
});

router.post('/growth-plans/:id/items',async(req,res,next)=>{
  const planId=asId(req.params.id),title=str(req.body?.title);if(!planId||!title)return res.status(400).json({error:'title required.'});
  try{const r=await pool.query(`INSERT INTO growth_plan_items(plan_id,title,description,owner_user_id,due_date,display_order,status) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[planId,title,str(req.body?.description)||null,asId(req.body?.ownerUserId),req.body?.dueDate||null,Number.isInteger(req.body?.displayOrder)?req.body.displayOrder:0,PLAN_ITEM_STATUSES.has(req.body?.status)?req.body.status:'not_started']);return res.status(201).json({item:r.rows[0]});}catch(e){return next(e);}
});

router.patch('/growth-plan-items/:id',async(req,res,next)=>{
  const itemId=asId(req.params.id);if(!itemId)return res.status(400).json({error:'Invalid item id.'});
  try{const c=await pool.query(`SELECT * FROM growth_plan_items WHERE id=$1`,[itemId]);if(!c.rowCount)return res.status(404).json({error:'Plan item not found.'});const i=c.rows[0];const status=has(req.body,'status')?str(req.body.status):i.status;if(!PLAN_ITEM_STATUSES.has(status))return res.status(400).json({error:'Invalid item status.'});
    const r=await pool.query(`UPDATE growth_plan_items SET title=$2,description=$3,owner_user_id=$4,due_date=$5,display_order=$6,status=$7,updated_at=now() WHERE id=$1 RETURNING *`,[itemId,has(req.body,'title')?(str(req.body.title)||i.title):i.title,has(req.body,'description')?(str(req.body.description)||null):i.description,has(req.body,'ownerUserId')?asId(req.body.ownerUserId):i.owner_user_id,has(req.body,'dueDate')?(req.body.dueDate||null):i.due_date,Number.isInteger(req.body?.displayOrder)?req.body.displayOrder:i.display_order,status]);return res.json({item:r.rows[0]});}catch(e){return next(e);}
});

router.post('/applications/:id/progress',async(req,res,next)=>{
  const applicationId=asId(req.params.id),updateText=str(req.body?.updateText);if(!applicationId||!updateText)return res.status(400).json({error:'updateText required.'});
  try{const r=await pool.query(`INSERT INTO growth_progress_updates(application_id,update_text,internal_only,created_by) VALUES($1,$2,$3,$4) RETURNING *`,[applicationId,updateText,req.body?.internalOnly!==false,req.user.id]);return res.status(201).json({progress:r.rows[0]});}catch(e){return next(e);}
});

router.put('/applications/:id/outcome',async(req,res,next)=>{
  const applicationId=asId(req.params.id);if(!applicationId)return res.status(400).json({error:'Invalid application id.'});
  try{const r=await pool.query(`INSERT INTO growth_outcomes(application_id,outcome_summary,outcome_code,future_review_at,internal_notes,closed_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(application_id) DO UPDATE SET outcome_summary=EXCLUDED.outcome_summary,outcome_code=EXCLUDED.outcome_code,future_review_at=EXCLUDED.future_review_at,internal_notes=EXCLUDED.internal_notes,closed_by=EXCLUDED.closed_by,updated_at=now() RETURNING *`,[applicationId,str(req.body?.summary)||null,str(req.body?.code)||null,req.body?.futureReviewAt||null,str(req.body?.internalNotes)||null,req.user.id]);return res.json({outcome:r.rows[0]});}catch(e){return next(e);}
});

router.post('/applications/:id/entity-links',async(req,res,next)=>{
  const applicationId=asId(req.params.id),entityType=str(req.body?.entityType),entityId=str(req.body?.entityId);if(!applicationId||!ENTITY_TYPES.has(entityType)||!entityId)return res.status(400).json({error:'Valid entityType and entityId required.'});
  try{const r=await pool.query(`INSERT INTO growth_application_entity_links(application_id,entity_type,entity_id,relationship,created_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(application_id,entity_type,entity_id) DO UPDATE SET relationship=EXCLUDED.relationship RETURNING *`,[applicationId,entityType,entityId,str(req.body?.relationship)||null,req.user.id]);return res.status(201).json({link:r.rows[0]});}catch(e){return next(e);}
});

module.exports = router;
