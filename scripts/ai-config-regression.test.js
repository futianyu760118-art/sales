const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const chatRoutePath = path.join(__dirname, '..', 'backend', 'routes', 'chat.js');
const chatSource = fs.readFileSync(chatRoutePath, 'utf8');

assert.match(
  chatSource,
  /const settingsTable = getTable\(['"]system_settings['"]\)/,
  'AI chat must read the system_settings table used by the Settings API'
);
assert.doesNotMatch(
  chatSource,
  /const settingsTable = getTable\(['"]settings['"]\)/,
  'AI chat must not read the legacy settings table'
);
assert.doesNotMatch(
  chatSource,
  /import\(['"]node-fetch['"]\)/,
  'AI chat must use the runtime fetch implementation available in Node.js'
);
assert.match(
  chatSource,
  /res\.json\(\{ reply: aiReply, action_items: actionItems, model \}\)/,
  'AI chat must return the computed actionItems variable on external success'
);
assert.doesNotMatch(
  chatSource,
  /res\.json\(\{ reply: aiReply, action_items, model \}\)/,
  'AI chat must not reference an undefined action_items shorthand variable'
);

console.log('AI configuration regression checks passed');
