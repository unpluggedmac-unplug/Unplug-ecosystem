const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EmbeddedPostgres = require('embedded-postgres').default;
const { stopPostgres } = require('./helpers/stopPostgres');
const jwt = require('jsonwebtoken');

let pg, pool, server, baseUrl;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-agreement-multisigner-'));
const port = 24400 + (process.pid % 300);
const adminId = 19301;

function adminToken() {
  return jwt.sign({ id:adminId,email:'multi-admin@test.com',role:'admin' }, process.env.JWT_SECRET);
}
async function req(method, p, { token, body } = {}) {
  const r = await fetch(baseUrl + p, {
    method,
    headers:{ 'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{}) },
    ...(body!==undefined?{body:JSON.stringify(body)}:{}),
  });
  const d = await r.json().catch(()=>({}));
  return { status:r.status, body:d };
}
function tokenFromLink(link) { return new URL(link).searchParams.get('token'); }

before(async () => {
  pg = new EmbeddedPostgres({ databaseDir:dataDir,user:'postgres',password:'postgres',port,persistent:false,initdbFlags:['--encoding=UTF8','--locale=C'] });
  await pg.initialise();await pg.start();await pg.createDatabase('unplug_test');
  process.env.DATABASE_URL=`postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET='multi-signer-test-secret';
  process.env.NODE_ENV='test';
  process.env.SITE_URL='https://example.test';
  delete process.env.RESEND_API_KEY;delete process.env.BREVO_API_KEY;delete process.env.SMTP_HOST;delete process.env.SMTP_USER;delete process.env.SMTP_PASS;
  const { Pool } = require('pg');pool=new Pool({connectionString:process.env.DATABASE_URL});
  const migrations=fs.readdirSync(path.join(__dirname,'..','db','migrations')).filter(x=>x.endsWith('.sql')).sort();
  for(const file of migrations)await pool.query(fs.readFileSync(path.join(__dirname,'..','db','migrations',file),'utf8'));
  await pool.query(`INSERT INTO users(id,email,password_hash,role) VALUES($1,'multi-admin@test.com','x','admin')`,[adminId]);
  const express=require('express'),{attachUser}=require('../src/middleware/auth');const app=express();app.set('trust proxy',1);app.use(express.json({limit:'512kb'}));app.use(attachUser);app.use('/agreement-forms',require('../src/middleware/agreementPaymentPolicy'));app.use('/agreement-forms',require('../src/routes/agreementForms').router);app.use((err,_req,res,_next)=>res.status(err.statusCode||500).json({error:err.message}));
  await new Promise(resolve=>{server=app.listen(0,resolve)});baseUrl=`http://127.0.0.1:${server.address().port}`;
}, { timeout:120000 });

after(async()=>{if(server)await new Promise(r=>server.close(r));if(pool)await pool.end();await stopPostgres(pg,dataDir);fs.rmSync(dataDir,{recursive:true,force:true});});

test('two required Party B signers use separate links and cannot change content after the first signature', async () => {
  const auth=adminToken();
  const created=await req('POST','/agreement-forms/generator/admin/templates',{token:auth,body:{name:'Multi Signer Integration',title:'Multi Signer Integration',signerType:'individual',accessMethod:'private_link',signingOrder:'party_b_first',notificationConfig:{recipients:[]},deliveryConfig:{save_notify_unplug:false,email_party_b:false,allow_download:true,manual_download_email:false}}});
  assert.equal(created.status,201,JSON.stringify(created.body));const templateId=created.body.form.id;
  const field=await req('POST',`/agreement-forms/generator/admin/templates/${templateId}/fields`,{token:auth,body:{key:'project_role',label:'Project role',kind:'text',required:true,sectionKey:'agreement_specific_questions',partyScope:'agreement'}});assert.equal(field.status,201,JSON.stringify(field.body));
  let approval=await req('POST',`/agreement-forms/generator/admin/templates/${templateId}/approval`,{token:auth,body:{status:'legal_review'}});assert.equal(approval.status,200,JSON.stringify(approval.body));
  approval=await req('POST',`/agreement-forms/generator/admin/templates/${templateId}/approval`,{token:auth,body:{status:'approved'}});assert.equal(approval.status,200,JSON.stringify(approval.body));

  const made=await req('POST','/agreement-forms/generator/admin/agreements',{token:auth,body:{templateId,partyBType:'individual',partyBSigners:[
    {partyType:'individual',role:'primary',legalName:'Primary Signer',email:'primary@example.com',required:true,signOrder:1},
    {partyType:'individual',role:'witness',legalName:'Required Witness',email:'witness@example.com',required:true,signOrder:2},
  ]}});
  assert.equal(made.status,201,JSON.stringify(made.body));assert.equal(made.body.parties.length,2);assert.notEqual(made.body.parties[0].secureLink,made.body.parties[1].secureLink);
  const submissionId=made.body.agreement.id,t1=tokenFromLink(made.body.parties[0].secureLink),t2=tokenFromLink(made.body.parties[1].secureLink);

  let saved=await req('PATCH',`/agreement-forms/generator/access/${t1}/draft`,{body:{partyBType:'individual',signerName:'Primary Signer',signerEmail:'primary@example.com',answers:{project_role:'Original locked content'}}});assert.equal(saved.status,200,JSON.stringify(saved.body));
  let otp=await req('POST',`/agreement-forms/generator/access/${t1}/verify/request`,{body:{channel:'email',destination:'primary@example.com'}});assert.equal(otp.status,200,JSON.stringify(otp.body));
  let verified=await req('POST',`/agreement-forms/generator/access/${t1}/verify/confirm`,{body:{channel:'email',code:otp.body.testCode}});assert.equal(verified.status,200,JSON.stringify(verified.body));
  let signed=await req('POST',`/agreement-forms/generator/access/${t1}/submit`,{body:{signerName:'Primary Signer',signerEmail:'primary@example.com',answers:{project_role:'Original locked content'},signatureType:'typed',signatureText:'Primary Signer',declarationsAccepted:{}}});assert.equal(signed.status,200,JSON.stringify(signed.body));assert.equal(signed.body.allRequiredPartyBSigned,false);assert.equal(signed.body.status,'in_progress');

  const secondView=await req('GET',`/agreement-forms/generator/access/${t2}`);assert.equal(secondView.status,200,JSON.stringify(secondView.body));assert.equal(secondView.body.agreement.contentLocked,true);assert.equal(secondView.body.draft.answers.project_role,'Original locked content');
  const tamper=await req('PATCH',`/agreement-forms/generator/access/${t2}/draft`,{body:{answers:{project_role:'Changed after first signature'}}});assert.equal(tamper.status,423,JSON.stringify(tamper.body));

  const earlyPartyA=await req('POST',`/agreement-forms/generator/admin/agreements/${submissionId}/party-a-sign`,{token:auth,body:{name:'Party A Signer',capacity:'Authorised Representative',signatureType:'typed',signatureText:'Party A Signer'}});assert.equal(earlyPartyA.status,409,JSON.stringify(earlyPartyA.body));

  otp=await req('POST',`/agreement-forms/generator/access/${t2}/verify/request`,{body:{channel:'email',destination:'witness@example.com'}});assert.equal(otp.status,200,JSON.stringify(otp.body));
  verified=await req('POST',`/agreement-forms/generator/access/${t2}/verify/confirm`,{body:{channel:'email',code:otp.body.testCode}});assert.equal(verified.status,200,JSON.stringify(verified.body));
  signed=await req('POST',`/agreement-forms/generator/access/${t2}/submit`,{body:{signerName:'Required Witness',signerEmail:'witness@example.com',signatureType:'typed',signatureText:'Required Witness',declarationsAccepted:{}}});assert.equal(signed.status,200,JSON.stringify(signed.body));assert.equal(signed.body.allRequiredPartyBSigned,true);assert.equal(signed.body.status,'submitted');

  const row=(await pool.query('SELECT * FROM agreement_submissions WHERE id=$1',[submissionId])).rows[0];assert.ok(row.locked_at);assert.equal(row.answers.project_role,'Original locked content');
  const signatures=await pool.query(`SELECT p.role,p.legal_name,s.signature_type FROM agreement_signatures s JOIN agreement_submission_parties p ON p.id=s.party_id WHERE s.submission_id=$1 ORDER BY s.signed_at,s.id`,[submissionId]);assert.equal(signatures.rowCount,2);assert.deepEqual(signatures.rows.map(x=>x.role),['primary','witness']);

  const partyA=await req('POST',`/agreement-forms/generator/admin/agreements/${submissionId}/party-a-sign`,{token:auth,body:{name:'Party A Signer',capacity:'Authorised Representative',signatureType:'typed',signatureText:'Party A Signer'}});assert.equal(partyA.status,200,JSON.stringify(partyA.body));
  let status=await req('POST',`/agreement-forms/generator/admin/agreements/${submissionId}/status`,{token:auth,body:{status:'under_review'}});assert.equal(status.status,200,JSON.stringify(status.body));
  status=await req('POST',`/agreement-forms/generator/admin/agreements/${submissionId}/status`,{token:auth,body:{status:'signed'}});assert.equal(status.status,200,JSON.stringify(status.body));
});
