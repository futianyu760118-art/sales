const fs = require('fs');
const logger = require('./lib/logger');
const path = require('path');

const dataDir = path.join(__dirname, '../database');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// 关键表清单：这些表若启动时加载为空（更新/损坏导致），但 .bak 或时间戳备份有数据，
// 则自动恢复，避免 initData 用默认账号覆盖、造成"更新后登录不了"。
// 鉴权链：users / roles / permissions / role_permissions / user_roles
// 组织扩展：org_personnel / org_position_perms / org_position_roles / org_personnel_perms
const CRITICAL_TABLES = new Set([
  'users', 'roles', 'permissions', 'role_permissions', 'user_roles',
  'org_personnel', 'org_position_perms', 'org_position_roles', 'org_personnel_perms'
]);

// [H1] 单进程内每表一把 FIFO 写互斥锁：解决 _cache 内存状态被并发写覆盖的问题。
// 同一张表的 insert/update/delete 串行执行；不是分布式锁，多实例部署需更上层方案。
const _tableTail = new Map();
function withTableLock(name, fn) {
  const prev = _tableTail.get(name) || Promise.resolve();
  const next = prev.then(fn, fn);
  // 链尾用 finally 链式 resolve，避免异常中断后续任务
  _tableTail.set(name, next.catch(() => undefined));
  return next;
}
class JsonTable {
  constructor(name) {
    this.name = name;
    this.filePath = path.join(dataDir, name + '.json');
    this._cache = null;
  }

