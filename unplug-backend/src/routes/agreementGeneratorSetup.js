const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const G = require('../utils/agreementGenerator');

const router = express.Router();

function slugify(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '').slice(0, 100);
}

async function availableSlug(base, client) {
  const root = slugify(base) || `agreement-${Date.now()}`;
  let slug = root;
  for (let n = 2; ; n += 1) {
    const found = await client.query('SELECT 1 FROM agreement_forms WHERE LOWER(slug)=LOWER($1)', [slug]);
    if (!found.rowCount) return slug;
    slug = slugify(`${root}-${n}`);
  }
}

router.get('/generator/admin/presets', requireRole('admin'), async (req, res, next) => {
  try {
    const templates = await pool.query('SELECT * FROM agreement_templates ORDER BY is_builtin DESC,name');
    for (const template of templates.rows) {
      const fields = await pool.query('SELECT * FROM template_fields WHERE template_id=$1 ORDER BY position,id', [template.id]);
      template.fields = fields.rows;
    }
    res.json({ presets: templates.rows });
  } catch (err) { next(err); }
});

router.post('/generator/admin/templates', requireRole('admin'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const presetId = Number(req.body.presetId);
    let preset = null;
    if (Number.isInteger(presetId)) {
      const p = await client.query('SELECT * FROM agreement_templates WHERE id=$1', [presetId]);
      preset = p.rows[0] || null;
      if (!preset) throw Object.assign(new Error('Preset template not found.'), { statusCode: 404 });
    }
    const name = G.trim(req.body.name, 160) || (preset && preset.name) || 'Custom Agreement';
    const title = G.trim(req.body.title, 220) || (preset && preset.title) || name;
    const slug = await availableSlug(req.body.slug || name, client);
    const signerType = ['individual','business','choice'].includes(req.body.signerType)
      ? req.body.signerType : ((preset && preset.signer_type) || 'choice');
    const r = await client.query(
      `INSERT INTO agreement_forms
       (template_id,name,slug,title,description,category,signer_type,rules,terms,
        post_signing_requirements,amount,payment_mode,min_age,require_witness,
        require_company_stamp,how_it_works,reminder_days,created_by,status,published,
        approval_status,access_method,signing_order,delivery_config,notification_config,declarations)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'draft',false,
              'draft',$19,$20,$21,$22,$23)
       RETURNING *`,
      [preset && preset.id, name, slug, title,
       req.body.description !== undefined ? G.trim(req.body.description,10000) : (preset && preset.description),
       req.body.category !== undefined ? G.trim(req.body.category,120) : (preset && preset.category), signerType,
       req.body.rules !== undefined ? G.trim(req.body.rules,100000) : (preset && preset.rules),
       req.body.terms !== undefined ? G.trim(req.body.terms,100000) : (preset && preset.terms),
       req.body.postSigningRequirements !== undefined ? G.trim(req.body.postSigningRequirements,30000) : (preset && preset.post_signing_requirements),
       req.body.amount !== undefined ? (req.body.amount === '' || req.body.amount === null ? null : Math.max(0,Number(req.body.amount)||0)) : (preset && preset.amount),
       ['none','before_sign','after_sign'].includes(req.body.paymentMode) ? req.body.paymentMode : ((preset && preset.payment_mode) || 'none'),
       req.body.minAge !== undefined ? (req.body.minAge === '' || req.body.minAge === null ? null : Math.max(0,Number(req.body.minAge)||0)) : (preset && preset.min_age),
       req.body.requireWitness !== undefined ? !!req.body.requireWitness : !!(preset && preset.require_witness),
       req.body.requireCompanyStamp !== undefined ? !!req.body.requireCompanyStamp : !!(preset && preset.require_company_stamp),
       JSON.stringify(Array.isArray(req.body.howItWorks) ? req.body.howItWorks : (preset && Array.isArray(preset.how_it_works) ? preset.how_it_works : [])),
       req.body.reminderDays === undefined ? (preset && preset.reminder_days) : (req.body.reminderDays === '' || req.body.reminderDays === null ? null : Math.max(0,Number(req.body.reminderDays)||0)),
       req.user.id,
       G.ACCESS_METHODS.includes(req.body.accessMethod) ? req.body.accessMethod : 'private_link',
       G.SIGNING_ORDERS.includes(req.body.signingOrder) ? req.body.signingOrder : 'party_b_first',
       JSON.stringify(G.safeJson(req.body.deliveryConfig,{ save_notify_unplug:true,email_party_b:false,allow_download:true,manual_download_email:false })),
       JSON.stringify(G.safeJson(req.body.notificationConfig,{ recipients:['info@unplugnews.com'],reminders:[] })),
       JSON.stringify(Array.isArray(req.body.declarations) ? req.body.declarations : [])]
    );
    const form = r.rows[0];
    if (preset) {
      await client.query(
        `INSERT INTO agreement_fields
         (agreement_id,position,kind,field_key,label,placeholder,help,required,options,max_length,
          section_key,party_scope,condition_json,config,sensitive_type,popia_enabled,popia_purpose,
          popia_retention,popia_access,popia_ack_required)
         SELECT $1,position,kind,field_key,label,placeholder,help,required,options,max_length,
          section_key,party_scope,condition_json,config,sensitive_type,popia_enabled,popia_purpose,
          popia_retention,popia_access,popia_ack_required
         FROM template_fields WHERE template_id=$2 ORDER BY position,id`,
        [form.id,preset.id]
      );
    }
    await G.audit({ agreementId:form.id, action:'template_created', toStatus:'draft',
      details:{ presetId:preset && preset.id,presetName:preset && preset.name }, req, client });
    await client.query('COMMIT');
    const definition = await G.getFormDefinition(form.id);
    res.status(201).json(definition);
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    if (err.statusCode) return res.status(err.statusCode).json({ error:err.message });
    if (err.code === '23505') return res.status(409).json({ error:'An agreement template already uses that name or address.' });
    next(err);
  } finally { client.release(); }
});

