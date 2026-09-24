const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectPages = [
  path.join(__dirname, '..', 'frontend', 'project.html'),
  path.join(__dirname, '..', 'frontend', 'frontend', 'project.html')
];

const expectedStatuses = [
  ['init', '预项目'],
  ['executing', '进行中'],
  ['completed', '已完成'],
  ['paused', '暂停'],
  ['cancelled', '取消']
];

for (const pagePath of projectPages) {
  const source = fs.readFileSync(pagePath, 'utf8');

  for (const [value, label] of expectedStatuses) {
    assert.match(
      source,
      new RegExp(`${value}:['"]${label}['"]`),
      `${pagePath} must map ${value} to ${label}`
    );
  }

  assert.match(
    source,
    /\['status','状态','select:init,executing,completed,paused,cancelled'\]/,
    `${pagePath} must keep encoded status values in the project form`
  );
  assert.match(
    source,
    /\$\{statusMap\[o\]\|\|o\}<\/option>/,
    `${pagePath} must render mapped labels in generic select fields`
  );
  assert.match(
    source,
    /statusMap\[o\]\|\|o\|\|'--'/,
    `${pagePath} must render mapped labels in inline status editing`
  );
}

console.log('project status regression checks passed');
