// Object storage: Cloudflare R2, the only backend this project uses.
//
// R2 has no egress fees — exceeding a similar quota on the previous
// Supabase-backed storage is exactly what took production uploads down (the
// storage-audit tool, N-3, exists to find what's left of that migration).
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

// ---------------------------------------------------------------- detection

test('ALL FIVE R2 VARS PRESENT: r2Configured is true', () => {
  const mod = freshUploads(R2_ENV);
  assert.equal(mod.r2Configured, true);
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

test('NEITHER SET: both flags are false', () => {
  const mod = freshUploads({});
  assert.equal(mod.r2Configured, false);
  assert.equal(mod.r2PrivateConfigured, false);
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

test('putPublicObject refuses when no object storage is configured at all', async () => {
  const mod = freshUploads({});
  await assert.rejects(
    () => mod.putPublicObject('x.jpg', Buffer.from('x'), 'image/jpeg'),
    /No public object storage is configured/
  );
});

// ---------------------------------------------------------- private uploads

test('uploadPrivateBuffer uploads to the R2 PRIVATE bucket, returning a non-public object path', async (t) => {
  const mod = freshUploads({ R2_ACCOUNT_ID: 'acct123', R2_ACCESS_KEY_ID: 'AKIA_FAKE', R2_SECRET_ACCESS_KEY: 'secret_fake' });
  let capturedInput = null;
  t.mock.method(S3Client.prototype, 'send', async (command) => { capturedInput = command.input; return {}; });

  const url = await mod.uploadPrivateBuffer(Buffer.from('pdf-bytes'), 'invoice.pdf', 'application/pdf');

  assert.equal(capturedInput.Bucket, 'edition-downloads', 'default R2_PRIVATE_BUCKET');
  assert.match(url, /^https:\/\/acct123\.r2\.cloudflarestorage\.com\/edition-downloads\//);
  assert.equal(mod.isPublicStorageUrl(url), false, 'a private-bucket URL must never read as public');
});

test('a private upload refuses when no object storage is configured at all', async () => {
  const mod = freshUploads({});
  await assert.rejects(
    () => mod.uploadPrivateBuffer(Buffer.from('x'), 'f.pdf', 'application/pdf'),
    /No private object storage is configured/
  );
});

// --------------------------------------------------------- reading it back

test('fetchPrivateObject SIGNS A PRESIGNED GET for an R2 URL', async (t) => {
  const mod = freshUploads({ R2_ACCOUNT_ID: 'acct123', R2_ACCESS_KEY_ID: 'AKIA_FAKE', R2_SECRET_ACCESS_KEY: 'secret_fake' });
  let capturedUrl = null, capturedInit;
  t.mock.method(global, 'fetch', async (url, init) => { capturedUrl = url; capturedInit = init; return { ok: true }; });

  const privateUrl = 'https://acct123.r2.cloudflarestorage.com/edition-downloads/999-invoice.pdf';
  await mod.fetchPrivateObject(privateUrl);

  assert.match(capturedUrl, /^https:\/\/acct123\.r2\.cloudflarestorage\.com\/edition-downloads\/999-invoice\.pdf\?/,
    'must presign the SAME host and key, not redirect anywhere else');
  assert.match(capturedUrl, /X-Amz-Signature=/);
  assert.equal(capturedInit, undefined, 'a presigned URL carries its own auth in the query string — no extra headers needed');
});

test('fetchPrivateObject rejects a URL that is not a recognised private object URL', async () => {
  const mod = freshUploads({ R2_ACCOUNT_ID: 'acct123', R2_ACCESS_KEY_ID: 'AKIA_FAKE', R2_SECRET_ACCESS_KEY: 'secret_fake' });
  await assert.rejects(
    () => mod.fetchPrivateObject('https://pub-fake.r2.dev/some-public-file.jpg'),
    /Not a recognised private object URL/
  );
});

// ------------------------------------------------------- public URL sensing

test('isPublicStorageUrl recognizes an R2 public URL and rejects everything else', () => {
  const mod = freshUploads({ R2_PUBLIC_URL: 'https://pub-fake.r2.dev' });
  assert.equal(mod.isPublicStorageUrl('https://pub-fake.r2.dev/a.jpg'), true);
  assert.equal(mod.isPublicStorageUrl('https://acct123.r2.cloudflarestorage.com/edition-downloads/a.pdf'), false,
    'a PRIVATE-bucket path must not read as public');
  assert.equal(mod.isPublicStorageUrl(null), false);
  assert.equal(mod.isPublicStorageUrl(undefined), false);
});