router.post('/generator/admin/templates/:id/duplicate', requireRole('admin'), async (req,res,next)=>{
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const source=await G.getFormDefinition(req.params.id,client);
    if(!source){await client.query('ROLLBACK');return res.status(404).json({error:'Agreement template not found.'});}
    const name=G.trim(req.body.name,160)||`${source.form.name} — Copy`;
    const slug=await availableSlug(req.body.slug||`${source.form.slug}-copy`,client);
    const r=await client.query(`INSERT INTO agreement_forms
      (template_id,name,slug,title,description,category,signer_type,rules,terms,post_signing_requirements,version,status,published,
       opens_at,closes_at,min_age,require_witness,require_company_stamp,public_pages,service_scope,service_name,service_description,
       service_reference,client_name,amount,payment_mode,how_it_works,reminder_days,created_by,approval_status,access_method,signing_order,
       delivery_config,notification_config,declarations,member_visible,button_label)
      SELECT template_id,$2,$3,title,description,category,signer_type,rules,terms,post_signing_requirements,1,'draft',false,
       NULL,NULL,min_age,require_witness,require_company_stamp,'[]'::jsonb,service_scope,service_name,service_description,
       service_reference,client_name,amount,payment_mode,how_it_works,reminder_days,$4,'draft',access_method,signing_order,
       delivery_config,notification_config,declarations,false,button_label FROM agreement_forms WHERE id=$1 RETURNING *`,
      [source.form.id,name,slug,req.user.id]);
    const copy=r.rows[0];
    await client.query(`INSERT INTO agreement_fields
      (agreement_id,position,kind,field_key,label,placeholder,help,required,options,max_length,section_key,party_scope,condition_json,config,
       sensitive_type,popia_enabled,popia_purpose,popia_retention,popia_access,popia_ack_required)
      SELECT $1,position,kind,field_key,label,placeholder,help,required,options,max_length,section_key,party_scope,condition_json,config,
       sensitive_type,popia_enabled,popia_purpose,popia_retention,popia_access,popia_ack_required
      FROM agreement_fields WHERE agreement_id=$2 ORDER BY position,id`,[copy.id,source.form.id]);
    await client.query(`INSERT INTO agreement_form_clauses(agreement_id,clause_block_id,position,title,body_html,condition_json,excluded)
      SELECT $1,clause_block_id,position,title,body_html,condition_json,excluded FROM agreement_form_clauses WHERE agreement_id=$2 ORDER BY position,id`,[copy.id,source.form.id]);
    await client.query(`INSERT INTO agreement_form_items(agreement_id,position,kind,label,help,visibility,required,condition_json)
      SELECT $1,position,kind,label,help,visibility,required,condition_json FROM agreement_form_items WHERE agreement_id=$2 ORDER BY position,id`,[copy.id,source.form.id]);
    await G.audit({agreementId:copy.id,action:'template_duplicated',toStatus:'draft',details:{sourceAgreementId:source.form.id},req,client});
    await client.query('COMMIT');
    res.status(201).json(await G.getFormDefinition(copy.id));
  } catch(err) { await client.query('ROLLBACK').catch(()=>{}); next(err); }
  finally { client.release(); }
});

module.exports = router;
