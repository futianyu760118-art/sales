const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'icons.js'), 'utf8');

assert.match(
  source,
  /querySelectorAll\('\[data-icon\]:not\(\[data-icon-mounted\]\):not\(svg\)'\)/,
  'icon mounting must exclude rendered SVG nodes from mount targets'
);
assert.match(
  source,
  /node\.matches\('\[data-icon\]:not\(\[data-icon-mounted\]\):not\(svg\)'\)/,
  'icon mutation handling must ignore rendered SVG nodes'
);

console.log('Icon mount recursion regression checks passed');