  _load() {
    if (this._cache) return this._cache;
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8').trim();
        if (!raw) {
          this._cache = { records: [], nextId: 1 };
        } else {
          const parsed = JSON.parse(raw);
          // 容错：如果解析结果是 null 或不是对象，重置为空表（避免 .records 报 null）
          if (parsed && typeof parsed === 'object' && Array.isArray(parsed.records)) {
            this._cache = parsed;
          } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed)) {
            // 兜底：被识别为纯数组也兼容
            this._cache = { records: parsed, nextId: parsed.length + 1 };
          } else {
            // 严重异常：尝试从 .bak 恢复
            const bakFile = this.filePath + '.bak';
            if (fs.existsSync(bakFile)) {
              try {
                const bakRaw = fs.readFileSync(bakFile, 'utf8').trim();
                const bakParsed = JSON.parse(bakRaw);
                if (bakParsed && Array.isArray(bakParsed.records)) {
                  logger.warn('[db] 表 ' + this.name + ' 主文件损坏，已从 .bak 恢复');
                  this._cache = bakParsed;
                  this._save(); // 把正确的内容覆盖回主文件
                  return this._cache;
                }
              } catch (_) {}
            }
            this._cache = { records: [], nextId: 1 };
          }
        }
      } else {
        this._cache = { records: [], nextId: 1 };
        this._save();
      }
    } catch (e) {
      // 解析失败（如并发读到半写文件）：备份后置空，但不立即覆写，避免误删数据
      const bak = this.filePath + '.corrupt-' + Date.now();
      try { fs.copyFileSync(this.filePath, bak); } catch (_) {}
      logger.error('[db] 表 ' + this.name + ' JSON 解析失败，已备份至 ' + bak + '，暂以空表加载（未覆写原文件）');
      this._cache = { records: [], nextId: 1 };
    }
    // 关键表空状态自愈：若加载结果为空（更新截断/损坏），尝试从 .bak 恢复，
    // 避免 initData 用默认账号覆盖导致"更新后登录不了"
    if (this._cache && Array.isArray(this._cache.records) && this._cache.records.length === 0 && CRITICAL_TABLES.has(this.name)) {
      if (this._restoreFromBakIfHasData()) return this._cache;
    }
    return this._cache;
  }

  // 关键表空状态自愈：从 .bak 恢复（.bak 有数据时）
  _restoreFromBakIfHasData() {
    const bakFile = this.filePath + '.bak';
    try {
      if (!fs.existsSync(bakFile)) return false;
      const bakRaw = fs.readFileSync(bakFile, 'utf8').trim();
      if (!bakRaw) return false;
      const bakParsed = JSON.parse(bakRaw);
      if (bakParsed && Array.isArray(bakParsed.records) && bakParsed.records.length > 0) {
        logger.warn('[db] 关键表 ' + this.name + ' 加载为空，已从 .bak 恢复 ' + bakParsed.records.length + ' 条记录（防止更新丢数据）');
        this._cache = bakParsed;
        this._save(); // 同步回主文件
        return true;
      }
    } catch (e) {
      logger.warn('[db] 关键表 ' + this.name + ' .bak 恢复失败: ' + e.message);
    }
    return false;
  }

  _save() {
    // 防御：缓存为空时绝不写盘，避免用 "null" 覆盖主文件和 .bak 造成数据全丢
    if (!this._cache) return;
    // 原子写入：先写临时文件再重命名，避免并发读到的截断/半写 JSON
    const tmp = this.filePath + '.tmp';
    const content = JSON.stringify(this._cache, null, 2);
    fs.writeFileSync(tmp, content, 'utf8');
    try {
      fs.renameSync(tmp, this.filePath);
    }
    catch (e) {
      // 某些平台跨卷重命名失败时回退为直接写入
      fs.writeFileSync(this.filePath, content, 'utf8');
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
    // 关键表 + materials 自动备份最近一次成功状态，供主文件损坏/空状态时恢复
    if (this.name === 'materials' || CRITICAL_TABLES.has(this.name)) {
      try { fs.writeFileSync(this.filePath + '.bak', content, 'utf8'); } catch (_) {}
    }
  }

  // 异步写盘：不阻塞事件循环，适用于大文件（materials/issues）
  // 在写盘期间仍能响应其它 HTTP 请求
  async _saveAsync() {
    const tmp = this.filePath + '.tmp';
    const content = JSON.stringify(this._cache, null, 2);
    const fsp = fs.promises;
    try {
      await fsp.writeFile(tmp, content, 'utf8');
      await fsp.rename(tmp, this.filePath);
    } catch (e) {
      try {
        await fsp.writeFile(this.filePath, content, 'utf8');
        try { await fsp.unlink(tmp); } catch (_) {}
      } catch (_) {}
    }
    if (this.name === 'materials' || this.name === 'users') {
      try { await fsp.writeFile(this.filePath + '.bak', content, 'utf8'); } catch (_) {}
    }
  }

  _invalidate() {
    this._cache = null;
  }

  insert(record) {
    return withTableLock(this.name, () => {
      const data = this._load();
      record.id = data.nextId++;
      data.records.push(record);
      this._save();
      return { lastID: record.id, changes: 1 };
    });
  }

  // 批量写入：内存中插入不落盘，返回新id（配合 saveNow 使用，避免逐条写整表）
  insertNoSave(record) {
    return withTableLock(this.name, () => {
      const data = this._load();
      record.id = data.nextId++;
      data.records.push(record);
      return record.id;
    });
  }

  // 提交内存变更到磁盘（一次性写入）
  // 关键：在调用时刻同步捕获缓存快照。saveNow 经 withTableLock 把 _save 排进微任务异步执行，
  // 若调用方未 await 便紧接着 _invalidate() 把 _cache 置空，原实现会在微任务里把 null 写盘。
  // 快照保证：无论后续缓存被如何置空/重载，落盘的始终是调用时刻的有效数据。
  saveNow() {
    const snapshot = this._cache;
    return withTableLock(this.name, () => {
      if (!snapshot) return { changes: 0 };
      this._cache = snapshot;
      this._save();
      return { changes: 1 };
    });
  }

  update(id, fields) {
    return withTableLock(this.name, () => {
      const data = this._load();
      const idx = data.records.findIndex(r => r.id === Number(id));
      if (idx === -1) return { changes: 0 };
      Object.assign(data.records[idx], fields);
      this._save();
      return { changes: 1 };
    });
  }

  // 批量更新：仅改内存不落盘（配合 saveNow）
  updateNoSave(id, fields) {
    return withTableLock(this.name, () => {
      const data = this._load();
      const idx = data.records.findIndex(r => r.id === Number(id));
      if (idx === -1) return { changes: 0 };
      Object.assign(data.records[idx], fields);
      return { changes: 1 };
    });
  }

  delete(id) {
    return withTableLock(this.name, () => {
      const data = this._load();
      const idx = data.records.findIndex(r => r.id === Number(id));
      if (idx === -1) return { changes: 0 };
      data.records.splice(idx, 1);
      this._save();
      return { changes: 1 };
    });
  }

  // 批量删除：仅改内存不落盘（配合 saveNow，避免逐条整表写盘）
  deleteNoSave(id) {
    return withTableLock(this.name, () => {
      const data = this._load();
      const idx = data.records.findIndex(r => r.id === Number(id));
      if (idx === -1) return { changes: 0 };
      data.records.splice(idx, 1);
      return { changes: 1 };
    });
  }

  // 按条件批量删除：单次遍历，仅改内存不落盘（配合 saveNow）
  deleteWhereNoSave(predicate) {
    return withTableLock(this.name, () => {
      const data = this._load();
      const before = data.records.length;
      data.records = data.records.filter(r => !predicate(r));
      return { changes: before - data.records.length };
    });
  }

  findById(id) {
    const data = this._load();
    return data.records.find(r => r.id === Number(id)) || null;
  }

  findWhere(filter, orderBy, orderDir, limit, offset) {
    let records = this._load().records;
    if (filter) {
      records = records.filter(filter);
    }
    if (orderBy) {
      records.sort((a, b) => {
        const va = a[orderBy] || '';
        const vb = b[orderBy] || '';
        const cmp = va < vb ? -1 : va > vb ? 1 : 0;
        return orderDir === 'DESC' ? -cmp : cmp;
      });
    }
    const total = records.length;
    if (offset !== undefined && limit !== undefined) {
      records = records.slice(offset, offset + limit);
    }
    return { records, total };
  }

  count(filter) {
    const data = this._load();
    if (!filter) return data.records.length;
    return data.records.filter(filter).length;
  }

  all() {
    return this._load().records;
  }
}

const tables = {};

function getTable(name) {
  if (!tables[name]) {
    tables[name] = new JsonTable(name);
  }
  return tables[name];
}

function ensureTable(name) {
  const t = getTable(name);
  t._load();
  return t;
}

function now() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().replace('T', ' ').substring(0, 19);
}

module.exports = { getTable, ensureTable, now };
