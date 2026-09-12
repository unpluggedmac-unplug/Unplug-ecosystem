const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildCorsOrigin, isImmutableStagingPreview } = require('../src/utils/corsOrigin');

function decision(policy, origin) {
  return new Promise((resolve, reject) => {
    policy(origin, (err, allowed) => err ? reject(err) : resolve(allowed));
  });
}

test('staging accepts the exact immutable Cloudflare candidate origin', async () => {
  const policy = buildCorsOrigin('https://unplug-staging.pages.dev', {
    nodeEnv: 'production',
    unplugEnv: 'staging',
  });

  assert.equal(await decision(policy, 'https://41688b56.unplug-staging.pages.dev'), true);
  assert.equal(await decision(policy, 'https://unplug-staging.pages.dev'), true);
});

test('the staging preview allowance is restricted to the immutable project host', () => {
  assert.equal(isImmutableStagingPreview('https://41688b56.unplug-staging.pages.dev'), true);
  assert.equal(isImmutableStagingPreview('http://41688b56.unplug-staging.pages.dev'), false);
  assert.equal(isImmutableStagingPreview('https://branch-name.unplug-staging.pages.dev'), false);
  assert.equal(isImmutableStagingPreview('https://41688b56.unplug-magazine.pages.dev'), false);
  assert.equal(isImmutableStagingPreview('https://41688b56.unplug-staging.pages.dev.evil.example'), false);
  assert.equal(isImmutableStagingPreview('https://41688b56.unplug-staging.pages.dev:444'), false);
});

test('production remains exact-origin only', async () => {
  const policy = buildCorsOrigin('https://www.unplugnews.com', {
    nodeEnv: 'production',
    unplugEnv: 'production',
  });

  assert.equal(await decision(policy, 'https://www.unplugnews.com'), true);
  assert.equal(await decision(policy, 'https://41688b56.unplug-staging.pages.dev'), false);
  assert.equal(await decision(policy, 'https://evil.example'), false);
});

test('a missing production allow-list still fails closed', () => {
  assert.equal(buildCorsOrigin('', { nodeEnv: 'production', unplugEnv: 'production' }), false);
  assert.equal(buildCorsOrigin('', { nodeEnv: 'development', unplugEnv: 'development' }), true);
});
