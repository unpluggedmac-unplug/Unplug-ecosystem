// Where backups go. Local disk for testing, S3-compatible storage for real.
//
// ONE IMPLEMENTATION COVERS BOTH APPROVED PROVIDERS. Cloudflare R2 and
// Backblaze B2 both speak the S3 API, so the difference between them is an
// endpoint and a set of keys — not code. Swapping provider, or keeping a copy
// in each, is configuration.
//
// WHY SIGN THE REQUESTS BY HAND rather than install the AWS SDK. The SDK is
// tens of megabytes and pulls in a large dependency tree, on an instance with
// 512 MB that is already running a magazine. SigV4 is a published algorithm
// and the part used here — one PUT, one GET, one LIST, one DELETE — is a
// couple of dozen lines of HMAC. Getting it wrong fails loudly and safely: an
// upload is rejected, nothing is lost, and nothing is exposed.
//
// LOCAL DISK IS FOR TESTING ONLY, and says so when used. Render's filesystem
// is ephemeral: a backup written there survives until the next deploy, which
// is precisely when a backup is least likely to still be wanted and most
// likely to be needed.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// --- S3 request signing (SigV4) --------------------------------------------

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}
function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function signingKey(secret, date, region, service) {
  return hmac(hmac(hmac(hmac('AWS4' + secret, date), region), service), 'aws4_request');
}

// Builds the headers for one signed request.
//
// The payload hash is required and must be the hash of the exact bytes sent —
// this is what makes an altered upload fail rather than land corrupted.
function signRequest({ method, url, body, accessKeyId, secretAccessKey, region, service = 's3' }) {
  const u = new URL(url);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body || '');

  const headers = {
    host: u.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort()
    .map((h) => `${h}:${headers[h]}\n`).join('');

  const canonicalRequest = [
    method,
    u.pathname,
    u.searchParams.toString(),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(secretAccessKey, dateStamp, region, service), toSign).toString('hex');

  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, `
      + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// --- the providers ----------------------------------------------------------

function localProvider(directory) {
  const dir = directory || path.join(__dirname, '..', '..', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return {
    name: 'local disk',
    // Said out loud every time, because a backup on an ephemeral disk that
    // nobody realises is ephemeral is worse than no backup: it is the belief
    // in one.
    warning: 'Local disk only. Render wipes this on every deploy — configure '
           + 'R2 or B2 before relying on it.',
    async put(key, buffer) {
      const full = path.join(dir, key);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, buffer);
      return { key, bytes: buffer.length, location: full };
    },
    async get(key) {
      return fs.readFileSync(path.join(dir, key));
    },
    async list() {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir)
        .filter((f) => f.endsWith('.unplugbk'))
        .map((f) => ({ key: f, bytes: fs.statSync(path.join(dir, f)).size,
                       modified: fs.statSync(path.join(dir, f)).mtime.toISOString() }))
        .sort((a, b) => b.key.localeCompare(a.key));
    },
    async remove(key) {
      const full = path.join(dir, key);
      if (fs.existsSync(full)) fs.unlinkSync(full);
    },
  };
}

function s3Provider(config) {
  const { endpoint, bucket, accessKeyId, secretAccessKey, region = 'auto', label } = config;
  const base = `${endpoint.replace(/\/$/, '')}/${bucket}`;

  async function send(method, key, body) {
    const url = key ? `${base}/${encodeURIComponent(key).replace(/%2F/g, '/')}` : `${base}/`;
    const headers = signRequest({ method, url, body, accessKeyId, secretAccessKey, region });
    const res = await fetch(url, { method, headers, body });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`${label}: ${method} ${key || '(bucket)'} failed (${res.status}) ${detail.slice(0, 200)}`);
    }
    return res;
  }

  return {
    name: label,
    warning: null,
    async put(key, buffer) {
      await send('PUT', key, buffer);
      return { key, bytes: buffer.length, location: `${base}/${key}` };
    },
    async get(key) {
      const res = await send('GET', key);
      return Buffer.from(await res.arrayBuffer());
    },
    async list() {
      const res = await send('GET', '');
      const xml = await res.text();
      // A small parse rather than an XML library: the response shape is fixed
      // and this is the only place it is read.
      const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
      const sizes = [...xml.matchAll(/<Size>(\d+)<\/Size>/g)].map((m) => Number(m[1]));
      const dates = [...xml.matchAll(/<LastModified>([^<]+)<\/LastModified>/g)].map((m) => m[1]);
      return keys.map((k, i) => ({ key: k, bytes: sizes[i] || 0, modified: dates[i] || null }))
        .filter((x) => x.key.endsWith('.unplugbk'))
        .sort((a, b) => b.key.localeCompare(a.key));
    },
    async remove(key) {
      await send('DELETE', key);
    },
  };
}

// Every destination that is configured. More than one is not a mistake — two
// providers means a problem with one account is not a problem with the
// backups, which is the entire reason for having them.
function providers() {
  const list = [];

  if (process.env.R2_ACCESS_KEY_ID && process.env.R2_BUCKET) {
    list.push(s3Provider({
      label: 'Cloudflare R2',
      endpoint: process.env.R2_ENDPOINT
        || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      bucket: process.env.R2_BUCKET,
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      region: 'auto',
    }));
  }

  if (process.env.B2_ACCESS_KEY_ID && process.env.B2_BUCKET) {
    list.push(s3Provider({
      label: 'Backblaze B2',
      endpoint: process.env.B2_ENDPOINT,   // e.g. https://s3.eu-central-003.backblazeb2.com
      bucket: process.env.B2_BUCKET,
      accessKeyId: process.env.B2_ACCESS_KEY_ID,
      secretAccessKey: process.env.B2_SECRET_ACCESS_KEY,
      region: process.env.B2_REGION || 'us-west-004',
    }));
  }

  if (!list.length) list.push(localProvider(process.env.UNPLUG_BACKUP_DIR));
  return list;
}

module.exports = { providers, localProvider, s3Provider, signRequest };
