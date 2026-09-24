const fs = require('node:fs');
const path = require('node:path');

const frontendRoot = path.resolve(__dirname, '..', 'frontend');
const sourceExtensions = new Set(['.html', '.js', '.css']);
const decorativeSymbols = new Set([
  0x2715, 0x2716, 0x26a0, 0x2699, 0x2315, 0x25c9, 0x25cc, 0x25b6, 0x25c0,
  0x2191, 0x2193, 0x2605, 0x2606, 0x2661, 0x2665, 0x2663, 0x2666, 0x2660,
  0x2726, 0x2713, 0x2714, 0x23fb, 0x2304, 0x25bc, 0x2611, 0x2717, 0x26d4,
  0x23e9, 0x1f534, 0x27a1, 0x00b7
].map((code) => String.fromCodePoint(code)));
const legacyClassPattern = /(?:class\s*=\s*["'][^"']*(?:(?<=["'])|(?<=\s))(?:icon|kpi-ico|tab-icon)(?=\s|["'])|(?:^|[\s,{>+~])\.(?:icon|kpi-ico|tab-icon)(?![A-Za-z0-9_-]))/gm;
const iconButtonPattern = /<button\b([^>]*)>/gi;
const iconClassPattern = /(?:ebms-icon-btn|data-icon\s*=)/i;
const iconSizePattern = /(?:^|[.#\s])(?:icon|kpi-ico|tab-icon)(?![A-Za-z0-9_-])[^{}\n]*\{[^}\n]*font-size\s*:\s*(\d+)px/gi;

function isEmojiCodePoint(code) {
  return (code >= 0x1f000 && code <= 0x1faff) ||
    (code >= 0x2600 && code <= 0x27ff) ||
    (code >= 0x2300 && code <= 0x23ff && code !== 0x2328);
}

function lineColumn(source, index) {
  const before = source.slice(0, index);
  const line = before.split('\n').length;
  const lastBreak = before.lastIndexOf('\n');
  return { line, column: index - lastBreak };
}

function addFinding(findings, source, file, index, kind, message) {
  const pos = lineColumn(source, index);
  const lineText = source.split('\n')[pos.line - 1].trim().slice(0, 180);
  findings.push({ file, line: pos.line, column: pos.column, kind, message, snippet: lineText });
}

function analyzeSource(source, file) {
  const findings = [];
  const filename = file || 'inline';
  Array.from(source).forEach((char, index) => {
    const code = char.codePointAt(0);
    if (isEmojiCodePoint(code)) addFinding(findings, source, filename, index, 'emoji', 'emoji character');
    if (decorativeSymbols.has(char)) addFinding(findings, source, filename, index, 'decorative-unicode', 'decorative Unicode symbol');
  });
  const entityPattern = /&#(?:x([0-9a-f]+)|([0-9]+));/gi;
  let match;
  while ((match = entityPattern.exec(source))) {
    const code = parseInt(match[1] || match[2], match[1] ? 16 : 10);
    if (isEmojiCodePoint(code)) addFinding(findings, source, filename, match.index, 'emoji-entity', 'emoji HTML entity');
    if (decorativeSymbols.has(String.fromCodePoint(code))) addFinding(findings, source, filename, match.index, 'decorative-unicode', 'decorative Unicode entity');
  }
  while ((match = legacyClassPattern.exec(source))) addFinding(findings, source, filename, match.index, 'legacy-class', 'legacy icon class');
  while ((match = iconSizePattern.exec(source))) addFinding(findings, source, filename, match.index, 'icon-size', 'non-tokenized icon font size: ' + match[1] + 'px');
  while ((match = iconButtonPattern.exec(source))) {
    const attrs = match[1] || '';
    if (iconClassPattern.test(attrs) && !/\baria-label\s*=/.test(attrs)) addFinding(findings, source, filename, match.index, 'missing-aria-label', 'icon button needs aria-label');
  }
  return findings;
}

function walk(dir, results) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'frontend') return;
      walk(absolute, results);
      return;
    }
    if (!sourceExtensions.has(path.extname(entry.name).toLowerCase()) || entry.name === 'icons.js') return;
    const relative = path.relative(path.resolve(__dirname, '..'), absolute);
    results.push(...analyzeSource(fs.readFileSync(absolute, 'utf8'), relative));
  });
}

function auditTree(root) {
  const findings = [];
  walk(root || frontendRoot, findings);
  return findings;
}

if (require.main === module) {
  const findings = auditTree(frontendRoot);
  if (!findings.length) {
    console.log('Icon audit passed: no forbidden emoji, decorative Unicode, legacy icon class, icon size, or missing aria-label found.');
    process.exit(0);
  }
  console.error('Icon audit failed: ' + findings.length + ' finding(s).');
  findings.forEach((finding) => console.error(finding.file + ':' + finding.line + ':' + finding.column + ' [' + finding.kind + '] ' + finding.message + ' :: ' + finding.snippet));
  process.exit(1);
}

module.exports = { analyzeSource, auditTree };
