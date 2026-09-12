const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EmbeddedPostgres = require('embedded-postgres').default;
const { stopPostgres } = require('./helpers/stopPostgres');
const jwt = require('jsonwebtoken');

let pg, pool, server, baseUrl;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-agreement-approved-version-'));
const port = 24700 + (process.pid % 250);
const adminId = 19601;

async function req(method, p, body) {
  const response = await fetch(baseUrl + p, {
    method,
    headers: { 'Content-Type':'application/json', Authorization:'Bearer ' + jwt.sign({id:adminId,email:'approved-version@test.com',role:'admin'}, process.env.JWT_SECRET) },
    ...(body !== undefined ? { body:JSON.stringify(body) } : {}),
  });
  return { status:response.status, body:await response.json().catch(()=>({})) };
}

before(async () => {
  pg = new EmbeddedPostgres({ databaseDir:dataDir,user:'postgres',password:'postgres',port,persistent:false,initdbFlags:['--encoding=UTF8','--locale=C'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('unplug_test');
  process.env.DATABASE_URL=`postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET='approved-version-test-secret'; process.env.NODE_ENV='test'; process.env.SITE_URL='https://example.test';
  const { Pool }=require('pg'); pool=new Pool({connectionString:process.env.DATABASE_URL});
  const migrations=fs.readdirSync(path.join(__dirname,'..','db','migrations')).filter(x=>x.endsWith('.sql')).sort();
  for(const file of migrations) await pool.query(fs.readFileSync(path.join(__dirname,'..','db','migrations',file),'utf8'));
  await pool.query(`INSERT INTO users(id,email,password_hash,role) VALUES($1,'approved-version@test.com','x','admin')`,[adminId]);
  const express=require('express'),{attachUser}=require('../src/middleware/auth'); const app=express(); app.set('trust proxy',1); app.use(express.json()); app.use(attachUser); app.use('/agreement-forms',require('../src/middleware/agreementPaymentPolicy')); app.use('/agreement-forms',require('../src/routes/agreementForms').router); app.use((err,_req,res,_next)=>res.status(err.statusCode||500).json({error:err.message}));
  await new Promise(resolve=>{server=app.listen(0,resolve)}); baseUrl=`http://127.0.0.1:${server.address().port}`;
}, { timeout:120000 });

after(async()=>{if(server)await new Promise(r=>server.close(r));if(pool)await pool.end();await stopPostgres(pg,dataDir);fs.rmSync(dataDir,{recursive:true,force:true});});

test('new agreements continue using latest approved immutable version while a newer version is Draft', async () => {
  const created=await req('POST','/agreement-forms/generator/admin/templates',{name:'Approved Version Continuity',title:'Approved Version Continuity',signerType:'individual',notificationConfig:{recipients:[]}});
  assert.equal(created.status,201,JSON.stringify(created.body)); const id=created.body.form.id;
  let r=await req('POST',`/agreement-forms/generator/admin/templates/${id}/fields`,{key:'scope_name',label:'Scope name',kind:'text',required:true,sectionKey:'scope',partyScope:'agreement'}); assert.equal(r.status,201,JSON.stringify(r.body));
  r=await req('POST',`/agreement-forms/generator/admin/templates/${id}/approval`,{status:'legal_review'}); assert.equal(r.status,200,JSON.stringify(r.body));
  r=await req('POST',`/agreement-forms/generator/admin/templates/${id}/approval`,{status:'approved'}); assert.equal(r.status,200,JSON.stringify(r.body)); const approvedVersion=r.body.template.version;

  const first=await req('POST','/agreement-forms/generator/admin/agreements',{templateId:id,partyBType:'individual'}); assert.equal(first.status,201,JSON.stringify(first.body)); assert.equal(first.body.agreement.agreement_version,approvedVersion);

  const edited=await req('PATCH',`/agreement-forms/generator/admin/templates/${id}`,{description:'Unapproved work in progress'}); assert.equal(edited.status,200,JSON.stringify(edited.body)); assert.equal(edited.body.template.approval_status,'draft'); assert.ok(edited.body.template.version>approvedVersion);

  const second=await req('POST','/agreement-forms/generator/admin/agreements',{templateId:id,partyBType:'individual'}); assert.equal(second.status,201,JSON.stringify(second.body)); assert.equal(second.body.agreement.agreement_version,approvedVersion,'new agreement must stay on the latest approved version');
  assert.notEqual(second.body.agreement.agreement_version,edited.body.template.version,'draft version must never leak into a new agreement');
});
