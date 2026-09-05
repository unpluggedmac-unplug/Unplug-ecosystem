// Object storage: Cloudflare R2 swap-in ahead of Supabase Storage.
//
// R2 has no egress fees, unlike Supabase — exceeding Supabase's is exactly
// what took production uploads down (the "misconfigured" error a real admin
// hit; see the storage-audit tool, N-3). R2 is now tried FIRST for every new
// upload; Supabase Storage stays as an automatic fallback, so nothing breaks
// before R2 is configured, and files already sitting on Supabase keep working
// through the same fetchFromSupabasePrivate/isPublicStorageUrl paths as before.
//
// No real network calls are made here. S3Client.prototype.send is stubbed
// (a real prototype method, easily overridable — see AWS SDK v3 base client).
// Presigning (getSignedUrl) is exercised for REAL — it's pure local HMAC
// computation, no network call — with the resulting fetch() intercepted
// instead of actually sent, so fake credentials are fine.
//
// Requires uploads.js FRESH per test (clearing require.cache): its "is X
// configured" booleans are computed once at module load from process.env,
// so this is the only way to exercise every env-var combination.
//
// Run with: npm test (from unplug-backend/)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { S3Client } = require('@aws-sdk/client-s3');

const UPLOADS_PATH = require.resolve('../src/routes/uploads');

const ENV_KEYS = [
  'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_URL', 'R2_PRIVATE_BUCKET',
  'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'SUPABASE_BUCKET', 'SUPABASE_PRIVATE_BUCKET',
];

// Requires uploads.js with EXACTLY the given env vars set (every other key
// in ENV_KEYS cleared first), then restores whatever was there before.
function freshUploads(env) {
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  delete require.cache[UPLOADS_PATH];
  const mod = require('../src/routes/uploads');
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  return mod;
}

const R2_ENV = {
  R2_ACCOUNT_ID: 'acct123', R2_ACCESS_KEY_ID: 'AKIA_FAKE', R2_SECRET_ACCESS_KEY: 'secret_fake',
  R2_BUCKET: 'uploads', R2_PUBLIC_URL: 'https://pub-fake.r2.dev',
};
const SUPABASE_ENV = {
  SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_SERVICE_KEY: 'svc_fake', SUPABASE_BUCKET: 'uploads',
};

// ---------------------------------------------------------------- detection

test('ALL FIVE R2 VARS PRESENT: r2Configured is true, and widens supabaseConfigured with zero Supabase vars set', () => {
  const mod = freshUploads(R2_ENV);
  assert.equal(mod.r2Configured, true);
  assert.equal(mod.supabaseConfigured, true, 'the widened flag must read true from R2 alone');
});

test('MISSING R2_PUBLIC_URL: r2Configured is false — there would be no public URL to hand back', () => {
  const { R2_PUBLIC_URL, ...rest } = R2_ENV;
  const mod = freshUploads(rest);
  assert.equal(mod.r2Configured, false);
});

test('R2_ACCOUNT_ID/KEY/SECRET ALONE (no bucket/public-url): r2PrivateConfigured is true, r2Configured is false', () => {
  const mod = freshUploads({ R2_ACCOUNT_ID: 'acct123', R2_ACCESS_KEY_ID: 'AKIA_FAKE', R2_SECRET_ACCESS_KEY: 'secret_fake' });
  assert.equal(mod.r2PrivateConfigured, true);
  assert.equal(mod.r2Configured, false);
});

test('NEITHER R2 NOR SUPABASE CONFIGURED: both widened flags are false', () => {
  const mod = freshUploads({});
  assert.equal(mod.supabaseConfigured, false);
  assert.equal(mod.supabasePrivateConfigured, false);
});

// ----------------------------------------------------------- public uploads

test('putPublicObject uploads to R2 and returns the R2 public URL, when R2 is configured', async (t) => {
  const mod = freshUploads(R2_ENV);
  let capturedInput = null;
  t.mock.method(S3Client.prototype, 'send', async (command) => { capturedInput = command.input; return {}; });

  const url = await mod.putPublicObject('123-photo.jpg', Buffer.from('hello'), 'image/jpeg');

  assert.equal(url, 'https://pub-fake.r2.dev/123-photo.jpg');
  assert.equal(capturedInput.Bucket, 'uploads');
  assert.equal(capturedInput.Key, '123-photo.jpg');
  assert.equal(capturedInput.ContentType, 'image/jpeg');
  assert.match(capturedInput.CacheControl, /immutable/);
});

test('putPublicObject FALLS BACK to Supabase when only Supabase is configured (R2 absent) — the non-breaking guarantee', async (t) => {
  const mod = freshUploads(SUPABASE_ENV);
  let capturedUrl = null;
  t.mock.method(global, 'fetch', async (url) => { capturedUrl = url; return { ok: true, text: async () => '' }; });

  const url = await mod.putPublicObject('123-photo.jpg', Buffer.from('hi'), 'image/jpeg');

  assert.equal(capturedUrl, 'https://fake.supabase.co/storage/v1/object/uploads/123-photo.jpg');
  assert.equal(url, 'https://fake.supabase.co/storage/v1/object/public/uploads/123-photo.jpg');
});

