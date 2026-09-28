// My Votes / Competition Activity — normal individual voting only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EmbeddedPostgres = require('embedded-postgres').default;
const { stopPostgres } = require('./helpers/stopPostgres');
const { ensureStopWords } = require('./helpers/textSearch');

let pg, pool, server, baseUrl, tokenMine, tokenOther, competitionId, entryProfileId, entryManualId;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-myvotes-'));
const port = 53200 + (process.pid % 300);
const ME = 970501, OTHER = 970502;

async function api(urlPath, tok) {
  const res = await fetch(baseUrl + urlPath, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} });
  return { status: res.status, body: await res.json().catch(() => null) };
}

before(async () => {
  ensureStopWords();
  pg = new EmbeddedPostgres({ databaseDir: dataDir, user:'postgres', password:'postgres', port, persistent:false, initdbFlags:['--encoding=UTF8','--locale=C'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('unplug_test');
  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-my-votes';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.sql')).sort()) await pool.query(fs.readFileSync(path.join(dir,f),'utf8'));

  const jwt = require('jsonwebtoken');
  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express(); app.use(express.json()); app.use(attachUser); app.use('/my', require('../src/routes/mySubmissions'));
  await new Promise(resolve => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(`INSERT INTO users (id,email,full_name,password_hash,role)
    VALUES ($1,'me@vote.test','Me','x','member'),($2,'other@vote.test','Other','x','member')`, [ME,OTHER]);
  tokenMine = jwt.sign({id:ME,email:'me@vote.test',role:'member'}, process.env.JWT_SECRET);
  tokenOther = jwt.sign({id:OTHER,email:'other@vote.test',role:'member'}, process.env.JWT_SECRET);

  const comp = await pool.query(`INSERT INTO competitions (name,slug,opens_at,closes_at,status)
    VALUES ('Best of 2026','best-2026',now()-interval '1 day',now()+interval '30 days','open') RETURNING id`);
  competitionId = comp.rows[0].id;
  const prof = await pool.query(`INSERT INTO profiles (user_id,display_name,slug,package_tier,status)
    VALUES ($1,'Naledi Dlamini','naledi','basic','approved') RETURNING id`, [OTHER]);
  entryProfileId = (await pool.query(`INSERT INTO competition_entries (competition_id,profile_id,status)
    VALUES ($1,$2,'approved') RETURNING id`, [competitionId,prof.rows[0].id])).rows[0].id;
  entryManualId = (await pool.query(`INSERT INTO competition_entries (competition_id,manual_name,status)
    VALUES ($1,'Sipho the Baker','approved') RETURNING id`, [competitionId])).rows[0].id;

  await pool.query(`INSERT INTO votes (entry_id,voter_user_id,bundle_size) VALUES ($1,$2,1),($3,$2,1)`, [entryProfileId,ME,entryManualId]);
  await pool.query(`INSERT INTO votes (entry_id,session_id,bundle_size) VALUES ($1,'guest-session-abc',1)`, [entryProfileId]);
  await pool.query(`INSERT INTO votes (entry_id,voter_user_id,bundle_size) VALUES ($1,$2,1)`, [entryManualId,OTHER]);
});

after(async () => { if(server) await new Promise(r=>server.close(r)); if(pool) await pool.end(); await stopPostgres(pg,dataDir); });

test('anonymous votes stay anonymous', async () => {
  const res = await api('/my/votes', tokenMine);
  assert.equal(res.status,200);
  assert.equal(res.body.votes.length,2);
  assert.equal('bundles' in res.body,false);
  assert.equal('totalSpent' in res.body,false);
});

test('one member activity is not another member activity', async () => {
  const res = await api('/my/votes', tokenOther);
  assert.equal(res.status,200);
  assert.equal(res.body.votes.length,1);
});

test('signed out cannot read My Votes', async () => {
  assert.equal((await api('/my/votes', null)).status,401);
});

test('member who never voted gets empty normal-vote history', async () => {
  const jwt = require('jsonwebtoken');
  await pool.query(`INSERT INTO users (id,email,full_name,password_hash,role) VALUES (970503,'quiet@vote.test','Quiet','x','member')`);
  const tok=jwt.sign({id:970503,email:'quiet@vote.test',role:'member'},process.env.JWT_SECRET);
  const res=await api('/my/votes',tok);
  assert.deepEqual(res.body.votes,[]);
  assert.equal(res.body.totalVotes,0);
});

test('normal vote totals sum bundle_size rather than row count', async () => {
  const extra=(await pool.query(`INSERT INTO competition_entries (competition_id,manual_name,status) VALUES ($1,'Favourite','approved') RETURNING id`,[competitionId])).rows[0].id;
  await pool.query(`INSERT INTO votes (entry_id,voter_user_id,bundle_size) VALUES ($1,$2,1)`,[extra,ME]);
  const res=await api('/my/votes',tokenMine);
  assert.equal(res.body.votes.length,3);
  assert.equal(res.body.totalVotes,3);
});

test('contestant names resolve for profile and manual entries', async () => {
  const res=await api('/my/votes',tokenMine);
  const names=res.body.votes.map(v=>v.contestant);
  assert.ok(names.includes('Naledi Dlamini'));
  assert.ok(names.includes('Sipho the Baker'));
});

test('normal vote history is newest first', async () => {
  const res=await api('/my/votes',tokenMine);
  const dates=res.body.votes.map(v=>new Date(v.castAt).getTime());
  assert.deepEqual(dates,[...dates].sort((a,b)=>b-a));
});
