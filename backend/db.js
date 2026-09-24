const fs = require('fs');
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

// [PERF] 存储引擎选择：
//   sqlite（默认）：node:22+ 内置 node:sqlite，写操作按行落盘（微秒级），彻底消除
//                  "单条改动 = 整表 JSON.stringify + 写全量文件" 的秒级阻塞
//                  （order_bom_details 已达 416MB/24 万行，整表写一次阻塞 5~15 秒）。
//   json（回退）：  USE_JSON_DB=1 或 node:sqlite 不可用时，沿用原 JSON 文件引擎。
const ENGINE = (() => {
  if (process.env.USE_JSON_DB === '1') return 'json';
  try { require('node:sqlite'); return 'sqlite'; } catch (e) { return 'json'; }
})();

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

// ============================ SQLite 引擎（默认） ============================
// 数据文件 database/sales.db，每张业务表对应 t_<name>(id INTEGER PRIMARY KEY, j TEXT)。
// j 为该行记录序列化后的 JSON 文本；内存中仍整表缓存（与 JSON 引擎一致），
// 但持久化粒度为"行"：insert/update/delete 仅写受影响的行。
let _sqliteDb = null;
function getSqliteDb() {
  if (_sqliteDb) return _sqliteDb;
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = path.join(dataDir, 'sales.db');
  _sqliteDb = new DatabaseSync(dbPath);
  _sqliteDb.exec('PRAGMA journal_mode=WAL;');
  _sqliteDb.exec('PRAGMA synchronous=NORMAL;');
  _sqliteDb.exec('PRAGMA busy_timeout=5000;');
  // 限制 WAL 文件体积上限（此前 sales.db-wal 一度膨胀到 451MB，拖慢启动并加剧磁盘/内存压力）
  try { _sqliteDb.exec('PRAGMA journal_size_limit=67108864;'); } catch (e) {}
  // 启动时做一次 checkpoint 并截断 WAL，避免历史遗留的超大 WAL 影响启动与查询性能
  try { _sqliteDb.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch (e) { console.warn('[db] WAL checkpoint(启动) 失败:', e.message); }
  // 周期被动 checkpoint，防止长连接下 WAL 只增不减（unref 不阻塞进程退出）
  setInterval(() => {
    try { _sqliteDb.exec('PRAGMA wal_checkpoint(PASSIVE);'); } catch (e) {}
  }, 10 * 60 * 1000).unref();
  return _sqliteDb;
}

const BIG_TABLE_ROWS = 50000; // 超过此行数的表 saveNow 不做全量对账（见 saveNow 注释）

class SqliteTable {
  constructor(name) {
    this.name = name;
    this.filePath = path.join(dataDir, name + '.json'); // 迁移数据源 / JSON 引擎兼容
    this._cache = null;
    this._ver = 0; // 单调递增版本号：任一写操作 +1，供上层聚合索引缓存失效判断
    this._dbp = null;
  }

  _db() {
    if (this._dbp) return this._dbp;
    if (!/^[A-Za-z0-9_]+$/.test(this.name)) throw new Error('[db] 非法表名: ' + this.name);
    const db = getSqliteDb();
    this._t = 't_' + this.name;
    db.exec('CREATE TABLE IF NOT EXISTS "' + this._t + '" (id INTEGER PRIMARY KEY, j TEXT NOT NULL)');
    this._ins = db.prepare('INSERT OR REPLACE INTO "' + this._t + '" (id, j) VALUES (?, ?)');
    this._del = db.prepare('DELETE FROM "' + this._t + '" WHERE id = ?');
    this._cnt = db.prepare('SELECT COUNT(*) AS c FROM "' + this._t + '"');
    this._ids = db.prepare('SELECT id FROM "' + this._t + '"');
    this._dbp = db;
    return db;
  }

  _execTx(fn) {
    const db = this._db();
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
  }

  // 一次性迁移：SQLite 表为空且磁盘上存在历史 JSON 数据文件时导入。
  // 导入成功后把原 JSON 改名为 <name>.json.imported-<ts> 保留（不删除，可人工回退）。
  _migrateFromJson() {
    if (!fs.existsSync(this.filePath)) return 0;
    let parsed = null;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8').trim();
      if (raw) parsed = JSON.parse(raw);
    } catch (e) {
      // 主文件损坏：备份后尝试 .bak（沿用 JSON 引擎的损坏处理约定）
      try { fs.copyFileSync(this.filePath, this.filePath + '.corrupt-' + Date.now()); } catch (_) {}
      console.error('[db] 表 ' + this.name + ' JSON 解析失败（迁移源），已备份 .corrupt-*，尝试 .bak');
      try {
        const bakRaw = fs.readFileSync(this.filePath + '.bak', 'utf8').trim();
        if (bakRaw) parsed = JSON.parse(bakRaw);
      } catch (_) {}
    }
    if (parsed && Array.isArray(parsed)) parsed = { records: parsed };
    let records = (parsed && Array.isArray(parsed.records)) ? parsed.records : [];
    // 关键表空状态自愈：迁移源为空但 .bak 有数据 → 用 .bak（防止更新后登录不了）
    if (records.length === 0 && CRITICAL_TABLES.has(this.name)) {
      try {
        const bakRaw = fs.readFileSync(this.filePath + '.bak', 'utf8').trim();
        if (bakRaw) {
          const bakParsed = JSON.parse(bakRaw);
          if (bakParsed && Array.isArray(bakParsed.records) && bakParsed.records.length > 0) {
            console.warn('[db] 关键表 ' + this.name + ' JSON 为空，迁移改用 .bak（' + bakParsed.records.length + ' 条）');
            records = bakParsed.records;
          }
        }
      } catch (_) {}
    }
    if (!records.length) return 0;
    // 补齐缺失 id 的记录（纯数组形式的历史数据）
    let maxId = 0;
    for (const r of records) if (r && Number(r.id) > maxId) maxId = Number(r.id);
    let seq = maxId;
    const t0 = Date.now();
    this._execTx(() => {
      for (const r of records) {
        if (!r || typeof r !== 'object') continue;
        if (!(r.id > 0)) { seq++; r.id = seq; }
        this._ins.run(Number(r.id), JSON.stringify(r));
      }
    });
    try { fs.renameSync(this.filePath, this.filePath + '.imported-' + Date.now()); } catch (_) {}
    console.log('[db] 表 ' + this.name + ' 已迁移 JSON→SQLite：' + records.length + ' 条，耗时 ' + (Date.now() - t0) + 'ms（原文件保留为 .imported-*）');
    return records.length;
  }

  _load() {
    if (this._cache) return this._cache;
    this._db();
    if (this._cnt.get().c === 0) {
      try { this._migrateFromJson(); } catch (e) {
        console.error('[db] 表 ' + this.name + ' JSON→SQLite 迁移失败: ' + e.message);
      }
    }
    const rows = this._dbp.prepare('SELECT id, j FROM "' + this._t + '"').all();
    const records = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) records[i] = JSON.parse(rows[i].j);
    let maxId = 0;
    for (const r of records) if (r && Number(r.id) > maxId) maxId = Number(r.id);
    this._cache = { records, nextId: maxId + 1 };
    this._ver++;
    return this._cache;
  }

  _writeRow(rec) { this._ins.run(Number(rec.id), JSON.stringify(rec)); }
  _dropRow(id) { this._del.run(Number(id)); }

  // 全量对账：内存快照整表 upsert + 删除库中多余行（小表专用，毫秒级）。
  // 用于兜住"t.all() 拿引用直接改字段后调 saveNow()/_save()"这类无法跟踪的变更。
  _reconcile(records) {
    const inMem = new Set();
    for (const r of records) inMem.add(Number(r.id));
    this._execTx(() => {
      for (const r of records) if (r && typeof r === 'object') this._writeRow(r);
      for (const { id } of this._ids.all()) if (!inMem.has(Number(id))) this._dropRow(id);
    });
  }

  version() { return this._ver; }

  // SQLite 为唯一真相源且写操作均被跟踪：无需按磁盘 mtime 丢弃缓存。
  // 保留方法以兼容全代码库 680+ 处 `t._invalidate()` 调用（等价空操作）。
  _invalidate() {}

  insert(record) {
    return withTableLock(this.name, () => {
      const data = this._load();
      record.id = data.nextId++;
      data.records.push(record);
      this._writeRow(record);
      this._ver++;
      return { lastID: record.id, changes: 1 };
    });
  }

  // 批量写入：SQLite 引擎下仍即时按行落盘（单行写入微秒级），
  // 保留方法名以兼容既有调用；saveNow 变为轻量操作。
  insertNoSave(record) {
    return withTableLock(this.name, () => {
      const data = this._load();
      record.id = data.nextId++;
      data.records.push(record);
      this._writeRow(record);
      this._ver++;
      return record.id;
    });
  }

  // 提交内存变更到磁盘。SQLite 引擎：
  //   - 小表（≤5 万行）：全量对账，兜住 .all() 直接改字段后 saveNow 的用法；
  //   - 大表（>5 万行）：结构化写操作（insert/update/delete 系列）已逐行即时落盘，
  //     直接返回（大表全部经由结构化 API 写入，无直接改内存的调用方）。
  saveNow() {
    const snapshot = this._cache;
    return withTableLock(this.name, () => {
      if (!snapshot) return { changes: 0 };
      this._cache = snapshot;
      if (snapshot.records.length <= BIG_TABLE_ROWS) {
        this._reconcile(snapshot.records);
      }
      this._ver++;
      return { changes: 1 };
    });
  }

  update(id, fields) {
    return withTableLock(this.name, () => {
      const data = this._load();
      const idx = data.records.findIndex(r => r.id === Number(id));
      if (idx === -1) return { changes: 0 };
      Object.assign(data.records[idx], fields);
      this._writeRow(data.records[idx]);
      this._ver++;
      return { changes: 1 };
    });
  }

  updateNoSave(id, fields) {
    return withTableLock(this.name, () => {
      const data = this._load();
      const idx = data.records.findIndex(r => r.id === Number(id));
      if (idx === -1) return { changes: 0 };
      Object.assign(data.records[idx], fields);
      this._writeRow(data.records[idx]);
      this._ver++;
      return { changes: 1 };
    });
  }

  delete(id) {
    return withTableLock(this.name, () => {
      const data = this._load();
      const idx = data.records.findIndex(r => r.id === Number(id));
      if (idx === -1) return { changes: 0 };
      const [removed] = data.records.splice(idx, 1);
      this._dropRow(removed.id);
      this._ver++;
      return { changes: 1 };
    });
  }

  deleteNoSave(id) {
    return withTableLock(this.name, () => {
      const data = this._load();
      const idx = data.records.findIndex(r => r.id === Number(id));
      if (idx === -1) return { changes: 0 };
      const [removed] = data.records.splice(idx, 1);
      this._dropRow(removed.id);
      this._ver++;
      return { changes: 1 };
    });
  }

  // 按条件批量删除：单次遍历改内存，受影响行在一个事务内删除
  deleteWhereNoSave(predicate) {
    return withTableLock(this.name, () => {
      const data = this._load();
      const before = data.records.length;
      const removedIds = [];
      data.records = data.records.filter(r => {
        if (predicate(r)) { removedIds.push(Number(r.id)); return false; }
        return true;
      });
      if (removedIds.length) {
        this._execTx(() => { for (const id of removedIds) this._dropRow(id); });
        this._ver++;
      }
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

  // 兼容 sop-seed.js / test.js 对 _save() 的直接调用（同步执行，与 JSON 引擎语义一致）
  _save() {
    if (!this._cache) return;
    if (this._cache.records.length <= BIG_TABLE_ROWS) this._reconcile(this._cache.records);
    this._ver++;
  }

  // 兼容 lib/materials-recovery.js 的异步写盘调用：
  // SQLite 引擎下全量对账为毫秒级，直接复用 _save（返回 Promise 保持 await 兼容）
  async _saveAsync() { this._save(); }
}

// ============================ JSON 文件引擎（回退） ============================
// 原实现原样保留：USE_JSON_DB=1 或 node:sqlite 不可用时启用。
class JsonFileTable {
  constructor(name) {
    this.name = name;
    this.filePath = path.join(dataDir, name + '.json');
    this._cache = null;
    this._mtimeMs = -1; // 缓存对应的磁盘文件版本（mtime+大小；-1 表示未知，触发保守重载）
    this._sizeBytes = -1;
  }

  // 记录当前磁盘文件版本（mtime+大小；加载/写盘后调用，供 _invalidate 智能失效判断）
  _stampMtime() {
    try {
      const st = fs.statSync(this.filePath);
      this._mtimeMs = st.mtimeMs; this._sizeBytes = st.size;
    } catch (e) { this._mtimeMs = -1; this._sizeBytes = -1; }
    return this._mtimeMs;
  }

  // 当前磁盘文件版本（mtime）；文件不存在返回 0。供上层按表版本缓存聚合索引
  version() {
    try { return fs.statSync(this.filePath).mtimeMs; } catch (e) { return 0; }
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
    // 关键表空状态自愈：若加载结果为空（更新截断/损坏），尝试从 .bak 恢复，
    // 避免 initData 用默认账号覆盖导致"更新后登录不了"
    if (this._cache && Array.isArray(this._cache.records) && this._cache.records.length === 0 && CRITICAL_TABLES.has(this.name)) {
      if (this._restoreFromBakIfHasData()) return this._cache;
    }
    this._stampMtime();
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
        console.warn('[db] 关键表 ' + this.name + ' 加载为空，已从 .bak 恢复 ' + bakParsed.records.length + ' 条记录（防止更新丢数据）');
        this._cache = bakParsed;
        this._save(); // 同步回主文件
        return true;
      }
    } catch (e) {
      console.warn('[db] 关键表 ' + this.name + ' .bak 恢复失败: ' + e.message);
    }
    return false;
  }

  _save() {
    // 防御：缓存为空时绝不写盘，避免用 "null" 覆盖主文件和 .bak 造成数据全丢
    if (!this._cache) return;
    // 原子写入：先写临时文件再重命名，避免并发读到的截断/半写 JSON
    const tmp = this.filePath + '.tmp';
    const content = JSON.stringify(this._cache);
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
      try { fs.writeFileSync(this.filePath + '.bak', content, 'utf8'); } catch (e) {}
    }
    // 写盘成功后记录 mtime：本进程内存即最新，_invalidate 无需重读
    this._stampMtime();
  }

  // 异步写盘：不阻塞事件循环，适用于大文件（materials/issues）
  // 在写盘期间仍能响应其它 HTTP 请求
  async _saveAsync() {
    const tmp = this.filePath + '.tmp';
    const content = JSON.stringify(this._cache);
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
    // 写盘成功后记录 mtime：本进程内存即最新，_invalidate 无需重读
    this._stampMtime();
  }

  // 智能失效：磁盘文件未变化时（mtime+大小一致，本进程写入后已记录）保留内存缓存，
  // 避免每次请求整表重读+重解析大 JSON；文件被外部修改/删除时版本变化才真正重载
  _invalidate() {
    let mtime = -1, size = -1;
    try { const st = fs.statSync(this.filePath); mtime = st.mtimeMs; size = st.size; } catch (e) {}
    if (this._cache && mtime !== -1 && mtime === this._mtimeMs && size === this._sizeBytes) return;
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
    tables[name] = ENGINE === 'sqlite' ? new SqliteTable(name) : new JsonFileTable(name);
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

module.exports = { getTable, ensureTable, now, engine: ENGINE };
