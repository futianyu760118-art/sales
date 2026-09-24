const assert = require('node:assert/strict');
const { analyzeSource } = require('./audit-icons');
const icons = require('../frontend/icons.js');

function hasKind(findings, kind) {
  return findings.some((finding) => finding.kind === kind);
}

assert.equal(hasKind(analyzeSource('<span>\u{1F4CA}</span>', 'fixture.html'), 'emoji'), true);
assert.equal(hasKind(analyzeSource('<span>&#128202;</span>', 'fixture.html'), 'emoji-entity'), true);
assert.equal(hasKind(analyzeSource('<span>\u2726</span>', 'fixture.html'), 'decorative-unicode'), true);
assert.equal(hasKind(analyzeSource('<div class="kpi-ico">x</div>', 'fixture.html'), 'legacy-class'), true);
assert.equal(hasKind(analyzeSource('<button class="ebms-icon-btn">x</button>', 'fixture.html'), 'missing-aria-label'), true);
assert.equal(hasKind(analyzeSource('<button class="ebms-icon-btn" aria-label="通知">x</button>', 'fixture.html'), 'missing-aria-label'), false);

const svg = icons.render('home', { size: 'md', decorative: true });
assert.match(svg, /^<svg /);
assert.match(svg, /class="ebms-icon ebms-icon--md"/);
assert.match(svg, /aria-hidden="true"/);
assert.match(svg, /viewBox="0 0 24 24"/);
assert.equal(icons.tokens.md, '20px');
assert.match(icons.render('not-registered'), /data-icon="empty"/);

console.log('audit-icons.test.js: all assertions passed');
