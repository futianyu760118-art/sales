/**
 * 修复客户附件文件名乱码（multer Latin-1 编码问题）
 *
 * 问题：上传文件时 multer/busboy 把 UTF-8 文件名字节当成 Latin-1 读取，
 *       导致中文变成 "957å®¢æ·æ¥è®ªæ¯.docx" 之类的乱码，下载后无法正确识别/打开。
 * 修复：把存储的 file_name 按 Latin-1 还原回正确的 UTF-8 中文。
 *
 * 用法：
 *   node fix-attachment-names.js          # 预览（dry-run，只显示改动，不写盘）
 *   node fix-attachment-names.js --apply  # 实际写入（自动备份原文件为 .bak）
 *
 * 同时只修复文件类附件（type=file）；链接类（type=link）名称来自文本输入不受影响。
 */
const fs = require('fs');
const path = require('path');

const dbFile = path.join(__dirname, '..', 'database', 'customer_attachments.json');
const apply = process.argv.includes('--apply');

if (!fs.existsSync(dbFile)) {
  console.error('找不到附件数据文件:', dbFile);
  process.exit(1);
}

const raw = fs.readFileSync(dbFile, 'utf8');
const j = JSON.parse(raw);

let fixed = 0, skipped = 0, missing = 0;
const report = [];

j.records.forEach(a => {
  if (a.type === 'link') { skipped++; return; }       // 链接不处理
  const orig = a.file_name || '';
  if (!orig) return;
  // 还原：UTF-8 字节被当 Latin-1 读 -> 反向解码
  let recovered;
  try { recovered = Buffer.from(orig, 'latin1').toString('utf8'); } catch (e) { return; }
  if (recovered === orig) return;                       // 无乱码，跳过
  // 校验：还原后应更"正常"（含中文或可打印字符增多，无替换符）
  if (recovered.includes('\uFFFD')) return;             // 解出替换符，放弃
  // 校验文件是否还在（顺便报告丢失的文件）
  let fileOk = true;
  if (a.file_path) fileOk = fs.existsSync(a.file_path);

  report.push({ id: a.id, from: orig, to: recovered, fileExists: fileOk });
  if (!fileOk) missing++;
  a.file_name = recovered;                              // 应用修复
  fixed++;
});

console.log('=== 附件文件名修复 ===');
console.log('总记录:', j.records.length, '| 链接(跳过):', skipped, '| 需修复:', fixed, '| 文件丢失:', missing);
report.forEach(r => {
  console.log(`  #${r.id} ${r.fileExists ? '' : '[文件丢失] '}"${r.from}"  ->  "${r.to}"`);
});

if (!apply) {
  console.log('\n(预览模式，未写入。加 --apply 实际修复)');
} else {
  // 备份原文件
  const bak = dbFile + '.bak';
  if (!fs.existsSync(bak)) fs.writeFileSync(bak, raw, 'utf8');
  fs.writeFileSync(dbFile, JSON.stringify(j, null, 2), 'utf8');
  console.log(`\n已写入 ${dbFile}（原文件备份为 ${path.basename(bak)}）`);
  console.log('提示：修复的是已存储的文件名显示。下载/预览的文件内容本来就正确。');
}