test('putPublicObject PREFERS R2 over Supabase when both are configured', async (t) => {
  const mod = freshUploads({ ...R2_ENV, ...SUPABASE_ENV });
  let s3Called = false, fetchCalled = false;
  t.mock.method(S3Client.prototype, 'send', async () => { s3Called = true; return {}; });
  t.mock.method(global, 'fetch', async () => { fetchCalled = true; return { ok: true, text: async () => '' }; });

  await mod.putPublicObject('x.jpg', Buffer.from('x'), 'image/jpeg');

  assert.equal(s3Called, true, 'R2 must be tried');
  assert.equal(fetchCalled, false, 'Supabase must not be touched when R2 succeeds');
});

test('putPublicObject refuses when no object storage is configured at all', async () => {
  const mod = freshUploads({});
  await assert.rejects(
    () => mod.putPublicObject('x.jpg', Buffer.from('x'), 'image/jpeg'),
    /No public object storage is configured/
  );
});

// ---------------------------------------------------------- private uploads

test('uploadBufferToSupabasePrivate uploads to the R2 PRIVATE bucket, returning a non-public object path', async (t) => {
  const mod = freshUploads({ R2_ACCOUNT_ID: 'acct123', R2_ACCESS_KEY_ID: 'AKIA_FAKE', R2_SECRET_ACCESS_KEY: 'secret_fake' });
  let capturedInput = null;
  t.mock.method(S3Client.prototype, 'send', async (command) => { capturedInput = command.input; return {}; });

  const url = await mod.uploadBufferToSupabasePrivate(Buffer.from('pdf-bytes'), 'invoice.pdf', 'application/pdf');

  assert.equal(capturedInput.Bucket, 'edition-downloads', 'default R2_PRIVATE_BUCKET');
  assert.match(url, /^https:\/\/acct123\.r2\.cloudflarestorage\.com\/edition-downloads\//);
  assert.equal(mod.isPublicStorageUrl(url), false, 'a private-bucket URL must never read as public');
});

test('a private upload refuses when no object storage is configured at all', async () => {
  const mod = freshUploads({});
  await assert.rejects(
    () => mod.uploadBufferToSupabasePrivate(Buffer.from('x'), 'f.pdf', 'application/pdf'),
    /No private object storage is configured/
  );
});

// --------------------------------------------------------- reading it back

test('fetchFromSupabasePrivate SIGNS A PRESIGNED GET for an R2 URL, rather than sending Supabase headers', async (t) => {
  const mod = freshUploads({ R2_ACCOUNT_ID: 'acct123', R2_ACCESS_KEY_ID: 'AKIA_FAKE', R2_SECRET_ACCESS_KEY: 'secret_fake' });
  let capturedUrl = null, capturedInit;
  t.mock.method(global, 'fetch', async (url, init) => { capturedUrl = url; capturedInit = init; return { ok: true }; });

  const privateUrl = 'https://acct123.r2.cloudflarestorage.com/edition-downloads/999-invoice.pdf';
  await mod.fetchFromSupabasePrivate(privateUrl);

  assert.match(capturedUrl, /^https:\/\/acct123\.r2\.cloudflarestorage\.com\/edition-downloads\/999-invoice\.pdf\?/,
    'must presign the SAME host and key, not redirect anywhere else');
  assert.match(capturedUrl, /X-Amz-Signature=/);
  assert.equal(capturedInit, undefined, 'a presigned URL carries its own auth in the query string — no extra headers needed');
});

test('fetchFromSupabasePrivate STILL sends Supabase auth headers for a pre-existing Supabase URL', async (t) => {
  const mod = freshUploads(SUPABASE_ENV);
  let capturedUrl = null, capturedInit = null;
  t.mock.method(global, 'fetch', async (url, init) => { capturedUrl = url; capturedInit = init; return { ok: true }; });

  const oldUrl = 'https://fake.supabase.co/storage/v1/object/edition-downloads/111-old.pdf';
  await mod.fetchFromSupabasePrivate(oldUrl);

  assert.equal(capturedUrl, oldUrl, 'an old Supabase file must be fetched from exactly where it already lives');
  assert.equal(capturedInit.headers.apikey, 'svc_fake');
});

// ------------------------------------------------------- public URL sensing

test('isPublicStorageUrl recognizes BOTH a Supabase public URL and an R2 public URL', () => {
  const mod = freshUploads({ R2_PUBLIC_URL: 'https://pub-fake.r2.dev' });
  assert.equal(mod.isPublicStorageUrl('https://x.supabase.co/storage/v1/object/public/uploads/a.jpg'), true);
  assert.equal(mod.isPublicStorageUrl('https://pub-fake.r2.dev/a.jpg'), true);
  assert.equal(mod.isPublicStorageUrl('https://x.supabase.co/storage/v1/object/edition-downloads/a.pdf'), false,
    'a PRIVATE Supabase path must not read as public');
  assert.equal(mod.isPublicStorageUrl(null), false);
  assert.equal(mod.isPublicStorageUrl(undefined), false);
});
