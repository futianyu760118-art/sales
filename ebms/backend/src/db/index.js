import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedChain } from './seed.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 打开链路数据底座并应用契约 schema。
 *
 * 架构方案选定 PostgreSQL；本模块以仓储层隔离数据访问，本地自检用
 * node:sqlite 落地（等价 DDL 见 postgres.sql），正式环境切 PostgreSQL
 * 只需替换本文件与 repositories 层，服务层与接口契约不变。
 *
 * @param {{ file?: string, seed?: boolean }} [options]
 */
export function openDatabase({ file = ':memory:', seed = true } = {}) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  if (seed) seedChain(db);
  return db;
}
