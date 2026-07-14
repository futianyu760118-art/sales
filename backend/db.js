const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '../database');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

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
                  console.warn('[db] 表 ' + this.name + ' 主文件损坏，已从 .bak 恢复');
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
      console.error('[db] 表 ' + this.name + ' JSON 解析失败，已备份至 ' + bak + '，暂以空表加载（未覆写原文件）');
      this._cache = { records: [], nextId: 1 };
    }
    return this._cache;
  }

  _save() {
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
    // 关键表自动备份最近一次成功状态，供主文件损坏时恢复
    if (this.name === 'materials' || this.name === 'users') {
      try { fs.writeFileSync(this.filePath + '.bak', content, 'utf8'); } catch (_) {}
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
  saveNow() {
    return withTableLock(this.name, () => {
      this._save();
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
