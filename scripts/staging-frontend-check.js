#!/usr/bin/env node
const fs = require('fs');
const pages = ['index.html','unplug-magazine.html','unplug-admin-dashboard.html','unplug-member-dashboard.html','unplug-checkout.html','unplug-vote.html','offline.html'];
let bad = false;
for (const page of pages) {
  const text = fs.readFileSync(page,'utf8');
  if (!text.includes('src="/runtime-config"')) { console.error('FAIL '+page+' missing /runtime-config'); bad=true; }
  else console.log('OK   '+page+' loads runtime config');
}
const fn=fs.readFileSync('functions/runtime-config.js','utf8');
if (!fn.includes('staging-api-not-configured.invalid')) { console.error('FAIL runtime config does not fail closed for staging'); bad=true; }
else console.log('OK   runtime config fails closed when staging API is missing');
if (!fn.includes('staging-control-centre.unplug-magazine.pages.dev')) { console.error('FAIL runtime config does not recognize the deployed staging Pages alias'); bad=true; }
else console.log('OK   runtime config recognizes deployed staging Pages alias');
process.exit(bad?1:0);
