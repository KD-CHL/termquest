// DbEngine —— 继承 LinuxEngine，叠加迷你 SQL 引擎（sqlite3）与 Redis 键值存储
// 会话模型：e.sqlSession = 数据库名（sqlite3 交互中）；e.redisSession = true（redis-cli 中）
//
// SQL 覆盖：CREATE TABLE / DROP TABLE / ALTER TABLE ADD COLUMN / CREATE INDEX / CREATE VIEW，
//   INSERT(多行) / UPDATE / DELETE，
//   SELECT（WHERE：= != <> > < >= <= LIKE IN BETWEEN IS [NOT] NULL NOT AND OR、
//     子查询 WHERE x IN (SELECT ...)、表别名、JOIN(INNER/LEFT/RIGHT/FULL/CROSS)、
//     GROUP BY/HAVING、ORDER BY、LIMIT 偏移、DISTINCT、UNION/UNION ALL、
//     聚合 COUNT/SUM/AVG/MIN/MAX、CASE WHEN、COALESCE/CAST、
//     字符串函数 UPPER/LOWER/LENGTH/SUBSTR/TRIM/REPLACE、数学 ROUND/ABS、date('now')），
//   事务 BEGIN/COMMIT/ROLLBACK，点命令 .tables/.schema/.databases/.dump/.headers/.mode/.quit
// Redis 覆盖：字符串/列表/哈希/集合/有序集合/键管理/服务器/事务（MULTI/EXEC/DISCARD）
import { LinuxEngine } from './linux-engine.js';

// 子查询求值所需的当前引擎/库（在 execSql 入口绑定）
let _curEngine = null;
let _curDb = null;

export class DbEngine extends LinuxEngine {
  reset() {
    super.reset();
    this.databases = {};   // { dbName: { tables, views, indexes } }
    this.redis = { kv: {}, lists: {}, hashes: {}, sets: {}, zsets: {}, expiry: {} };
    this.sqlSession = null;
    this.redisSession = false;
    this.tx = null;                 // 事务快照 { dbName, snap }
    this.viewMode = { headers: true, mode: 'list' }; // sqlite3 输出设置
    this.redisMulti = null;         // Redis 事务队列 [命令串, ...]
    this.redisDbIndex = 0;          // SELECT 选择的逻辑库（仅展示）
    this._seedDbFiles();
  }

  _seedDbFiles() {
    this.writeFile('/home/user/schema.sql', 'CREATE TABLE users (id INTEGER, name TEXT, age INTEGER);\n');
  }

  /* ---- 数据库辅助 ---- */
  getDb(name) {
    if (!this.databases[name]) this.databases[name] = { tables: {}, views: {}, indexes: {} };
    const db = this.databases[name];
    if (!db.views) db.views = {};
    if (!db.indexes) db.indexes = {};
    return db;
  }
  getTable(db, name) { return this.databases[db]?.tables[name]; }

  _snapshotDb() { return JSON.parse(JSON.stringify(this.databases)); }
  _restoreDb(snap) { this.databases = JSON.parse(JSON.stringify(snap)); }

  /* ---- Redis 辅助 ---- */
  _purgeExpired() {
    const now = Date.now();
    for (const k of Object.keys(this.redis.expiry)) {
      if (this.redis.expiry[k] <= now) this._rDel(k);
    }
  }
  _rExists(k) {
    const R = this.redis;
    return !!(R.kv[k] || R.lists[k] || R.hashes[k] || R.sets[k] || R.zsets[k]);
  }
  _rDel(k) {
    const R = this.redis;
    let n = 0;
    if (R.kv[k]) { delete R.kv[k]; n++; }
    if (R.lists[k]) { delete R.lists[k]; n++; }
    if (R.hashes[k]) { delete R.hashes[k]; n++; }
    if (R.sets[k]) { delete R.sets[k]; n++; }
    if (R.zsets[k]) { delete R.zsets[k]; n++; }
    delete R.expiry[k];
    return n;
  }
  _rType(k) {
    const R = this.redis;
    if (R.kv[k]) return 'string';
    if (R.lists[k]) return 'list';
    if (R.hashes[k]) return 'hash';
    if (R.sets[k]) return 'set';
    if (R.zsets[k]) return 'zset';
    return 'none';
  }
  _rAllKeys() {
    const R = this.redis;
    return [...Object.keys(R.kv), ...Object.keys(R.lists), ...Object.keys(R.hashes), ...Object.keys(R.sets), ...Object.keys(R.zsets)];
  }
  _rCopyVal(k) {
    const R = this.redis;
    if (R.kv[k]) return { store: 'kv', val: { ...R.kv[k] } };
    if (R.lists[k]) return { store: 'lists', val: [...R.lists[k]] };
    if (R.hashes[k]) return { store: 'hashes', val: { ...R.hashes[k] } };
    if (R.sets[k]) return { store: 'sets', val: new Set(R.sets[k]) };
    if (R.zsets[k]) return { store: 'zsets', val: R.zsets[k].map(m => ({ ...m })) };
    return null;
  }
  _rPut(key, cv) {
    const R = this.redis;
    if (!cv) return;
    if (cv.store === 'kv') R.kv[key] = cv.val;
    else if (cv.store === 'lists') R.lists[key] = cv.val;
    else if (cv.store === 'hashes') R.hashes[key] = cv.val;
    else if (cv.store === 'sets') R.sets[key] = cv.val;
    else if (cv.store === 'zsets') R.zsets[key] = cv.val;
  }

  /* ============================================================
   * SQL 执行：返回 { out: [行], err }
   * ============================================================ */
  execSql(dbName, sql) {
    _curEngine = this;
    sql = (sql || '').trim().replace(/;\s*$/, '');
    if (!sql) return { out: [] };
    try {
      return this._execSql(dbName, sql);
    } catch (err) {
      return { out: [`Error: ${err && err.message ? err.message : '无法解析 SQL'}`], err: true };
    }
  }

  _execSql(dbName, sql) {
    const db = this.getDb(dbName);
    _curDb = db;
    let m;

    /* ---- 点命令 ---- */
    if (sql[0] === '.') return this._dotCommand(db, sql);

    /* ---- 事务 ---- */
    if (/^BEGIN(\s+(DEFERRED|IMMEDIATE|EXCLUSIVE))?(\s+TRANSACTION)?$/i.test(sql) || /^START\s+TRANSACTION$/i.test(sql)) {
      if (this.tx) return { out: ['Error: cannot start a transaction within a transaction'], err: true };
      this.tx = { dbName, snap: this._snapshotDb() };
      return { out: [] };
    }
    if (/^(COMMIT|END)(\s+TRANSACTION)?$/i.test(sql)) {
      if (!this.tx) return { out: ['Error: no transaction is active'], err: true };
      this.tx = null;
      return { out: [] };
    }
    if (/^ROLLBACK(\s+TRANSACTION)?$/i.test(sql)) {
      if (!this.tx) return { out: ['Error: no transaction is active'], err: true };
      this._restoreDb(this.tx.snap);
      this.tx = null;
      return { out: [] };
    }

    /* ---- CREATE TABLE [IF NOT EXISTS] ---- */
    if ((m = sql.match(/^CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\((.*)\)$/is))) {
      const [, ifne, name, colDefs] = m;
      if (db.tables[name]) {
        if (ifne) return { out: [] };
        return { out: [`Error: table ${name} already exists`], err: true };
      }
      const cols = splitTop(colDefs)
        .filter(d => !/^(PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|CONSTRAINT)\b/i.test(d.trim()))
        .map(c => c.trim().split(/\s+/)[0])
        .filter(Boolean);
      db.tables[name] = { cols, rows: [] };
      return { out: [] };
    }

    /* ---- DROP TABLE [IF EXISTS] ---- */
    if ((m = sql.match(/^DROP\s+TABLE\s+(IF\s+EXISTS\s+)?(\w+)$/i))) {
      const [, ifex, name] = m;
      if (!db.tables[name]) {
        if (ifex) return { out: [] };
        return { out: [`Error: no such table: ${name}`], err: true };
      }
      delete db.tables[name];
      return { out: [] };
    }

    /* ---- CREATE VIEW ---- */
    if ((m = sql.match(/^CREATE\s+VIEW\s+(IF\s+NOT\s+EXISTS\s+)?(\w+)\s+AS\s+(SELECT\s+.+)$/is))) {
      const [, ifne, name, sel] = m;
      if (db.views[name]) {
        if (ifne) return { out: [] };
        return { out: [`Error: view ${name} already exists`], err: true };
      }
      if (!this._parseSelect(sel.trim())) return { out: ['Error: near "AS": syntax error'], err: true };
      db.views[name] = { sql: sel.trim() };
      return { out: [] };
    }
    if ((m = sql.match(/^DROP\s+VIEW\s+(IF\s+EXISTS\s+)?(\w+)$/i))) {
      const [, ifex, name] = m;
      if (!db.views[name]) {
        if (ifex) return { out: [] };
        return { out: [`Error: no such view: ${name}`], err: true };
      }
      delete db.views[name];
      return { out: [] };
    }

    /* ---- CREATE [UNIQUE] INDEX ---- */
    if ((m = sql.match(/^CREATE\s+(UNIQUE\s+)?INDEX\s+(IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+(\w+)\s*\(([^)]*)\)$/i))) {
      const [, , ifne, idx, tbl, colsPart] = m;
      if (!db.tables[tbl]) return { out: [`Error: no such table: ${tbl}`], err: true };
      if (db.indexes[idx]) {
        if (ifne) return { out: [] };
        return { out: [`Error: index ${idx} already exists`], err: true };
      }
      db.indexes[idx] = { table: tbl, cols: colsPart.split(',').map(c => c.trim().split(/\s+/)[0]).filter(Boolean) };
      return { out: [] };
    }
    if ((m = sql.match(/^DROP\s+INDEX\s+(IF\s+EXISTS\s+)?(\w+)$/i))) {
      const [, ifex, idx] = m;
      if (!db.indexes[idx]) {
        if (ifex) return { out: [] };
        return { out: [`Error: no such index: ${idx}`], err: true };
      }
      delete db.indexes[idx];
      return { out: [] };
    }

    /* ---- ALTER TABLE ADD COLUMN ---- */
    if ((m = sql.match(/^ALTER\s+TABLE\s+(\w+)\s+ADD\s+(COLUMN\s+)?(\w+)(\s+\w+)?/i))) {
      const [, name, , col] = m;
      const t = db.tables[name];
      if (!t) return { out: [`Error: no such table: ${name}`], err: true };
      if (t.cols.includes(col)) return { out: [`Error: duplicate column name: ${col}`], err: true };
      t.cols.push(col);
      for (const r of t.rows) r.push(null);
      return { out: [] };
    }

    /* ---- INSERT ---- */
    if ((m = sql.match(/^INSERT\s+INTO\s+(\w+)\s*(?:\(([^)]*)\))?\s*VALUES\s*(.+)$/is))) {
      const [, name, colList, valPart] = m;
      const t = db.tables[name];
      if (!t) return { out: [`Error: no such table: ${name}`], err: true };
      const groups = splitValueGroups(valPart);
      if (!groups.length) return { out: [`Error: 无法解析 VALUES: ${valPart.slice(0, 30)}`], err: true };
      let n = 0;
      for (const g of groups) {
        const vals = parseValues(g);
        if (colList) {
          const cols = colList.split(',').map(c => c.trim());
          const full = new Array(t.cols.length).fill(null);
          cols.forEach((c, i) => { const idx = t.cols.indexOf(c); if (idx >= 0) full[idx] = vals[i]; });
          t.rows.push(full);
        } else {
          t.rows.push(vals);
        }
        n++;
      }
      return { out: [`(${n} 行受影响)`] };
    }

    /* ---- SELECT / UNION ---- */
    if (/^SELECT\b/i.test(sql) || sql[0] === '(') {
      return this._runSelectSql(db, sql);
    }

    /* ---- UPDATE ---- */
    if ((m = sql.match(/^UPDATE\s+(\w+)\s+SET\s+(.+?)(?:\s+WHERE\s+(.+))?$/is))) {
      const [, name, setPart, where] = m;
      const t = db.tables[name];
      if (!t) return { out: [`Error: no such table: ${name}`], err: true };
      const sets = parseSetClause(setPart).map(s => ({ ...s, ci: t.cols.indexOf(s.col) }));
      for (const s of sets) if (s.ci < 0) return { out: [`Error: no such column: ${s.col}`], err: true };
      let n = 0;
      for (const r of t.rows) {
        const scope = rowScope(t, r);
        if (!where || truthy(evalExpr(parseExpr(where), scope))) {
          sets.forEach(s => { r[s.ci] = evalExpr(s.ast, scope); });
          n++;
        }
      }
      return { out: [`(${n} 行受影响)`] };
    }

    /* ---- DELETE ---- */
    if ((m = sql.match(/^DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?$/is))) {
      const [, name, where] = m;
      const t = db.tables[name];
      if (!t) return { out: [`Error: no such table: ${name}`], err: true };
      const before = t.rows.length;
      t.rows = where ? t.rows.filter(r => !truthy(evalExpr(parseExpr(where), rowScope(t, r)))) : [];
      return { out: [`(${before - t.rows.length} 行受影响)`] };
    }

    return { out: [`Error: 无法解析 SQL: ${sql.slice(0, 40)}...`], err: true };
  }

  /* ---- 点命令 ---- */
  _dotCommand(db, sql) {
    let m;
    if (/^\.tables$/i.test(sql)) {
      const names = [...Object.keys(db.tables), ...Object.keys(db.views)];
      return { out: [names.join('  ') || '(空)'] };
    }
    if ((m = sql.match(/^\.schema\s*(\w*)$/i))) {
      const names = m[1] ? [m[1]] : Object.keys(db.tables);
      const out = [];
      for (const n of names) {
        const t = db.tables[n];
        if (t) out.push(`CREATE TABLE ${n} (${t.cols.map(c => c + ' TEXT').join(', ')});`);
        else if (db.views[n]) out.push(`CREATE VIEW ${n} AS ${db.views[n].sql};`);
      }
      if (!m[1]) for (const idx of Object.keys(db.indexes)) {
        const info = db.indexes[idx];
        out.push(`CREATE INDEX ${idx} ON ${info.table} (${info.cols.join(', ')});`);
      }
      return { out: out.length ? out : [`Error: no such table: ${m[1]}`], err: !out.length };
    }
    if (/^\.databases$/i.test(sql)) {
      const out = Object.keys(this.databases).map((n, i) => `${i}: ${n}`);
      return { out: out.length ? out : ['(空)'] };
    }
    if ((m = sql.match(/^\.dump\s*(\w*)$/i))) {
      const target = m[1];
      const out = ['BEGIN TRANSACTION;'];
      for (const n of Object.keys(db.tables)) {
        if (target && n !== target) continue;
        const t = db.tables[n];
        out.push(`CREATE TABLE ${n} (${t.cols.map(c => c + ' TEXT').join(', ')});`);
        for (const r of t.rows) out.push(`INSERT INTO ${n} VALUES(${r.map(dumpCell).join(',')});`);
      }
      out.push('COMMIT;');
      return { out };
    }
    if ((m = sql.match(/^\.headers\s+(\w+)$/i))) {
      this.viewMode.headers = /^(on|true|1)$/i.test(m[1]);
      return { out: [] };
    }
    if ((m = sql.match(/^\.mode\s+(\w+)$/i))) {
      this.viewMode.mode = m[1].toLowerCase();
      return { out: [] };
    }
    if (/^\.help$/i.test(sql)) {
      return { out: ['.tables 列出表', '.schema [表] 查看结构', '.databases 列出数据库', '.dump [表] 导出 SQL', '.headers on|off 表头开关', '.mode list|column 输出模式', '.quit 退出'] };
    }
    return { out: [`Error: unknown command or invalid arguments: "${sql.slice(0, 30)}". Enter ".help" for help`], err: true };
  }

  /* ============================================================
   * SELECT 引擎
   * ============================================================ */
  _runSelectSql(db, sql) {
    const parts = splitSetOps(sql);
    if (parts && parts.length > 1) return this._runUnion(db, parts);
    const parsed = this._parseSelect(sql);
    if (!parsed) return { out: [`Error: 无法解析 SQL: ${sql.slice(0, 40)}...`], err: true };
    return this._execSelect(db, parsed);
  }

  _runUnion(db, parts) {
    let header = null;
    let dataRows = [];
    let dedup = false; // 任一 UNION 为 plain（非 ALL）即整体去重
    for (const part of parts) {
      const parsed = this._parseSelect(part.sql);
      if (!parsed) return { out: [`Error: 无法解析 SQL: ${part.sql.slice(0, 40)}...`], err: true };
      const r = this._execSelect(db, parsed);
      if (r.err) return r;
      if (header === null) header = r.out[0] || '';
      dataRows.push(...r.out.slice(1).map(l => l.split('|')));
      if (part.all === false) dedup = true;
    }
    if (dedup) {
      const seen = new Set();
      dataRows = dataRows.filter(cells => {
        const k = cells.join('|');
        if (seen.has(k)) return false;
        seen.add(k); return true;
      });
    }
    const out = header === null ? [] : [header];
    for (const cells of dataRows) out.push(cells.join('|'));
    return { out };
  }

  _execSelect(db, p) {
    _curDb = db;
    // ── FROM + JOIN 构建组合行 ──
    let combined, matRefs;
    if (p.from) {
      const built = this._buildFrom(db, p.from);
      combined = built.combined;
      matRefs = built.matRefs;
    } else {
      combined = [{ '*': [], __refVals: {} }];
      matRefs = [];
    }

    // ── WHERE ──
    const whereAst = p.where ? parseExpr(p.where) : null;
    let rows = whereAst ? combined.filter(s => truthy(evalExpr(whereAst, s))) : combined;

    // ── 选择项 ──
    const sel = this._parseSelectList(p.selRaw);
    const groupMode = !!p.groupBy ||
      sel.items.some(it => !it.star && nodeHasAgg(it.expr)) ||
      (p.having !== null) ||
      (p.orderBy !== null && nodeHasAgg(safeParse(p.orderBy)));

    let outHeader, outRows;
    if (groupMode) {
      // ── 分组聚合 ──
      let groups;
      if (p.groupBy) {
        const keyExprs = splitTop(p.groupBy).map(parseExpr);
        const map = new Map();
        for (const s of rows) {
          const k = keyExprs.map(e => fmtCell(evalExpr(e, s))).join('\u0001');
          if (!map.has(k)) map.set(k, []);
          map.get(k).push(s);
        }
        groups = [...map.values()];
      } else {
        groups = [rows];
      }
      let results = [];
      for (const grows of groups) {
        const cells = sel.items.map(it => it.star ? null : evalExpr(it.expr, grows[0] || {}, grows));
        results.push({ grows, cells });
      }
      if (p.having !== null) {
        const hav = parseExpr(p.having);
        results = results.filter(g => truthy(evalExpr(hav, g.grows[0] || {}, g.grows)));
      }
      if (p.orderBy) {
        const oi = this._orderIndex(sel, p.orderBy);
        if (oi >= 0) {
          results = [...results].sort((a, b) => sortCmp(a.cells[oi], b.cells[oi], p.orderDesc));
        }
      }
      results = applyLimitArr(results, p.lim1, p.lim2, p.limOff);
      outHeader = sel.items.map(it => it.header).join('|');
      outRows = results.map(g => g.cells.map(fmtCell));
    } else {
      // ── 普通行选择 ──
      const headerCols = [];
      for (const it of sel.items) {
        if (it.star) {
          if (it.starTable) {
            const ref = matRefs.find(r => r.alias.toLowerCase() === it.starTable.toLowerCase());
            if (ref) headerCols.push(...ref.cols);
          } else {
            for (const r of matRefs) headerCols.push(...r.cols);
          }
        } else headerCols.push(it.header);
      }
      let dataRows = rows.map(s => {
        const cells = [];
        for (const it of sel.items) {
          if (it.star) {
            if (it.starTable) {
              const ref = matRefs.find(r => r.alias.toLowerCase() === it.starTable.toLowerCase());
              if (ref) cells.push(...(s.__refVals[ref.alias] || []));
            } else cells.push(...(s['*'] || []));
          } else cells.push(evalExpr(it.expr, s));
        }
        return { cells, s };
      });
      if (p.distinct) {
        const seen = new Set();
        dataRows = dataRows.filter(dr => {
          const k = dr.cells.map(fmtCell).join('|');
          if (seen.has(k)) return false;
          seen.add(k); return true;
        });
      }
      if (p.orderBy) {
        const oi = headerCols.findIndex(h => h.toLowerCase() === p.orderBy.toLowerCase());
        if (oi >= 0) {
          dataRows = [...dataRows].sort((a, b) => sortCmp(a.cells[oi], b.cells[oi], p.orderDesc));
        } else {
          const expr = parseExpr(p.orderBy);
          dataRows = [...dataRows].sort((a, b) => sortCmp(evalExpr(expr, a.s), evalExpr(expr, b.s), p.orderDesc));
        }
      }
      dataRows = applyLimitArr(dataRows, p.lim1, p.lim2, p.limOff);
      outHeader = this.viewMode.headers ? headerCols.join('|') : null;
      outRows = dataRows.map(dr => dr.cells.map(fmtCell));
    }

    const out = [];
    if (outHeader !== null && outHeader !== undefined) out.push(outHeader);
    for (const cells of outRows) out.push(cells.map(fmtCell).join('|'));
    return { out };
  }

  _orderIndex(sel, name) {
    const lower = name.toLowerCase();
    return sel.items.findIndex(it =>
      (it.alias || '').toLowerCase() === lower ||
      (it.raw || '').toLowerCase() === lower ||
      (!it.star && it.expr && it.expr.type === 'col' && it.expr.name.toLowerCase() === lower));
  }

  _parseSelectList(selRaw) {
    const items = splitTop(selRaw).map(s => {
      const raw = s.trim();
      if (raw === '*') return { star: true, raw, header: '*' };
      const sm = raw.match(/^(\w+)\.\*$/);
      if (sm) return { star: true, starTable: sm[1], raw, header: '*' };
      const am = raw.match(/^(.+?)\s+AS\s+(\w+)$/is);
      const exprStr = am ? am[1].trim() : raw;
      const alias = am ? am[2] : null;
      const expr = parseExpr(exprStr);
      return { expr, alias, raw, header: alias || selHeader(expr, raw) };
    });
    return { items };
  }

  _parseSelect(sql) {
    const m = sql.match(/^SELECT\s+(DISTINCT\s+)?([\s\S]+?)\s+FROM\s+([\s\S]+)$/i);
    if (!m) {
      const e = sql.match(/^SELECT\s+(DISTINCT\s+)?(.+)$/is);
      if (!e) return null;
      return { distinct: !!e[1], selRaw: e[2].trim(), from: null, where: null, groupBy: null, having: null, orderBy: null, orderDesc: false, lim1: undefined, lim2: undefined, limOff: undefined };
    }
    const distinct = !!m[1];
    const selRaw = m[2].trim();
    const clauses = splitSelectRest(m[3].trim());
    const from = this._parseFrom(clauses.fromPart);
    if (!from) return null;
    return {
      distinct, selRaw, from,
      where: clauses.where, groupBy: clauses.groupBy, having: clauses.having,
      orderBy: clauses.orderBy, orderDesc: clauses.orderDesc,
      lim1: clauses.lim1, lim2: clauses.lim2, limOff: clauses.limOff,
    };
  }

  _parseFrom(str) {
    const toks = tokenizeSql(str);
    if (!toks.length) return null;
    let i = 0;
    const isKw = w => /^(INNER|LEFT|RIGHT|FULL|CROSS|JOIN|WHERE|GROUP|ORDER|HAVING|LIMIT|ON|UNION|,)$/i.test(w);
    const readRef = () => {
      if (i >= toks.length) return null;
      if (toks[i] === '(') {
        let depth = 1, sub = ''; i++;
        while (i < toks.length && depth > 0) {
          if (toks[i] === '(') depth++;
          else if (toks[i] === ')') { depth--; if (depth === 0) { i++; break; } }
          sub += (sub ? ' ' : '') + toks[i]; i++;
        }
        let alias = null;
        if (i < toks.length && /^AS$/i.test(toks[i])) { i++; alias = toks[i++]; }
        else if (i < toks.length && !isKw(toks[i])) alias = toks[i++];
        return { subquery: sub, alias: alias || '_sub' };
      }
      const name = toks[i++];
      let alias = null;
      if (i < toks.length && /^AS$/i.test(toks[i])) { i++; alias = toks[i++]; }
      else if (i < toks.length && !isKw(toks[i])) alias = toks[i++];
      return { name, alias: alias || name };
    };
    const first = readRef();
    if (!first) return null;
    const joins = [];
    while (i < toks.length) {
      const up = (toks[i] || '').toUpperCase();
      let type = null;
      if (up === 'JOIN') { type = 'INNER'; i++; }
      else if (up === 'INNER') { type = 'INNER'; i++; if ((toks[i] || '').toUpperCase() === 'JOIN') i++; }
      else if (up === 'LEFT') { type = 'LEFT'; i++; if ((toks[i] || '').toUpperCase() === 'OUTER') i++; if ((toks[i] || '').toUpperCase() === 'JOIN') i++; }
      else if (up === 'RIGHT') { type = 'RIGHT'; i++; if ((toks[i] || '').toUpperCase() === 'OUTER') i++; if ((toks[i] || '').toUpperCase() === 'JOIN') i++; }
      else if (up === 'FULL') { type = 'FULL'; i++; if ((toks[i] || '').toUpperCase() === 'OUTER') i++; if ((toks[i] || '').toUpperCase() === 'JOIN') i++; }
      else if (up === 'CROSS') { type = 'CROSS'; i++; if ((toks[i] || '').toUpperCase() === 'JOIN') i++; }
      else if (toks[i] === ',') { type = 'CROSS'; i++; }
      else break;
      const ref = readRef();
      if (!ref) break;
      let on = null;
      if (i < toks.length && (toks[i] || '').toUpperCase() === 'ON') {
        i++;
        let onStr = '';
        while (i < toks.length && !/^(INNER|LEFT|RIGHT|FULL|CROSS|JOIN|WHERE|GROUP|ORDER|HAVING|LIMIT|UNION)$/i.test(toks[i])) {
          onStr += (onStr ? ' ' : '') + toks[i]; i++;
        }
        on = parseExpr(onStr);
      }
      joins.push({ type, ref, on });
    }
    first.joins = joins;
    return first;
  }

  _buildFrom(db, from) {
    const first = this._materialize(db, from);
    const matRefs = [first];
    let combined = first.rows.map(r => this._scopeOf(first, r));
    for (const j of from.joins) {
      const jt = this._materialize(db, j.ref);
      matRefs.push(jt);
      const next = [];
      const isLeft = j.type === 'LEFT' || j.type === 'FULL';
      const isRight = j.type === 'RIGHT' || j.type === 'FULL';
      for (const ls of combined) {
        let matched = false;
        for (const rr of jt.rows) {
          const rs = this._scopeOf(jt, rr);
          const merged = this._mergeScope(ls, rs);
          if (!j.on || truthy(evalExpr(j.on, merged))) { next.push(merged); matched = true; }
        }
        if (!matched && isLeft) next.push(this._mergeScope(ls, this._nullScope(jt)));
      }
      if (isRight) {
        for (const rr of jt.rows) {
          const rs = this._scopeOf(jt, rr);
          let matched = false;
          for (const ls of combined) {
            if (!j.on || truthy(evalExpr(j.on, this._mergeScope(ls, rs)))) { matched = true; break; }
          }
          if (!matched) next.push(this._mergeScope(this._nullScope(first), rs));
        }
      }
      combined = next;
    }
    return { combined, matRefs };
  }

  _materialize(db, ref) {
    if (ref.subquery) {
      const r = this._runSelectSql(db, ref.subquery);
      const header = (r.out[0] || '').split('|').filter(Boolean);
      const rows = r.out.slice(1).map(l => l.split('|').map(coerceOut));
      return { cols: header, rows, alias: ref.alias, name: ref.alias };
    }
    const t = db.tables[ref.name];
    if (t) return { cols: t.cols, rows: t.rows, alias: ref.alias, name: ref.name };
    const v = db.views[ref.name];
    if (v) {
      const r = this._runSelectSql(db, v.sql);
      const header = (r.out[0] || '').split('|').filter(Boolean);
      const rows = r.out.slice(1).map(l => l.split('|').map(coerceOut));
      return { cols: header, rows, alias: ref.alias, name: ref.name };
    }
    throw new Error(`no such table: ${ref.name}`);
  }

  _scopeOf(tab, row) {
    const s = { '*': [...row], __refVals: { [tab.alias]: [...row] } };
    if (tab.name !== tab.alias) s.__refVals[tab.name] = [...row];
    tab.cols.forEach((c, idx) => {
      s[tab.alias + '.' + c] = row[idx];
      if (tab.name !== tab.alias) s[tab.name + '.' + c] = row[idx];
    });
    return s;
  }
  _nullScope(tab) {
    const s = { '*': tab.cols.map(() => null), __refVals: { [tab.alias]: tab.cols.map(() => null) } };
    if (tab.name !== tab.alias) s.__refVals[tab.name] = tab.cols.map(() => null);
    for (const c of tab.cols) { s[tab.alias + '.' + c] = null; if (tab.name !== tab.alias) s[tab.name + '.' + c] = null; }
    return s;
  }
  _mergeScope(a, b) {
    return {
      ...a, ...b,
      '*': [...(a['*'] || []), ...(b['*'] || [])],
      __refVals: { ...(a.__refVals || {}), ...(b.__refVals || {}) },
    };
  }

  /* ============================================================
   * Redis 命令：返回 { out: [行], err }
   * ============================================================ */
  execRedis(cmd) {
    this._purgeExpired();
    const t = splitRedisArgs(cmd);
    const op = (t[0] || '').toUpperCase();
    const key = t[1];
    const R = this.redis;

    // ── MULTI/EXEC/DISCARD 事务 ──
    if (this.redisMulti) {
      if (op === 'MULTI') return { out: ['(error) MULTI calls can not be nested'], err: true };
      if (op === 'EXEC') {
        const queue = this.redisMulti; this.redisMulti = null;
        if (!queue.length) return { out: ['(empty array)'] };
        const lines = [];
        queue.forEach((c, i) => {
          const r = this.execRedis(c);
          if (r.out.length === 1) lines.push(`${i + 1}) ${r.out[0]}`);
          else { lines.push(`${i + 1})`); r.out.forEach(l => lines.push('   ' + l)); }
        });
        return { out: lines };
      }
      if (op === 'DISCARD') { this.redisMulti = null; return { out: ['OK'] }; }
      this.redisMulti.push(cmd.trim());
      return { out: ['QUEUED'] };
    }

    switch (op) {
      /* ===== 字符串 ===== */
      case 'SET': {
        if (!key || t[2] === undefined) return { out: ['(error) wrong number of arguments for \'set\' command'], err: true };
        const value = t[2];
        let ex = null, nx = false, xx = false;
        for (let i = 3; i < t.length; i++) {
          const o = t[i].toUpperCase();
          if (o === 'EX') ex = toInt(t[++i]);
          else if (o === 'PX') { const px = toInt(t[++i]); ex = isNaN(px) ? NaN : px / 1000; }
          else if (o === 'NX') nx = true;
          else if (o === 'XX') xx = true;
        }
        if (nx && this._rExists(key)) return { out: ['(nil)'] };
        if (xx && !this._rExists(key)) return { out: ['(nil)'] };
        R.kv[key] = { value, type: 'string' };
        if (ex !== null && !isNaN(ex)) R.expiry[key] = Date.now() + ex * 1000;
        else delete R.expiry[key];
        return { out: ['OK'] };
      }
      case 'GET': {
        if (R.lists[key] || R.hashes[key] || R.sets[key] || R.zsets[key]) return { out: ['(error) WRONGTYPE Operation against a key holding the wrong kind of value'], err: true };
        const v = R.kv[key];
        return { out: [v ? `"${v.value}"` : '(nil)'] };
      }
      case 'GETSET': {
        if (!key || t[2] === undefined) return { out: ['(error) wrong number of arguments for \'getset\' command'], err: true };
        const old = R.kv[key] ? R.kv[key].value : null;
        R.kv[key] = { value: t[2], type: 'string' };
        return { out: [old === null ? '(nil)' : `"${old}"`] };
      }
      case 'GETDEL': {
        const v = R.kv[key];
        if (!v) return { out: ['(nil)'] };
        const old = v.value;
        this._rDel(key);
        return { out: [`"${old}"`] };
      }
      case 'GETRANGE': {
        const v = R.kv[key] ? R.kv[key].value : '';
        let start = toInt(t[2]), end = t[3] === undefined ? -1 : toInt(t[3]);
        if (isNaN(start)) start = 0;
        if (isNaN(end)) end = -1;
        const len = v.length;
        if (start < 0) start = Math.max(0, len + start);
        if (end < 0) end = len + end;
        return { out: [`"${v.slice(start, end + 1)}"`] };
      }
      case 'SETRANGE': {
        const offset = toInt(t[2]);
        if (isNaN(offset) || offset < 0) return { out: ['(error) offset is out of range'], err: true };
        const val = t[3] === undefined ? '' : t[3];
        let cur = R.kv[key] ? R.kv[key].value : '';
        while (cur.length < offset) cur += '\0';
        cur = cur.slice(0, offset) + val + cur.slice(offset + val.length);
        R.kv[key] = { value: cur, type: 'string' };
        return { out: [`(integer) ${cur.length}`] };
      }
      case 'SETEX': case 'PSETEX': {
        const secs = toInt(t[2]);
        if (!key || t[3] === undefined || isNaN(secs) || secs <= 0) return { out: [`(error) invalid expire time in '${op.toLowerCase()}' command`], err: true };
        R.kv[key] = { value: t[3], type: 'string' };
        R.expiry[key] = Date.now() + (op === 'SETEX' ? secs * 1000 : secs);
        return { out: ['OK'] };
      }
      case 'SETNX': {
        if (!key || t[2] === undefined) return { out: ['(error) wrong number of arguments for \'setnx\' command'], err: true };
        if (this._rExists(key)) return { out: ['(integer) 0'] };
        R.kv[key] = { value: t.slice(2).join(' '), type: 'string' };
        return { out: ['(integer) 1'] };
      }
      case 'DEL': {
        let n = 0;
        for (const k of t.slice(1)) n += this._rDel(k);
        return { out: [`(integer) ${n}`] };
      }
      case 'KEYS': {
        const pat = globToRe(key || '*');
        const matched = this._rAllKeys().filter(k => pat.test(k));
        return { out: matched.length ? matched.map((k, i) => `${i + 1}) "${k}"`) : ['(empty list)'] };
      }
      case 'EXISTS': {
        const keys = t.slice(1);
        if (!keys.length) return { out: ['(error) wrong number of arguments for \'exists\' command'], err: true };
        let n = 0;
        for (const k of keys) if (this._rExists(k)) n++;
        return { out: [`(integer) ${n}`] };
      }
      case 'INCR': case 'DECR': {
        const v = R.kv[key];
        const cur = v ? parseInt(v.value) : 0;
        if (v && (isNaN(cur) || !/^-?\d+$/.test(String(v.value).trim()))) return { out: ['(error) value is not an integer or out of range'], err: true };
        const next = op === 'INCR' ? cur + 1 : cur - 1;
        R.kv[key] = { value: String(next), type: 'string' };
        return { out: [`(integer) ${next}`] };
      }
      case 'INCRBY': case 'DECRBY': {
        const n = toInt(t[2]);
        if (isNaN(n)) return { out: ['(error) value is not an integer or out of range'], err: true };
        const v = R.kv[key];
        const cur = v ? parseInt(v.value) : 0;
        if (v && isNaN(cur)) return { out: ['(error) value is not an integer or out of range'], err: true };
        const next = op === 'INCRBY' ? cur + n : cur - n;
        R.kv[key] = { value: String(next), type: 'string' };
        return { out: [`(integer) ${next}`] };
      }
      case 'INCRBYFLOAT': {
        const inc = parseFloat(t[2]);
        if (isNaN(inc)) return { out: ['(error) value is not a valid float'], err: true };
        const v = R.kv[key];
        const cur = v ? parseFloat(v.value) : 0;
        if (v && isNaN(cur)) return { out: ['(error) value is not a valid float'], err: true };
        const next = fmtFloat(cur + inc);
        R.kv[key] = { value: next, type: 'string' };
        return { out: [`"${next}"`] };
      }
      case 'TYPE': return { out: [this._rType(key)] };
      case 'APPEND': {
        if (!key || t[2] === undefined) return { out: ['(error) wrong number of arguments for \'append\' command'], err: true };
        if (R.lists[key] || R.hashes[key] || R.sets[key] || R.zsets[key]) return { out: ['(error) WRONGTYPE Operation against a key holding the wrong kind of value'], err: true };
        const cur = R.kv[key] ? R.kv[key].value : '';
        R.kv[key] = { value: cur + t.slice(2).join(' '), type: 'string' };
        return { out: [`(integer) ${R.kv[key].value.length}`] };
      }
      case 'STRLEN': return { out: [`(integer) ${R.kv[key] ? R.kv[key].value.length : 0}`] };
      case 'MSET': {
        const args = t.slice(1);
        if (args.length < 2 || args.length % 2) return { out: ['(error) wrong number of arguments for \'mset\' command'], err: true };
        for (let i = 0; i < args.length; i += 2) { R.kv[args[i]] = { value: args[i + 1], type: 'string' }; delete R.expiry[args[i]]; }
        return { out: ['OK'] };
      }
      case 'MGET': {
        const keys = t.slice(1);
        if (!keys.length) return { out: ['(error) wrong number of arguments for \'mget\' command'], err: true };
        return { out: keys.map((k, i) => `${i + 1}) ${R.kv[k] ? `"${R.kv[k].value}"` : '(nil)'}`) };
      }

      /* ===== 列表 ===== */
      case 'LPUSH': case 'RPUSH': {
        if (!key || t.length < 3) return { out: [`(error) wrong number of arguments for '${op.toLowerCase()}' command`], err: true };
        if (R.kv[key] || R.hashes[key] || R.sets[key] || R.zsets[key]) return { out: ['(error) WRONGTYPE Operation against a key holding the wrong kind of value'], err: true };
        if (!R.lists[key]) R.lists[key] = [];
        if (op === 'LPUSH') R.lists[key].unshift(...t.slice(2));
        else R.lists[key].push(...t.slice(2));
        return { out: [`(integer) ${R.lists[key].length}`] };
      }
      case 'LRANGE': {
        const list = R.lists[key] || [];
        let start = parseInt(t[2]) || 0, stop = t[3] === undefined ? -1 : parseInt(t[3]);
        const len = list.length;
        if (start < 0) start = Math.max(0, len + start);
        if (stop < 0) stop = len + stop;
        const slice = list.slice(start, stop + 1);
        return { out: slice.length ? slice.map((v, i) => `${i + 1}) "${v}"`) : ['(empty list)'] };
      }
      case 'LLEN': return { out: [`(integer) ${(R.lists[key] || []).length}`] };
      case 'LPOP': case 'RPOP': {
        const list = R.lists[key];
        if (!list || !list.length) return { out: ['(nil)'] };
        const v = op === 'LPOP' ? list.shift() : list.pop();
        if (!list.length) { delete R.lists[key]; delete R.expiry[key]; }
        return { out: [`"${v}"`] };
      }
      case 'LINDEX': {
        const i = toInt(t[2]);
        if (isNaN(i)) return { out: ['(error) value is not an integer or out of range'], err: true };
        const list = R.lists[key] || [];
        const idx = i < 0 ? list.length + i : i;
        return { out: [list[idx] !== undefined ? `"${list[idx]}"` : '(nil)'] };
      }
      case 'LINSERT': {
        const pos = (t[2] || '').toUpperCase();
        if (pos !== 'BEFORE' && pos !== 'AFTER') return { out: ['(error) syntax error'], err: true };
        const list = R.lists[key];
        if (!list) return { out: ['(integer) 0'] };
        const idx = list.indexOf(t[3]);
        if (idx < 0) return { out: ['(integer) -1'] };
        list.splice(pos === 'BEFORE' ? idx : idx + 1, 0, t[4]);
        return { out: [`(integer) ${list.length}`] };
      }
      case 'LSET': {
        const i = toInt(t[2]);
        if (isNaN(i)) return { out: ['(error) value is not an integer or out of range'], err: true };
        const list = R.lists[key];
        if (!list) return { out: ['(error) no such key'], err: true };
        const idx = i < 0 ? list.length + i : i;
        if (idx < 0 || idx >= list.length) return { out: ['(error) index out of range'], err: true };
        list[idx] = t[3];
        return { out: ['OK'] };
      }
      case 'LTRIM': {
        const list = R.lists[key];
        if (!list) return { out: ['OK'] };
        let start = toInt(t[2]), stop = toInt(t[3]);
        const len = list.length;
        if (isNaN(start)) start = 0;
        if (isNaN(stop)) stop = -1;
        if (start < 0) start = Math.max(0, len + start);
        if (stop < 0) stop = len + stop;
        const trimmed = list.slice(start, stop + 1);
        if (trimmed.length) R.lists[key] = trimmed;
        else { delete R.lists[key]; delete R.expiry[key]; }
        return { out: ['OK'] };
      }
      case 'LREM': {
        const count = toInt(t[2]);
        if (isNaN(count)) return { out: ['(error) value is not an integer or out of range'], err: true };
        const list = R.lists[key];
        if (!list) return { out: ['(integer) 0'] };
        const val = t[3];
        let removed = 0;
        if (count > 0) {
          for (let i = 0; i < list.length && removed < count;) {
            if (list[i] === val) { list.splice(i, 1); removed++; } else i++;
          }
        } else if (count < 0) {
          for (let i = list.length - 1; i >= 0 && removed < -count; i--) {
            if (list[i] === val) { list.splice(i, 1); removed++; }
          }
        } else {
          for (let i = 0; i < list.length;) {
            if (list[i] === val) { list.splice(i, 1); removed++; } else i++;
          }
        }
        if (!list.length) { delete R.lists[key]; delete R.expiry[key]; }
        return { out: [`(integer) ${removed}`] };
      }
      case 'RPOPLPUSH': {
        const src = R.lists[key];
        if (!src || !src.length) return { out: ['(nil)'] };
        const v = src.pop();
        if (!src.length) { delete R.lists[key]; delete R.expiry[key]; }
        const dst = t[2];
        if (!R.lists[dst]) R.lists[dst] = [];
        R.lists[dst].unshift(v);
        return { out: [`"${v}"`] };
      }

      /* ===== 哈希 ===== */
      case 'HSET': {
        if (!key || t.length < 4) return { out: ['(error) wrong number of arguments for \'hset\' command'], err: true };
        if (!R.hashes[key]) R.hashes[key] = {};
        let added = 0;
        const args = t.slice(2);
        for (let i = 0; i + 1 < args.length; i += 2) {
          if (!(args[i] in R.hashes[key])) added++;
          R.hashes[key][args[i]] = args[i + 1];
        }
        return { out: [`(integer) ${added}`] };
      }
      case 'HGET': {
        const h = R.hashes[key];
        return { out: [h && h[t[2]] !== undefined ? `"${h[t[2]]}"` : '(nil)'] };
      }
      case 'HGETALL': {
        const h = R.hashes[key] || {};
        const out = [];
        Object.entries(h).forEach(([f, v], i) => out.push(`${i * 2 + 1}) "${f}"`, `${i * 2 + 2}) "${v}"`));
        return { out: out.length ? out : ['(empty list)'] };
      }
      case 'HDEL': {
        const h = R.hashes[key];
        const fields = t.slice(2);
        if (!h || !fields.length) return { out: ['(integer) 0'] };
        let n = 0;
        for (const f of fields) if (f in h) { delete h[f]; n++; }
        if (!Object.keys(h).length) { delete R.hashes[key]; delete R.expiry[key]; }
        return { out: [`(integer) ${n}`] };
      }
      case 'HEXISTS': return { out: [`(integer) ${R.hashes[key] && t[2] in R.hashes[key] ? 1 : 0}`] };
      case 'HKEYS': {
        const ks = Object.keys(R.hashes[key] || {});
        return { out: ks.length ? ks.map((f, i) => `${i + 1}) "${f}"`) : ['(empty list)'] };
      }
      case 'HVALS': {
        const vs = Object.values(R.hashes[key] || {});
        return { out: vs.length ? vs.map((v, i) => `${i + 1}) "${v}"`) : ['(empty list)'] };
      }
      case 'HLEN': return { out: [`(integer) ${Object.keys(R.hashes[key] || {}).length}`] };
      case 'HMSET': {
        const args = t.slice(2);
        if (!key || args.length < 2 || args.length % 2) return { out: ['(error) wrong number of arguments for \'hmset\' command'], err: true };
        if (!R.hashes[key]) R.hashes[key] = {};
        for (let i = 0; i < args.length; i += 2) R.hashes[key][args[i]] = args[i + 1];
        return { out: ['OK'] };
      }
      case 'HMGET': {
        const fs = t.slice(2);
        if (!fs.length) return { out: ['(error) wrong number of arguments for \'hmget\' command'], err: true };
        const h = R.hashes[key] || {};
        return { out: fs.map((f, i) => `${i + 1}) ${h[f] !== undefined ? `"${h[f]}"` : '(nil)'}`) };
      }
      case 'HINCRBY': {
        const n = toInt(t[3]);
        if (isNaN(n)) return { out: ['(error) value is not an integer or out of range'], err: true };
        if (!R.hashes[key]) R.hashes[key] = {};
        const cur = R.hashes[key][t[2]] !== undefined ? parseInt(R.hashes[key][t[2]]) : 0;
        if (isNaN(cur)) return { out: ['(error) hash value is not an integer'], err: true };
        R.hashes[key][t[2]] = String(cur + n);
        return { out: [`(integer) ${cur + n}`] };
      }

      /* ===== 集合 ===== */
      case 'SADD': {
        if (!key || t.length < 3) return { out: ['(error) wrong number of arguments for \'sadd\' command'], err: true };
        if (!R.sets[key]) R.sets[key] = new Set();
        let n = 0;
        for (const m of t.slice(2)) if (!R.sets[key].has(m)) { R.sets[key].add(m); n++; }
        return { out: [`(integer) ${n}`] };
      }
      case 'SREM': {
        const s = R.sets[key];
        if (!s) return { out: ['(integer) 0'] };
        let n = 0;
        for (const m of t.slice(2)) if (s.has(m)) { s.delete(m); n++; }
        if (!s.size) { delete R.sets[key]; delete R.expiry[key]; }
        return { out: [`(integer) ${n}`] };
      }
      case 'SMEMBERS': {
        const arr = [...(R.sets[key] || [])];
        return { out: arr.length ? arr.map((v, i) => `${i + 1}) "${v}"`) : ['(empty list)'] };
      }
      case 'SISMEMBER': return { out: [`(integer) ${R.sets[key] && R.sets[key].has(t[2]) ? 1 : 0}`] };
      case 'SCARD': return { out: [`(integer) ${(R.sets[key] || new Set()).size}`] };
      case 'SUNION': case 'SINTER': case 'SDIFF': {
        const keys = t.slice(1);
        if (!keys.length) return { out: [`(error) wrong number of arguments for '${op.toLowerCase()}' command`], err: true };
        const sets = keys.map(k => new Set(R.sets[k] || []));
        let res;
        if (op === 'SUNION') { res = new Set(); for (const s of sets) for (const v of s) res.add(v); }
        else if (op === 'SINTER') { res = new Set(sets[0]); for (const s of sets.slice(1)) for (const v of [...res]) if (!s.has(v)) res.delete(v); }
        else { res = new Set(sets[0]); for (const s of sets.slice(1)) for (const v of s) res.delete(v); }
        const arr = [...res];
        return { out: arr.length ? arr.map((v, i) => `${i + 1}) "${v}"`) : ['(empty list)'] };
      }
      case 'SPOP': {
        const s = R.sets[key];
        if (!s || !s.size) return { out: ['(nil)'] };
        const count = t[2] === undefined ? 1 : toInt(t[2]);
        if (isNaN(count) || count < 0) return { out: ['(error) value is not an integer or out of range'], err: true };
        const picked = [];
        for (let i = 0; i < count && s.size; i++) {
          const v = [...s][0];
          s.delete(v); picked.push(v);
        }
        if (!s.size) { delete R.sets[key]; delete R.expiry[key]; }
        if (t[2] === undefined) return { out: [`"${picked[0]}"`] };
        return { out: picked.length ? picked.map((v, i) => `${i + 1}) "${v}"`) : ['(empty list)'] };
      }
      case 'SRANDMEMBER': {
        const s = R.sets[key];
        if (!s || !s.size) return { out: ['(nil)'] };
        const arr = [...s];
        if (t[2] === undefined) return { out: [`"${arr[0]}"`] };
        const count = toInt(t[2]);
        if (isNaN(count)) return { out: ['(error) value is not an integer or out of range'], err: true };
        if (count >= 0) {
          const picked = arr.slice(0, count);
          return { out: picked.length ? picked.map((v, i) => `${i + 1}) "${v}"`) : ['(empty list)'] };
        }
        const picked = [];
        for (let i = 0; i < -count; i++) picked.push(arr[i % arr.length]);
        return { out: picked.map((v, i) => `${i + 1}) "${v}"`) };
      }

      /* ===== 有序集合 ===== */
      case 'ZADD': {
        if (!key || t.length < 4) return { out: ['(error) wrong number of arguments for \'zadd\' command'], err: true };
        if (!R.zsets[key]) R.zsets[key] = [];
        const args = t.slice(2);
        let added = 0;
        for (let i = 0; i + 1 < args.length; i += 2) {
          const score = parseFloat(args[i]), member = args[i + 1];
          if (isNaN(score)) return { out: ['(error) value is not a valid float'], err: true };
          const ex = R.zsets[key].find(x => x.member === member);
          if (ex) ex.score = score;
          else { R.zsets[key].push({ score, member }); added++; }
        }
        zsort(R.zsets[key]);
        return { out: [`(integer) ${added}`] };
      }
      case 'ZRANGE': case 'ZREVRANGE': {
        let z = R.zsets[key] ? [...R.zsets[key]] : [];
        if (op === 'ZREVRANGE') z = z.reverse();
        let start = toInt(t[2]), stop = toInt(t[3]);
        if (isNaN(start)) start = 0;
        if (isNaN(stop)) stop = -1;
        const len = z.length;
        if (start < 0) start = Math.max(0, len + start);
        if (stop < 0) stop = len + stop;
        const withScores = (t[4] || '').toUpperCase() === 'WITHSCORES';
        const slice = z.slice(start, stop + 1);
        const out = [];
        slice.forEach(m => {
          out.push(`${out.length + 1}) "${m.member}"`);
          if (withScores) out.push(`${out.length + 1}) "${fmtFloat(m.score)}"`);
        });
        return { out: out.length ? out : ['(empty list)'] };
      }
      case 'ZRANGEBYSCORE': {
        const z = R.zsets[key] ? [...R.zsets[key]] : [];
        const parseBound = s => {
          if (s === '-inf') return { v: -Infinity, ex: false };
          if (s === '+inf' || s === 'inf') return { v: Infinity, ex: false };
          if (s.startsWith('(')) return { v: parseFloat(s.slice(1)), ex: true };
          return { v: parseFloat(s), ex: false };
        };
        const min = parseBound(t[2]), max = parseBound(t[3]);
        let slice = z.filter(m =>
          (min.ex ? m.score > min.v : m.score >= min.v) &&
          (max.ex ? m.score < max.v : m.score <= max.v));
        const limIdx = t.findIndex(x => x.toUpperCase() === 'LIMIT');
        if (limIdx >= 0) {
          const off = toInt(t[limIdx + 1]) || 0, cnt = toInt(t[limIdx + 2]) || 0;
          slice = slice.slice(off, off + cnt);
        }
        const withScores = t.some(x => x.toUpperCase() === 'WITHSCORES');
        const out = [];
        slice.forEach(m => {
          out.push(`${out.length + 1}) "${m.member}"`);
          if (withScores) out.push(`${out.length + 1}) "${fmtFloat(m.score)}"`);
        });
        return { out: out.length ? out : ['(empty list)'] };
      }
      case 'ZSCORE': {
        const m = (R.zsets[key] || []).find(x => x.member === t[2]);
        return { out: [m ? `"${fmtFloat(m.score)}"` : '(nil)'] };
      }
      case 'ZCARD': return { out: [`(integer) ${(R.zsets[key] || []).length}`] };
      case 'ZINCRBY': {
        const inc = parseFloat(t[2]);
        if (isNaN(inc)) return { out: ['(error) value is not a valid float'], err: true };
        if (!R.zsets[key]) R.zsets[key] = [];
        const m = R.zsets[key].find(x => x.member === t[3]);
        const next = m ? m.score + inc : inc;
        if (m) m.score = next; else R.zsets[key].push({ score: next, member: t[3] });
        zsort(R.zsets[key]);
        return { out: [`"${fmtFloat(next)}"`] };
      }
      case 'ZREM': {
        const z = R.zsets[key];
        if (!z) return { out: ['(integer) 0'] };
        let n = 0;
        for (const member of t.slice(2)) {
          const i = z.findIndex(x => x.member === member);
          if (i >= 0) { z.splice(i, 1); n++; }
        }
        if (!z.length) { delete R.zsets[key]; delete R.expiry[key]; }
        return { out: [`(integer) ${n}`] };
      }
      case 'ZRANK': case 'ZREVRANK': {
        let z = R.zsets[key] || [];
        if (op === 'ZREVRANK') z = [...z].reverse();
        const i = z.findIndex(x => x.member === t[2]);
        return { out: [i >= 0 ? `(integer) ${i}` : '(nil)'] };
      }

      /* ===== 键管理 ===== */
      case 'EXPIRE': {
        const secs = toInt(t[2]);
        if (isNaN(secs)) return { out: ['(error) value is not an integer or out of range'], err: true };
        if (!this._rExists(key)) return { out: ['(integer) 0'] };
        R.expiry[key] = Date.now() + secs * 1000;
        return { out: ['(integer) 1'] };
      }
      case 'PEXPIRE': {
        const ms = toInt(t[2]);
        if (isNaN(ms)) return { out: ['(error) value is not an integer or out of range'], err: true };
        if (!this._rExists(key)) return { out: ['(integer) 0'] };
        R.expiry[key] = Date.now() + ms;
        return { out: ['(integer) 1'] };
      }
      case 'EXPIREAT': {
        const ts = toInt(t[2]);
        if (isNaN(ts)) return { out: ['(error) value is not an integer or out of range'], err: true };
        if (!this._rExists(key)) return { out: ['(integer) 0'] };
        R.expiry[key] = ts * 1000;
        return { out: ['(integer) 1'] };
      }
      case 'TTL': {
        if (!this._rExists(key)) return { out: ['(integer) -2'] };
        if (R.expiry[key] === undefined) return { out: ['(integer) -1'] };
        return { out: [`(integer) ${Math.max(0, Math.ceil((R.expiry[key] - Date.now()) / 1000))}`] };
      }
      case 'PTTL': {
        if (!this._rExists(key)) return { out: ['(integer) -2'] };
        if (R.expiry[key] === undefined) return { out: ['(integer) -1'] };
        return { out: [`(integer) ${Math.max(0, Math.ceil(R.expiry[key] - Date.now()))}`] };
      }
      case 'PERSIST': {
        if (R.expiry[key] === undefined) return { out: ['(integer) 0'] };
        delete R.expiry[key];
        return { out: ['(integer) 1'] };
      }
      case 'RENAME': {
        if (!this._rExists(key)) return { out: ['(error) no such key'], err: true };
        const newKey = t[2];
        if (!newKey) return { out: ['(error) wrong number of arguments for \'rename\' command'], err: true };
        const val = this._rCopyVal(key);
        const exp = R.expiry[key];
        this._rDel(key);
        this._rPut(newKey, val);
        if (exp !== undefined) R.expiry[newKey] = exp;
        return { out: ['OK'] };
      }
      case 'RENAMENX': {
        if (!this._rExists(key)) return { out: ['(error) no such key'], err: true };
        const newKey = t[2];
        if (this._rExists(newKey)) return { out: ['(integer) 0'] };
        const val = this._rCopyVal(key);
        const exp = R.expiry[key];
        this._rDel(key);
        this._rPut(newKey, val);
        if (exp !== undefined) R.expiry[newKey] = exp;
        return { out: ['(integer) 1'] };
      }
      case 'RANDOMKEY': {
        const all = this._rAllKeys();
        return { out: [all.length ? `"${all[0]}"` : '(nil)'] };
      }
      case 'SCAN': {
        const mi = t.findIndex(x => x.toUpperCase() === 'MATCH');
        const pat = globToRe(mi >= 0 ? (t[mi + 1] || '*') : '*');
        const ci = t.findIndex(x => x.toUpperCase() === 'COUNT');
        const count = ci >= 0 ? toInt(t[ci + 1]) : 10;
        const matched = this._rAllKeys().filter(k => pat.test(k)).slice(0, isNaN(count) ? 10 : count);
        const out = ['0'];
        if (matched.length) matched.forEach((k, i) => out.push(`${i + 1}) "${k}"`));
        else out.push('(empty list)');
        return { out };
      }
      case 'OBJECT': {
        const sub = (t[1] || '').toUpperCase();
        const target = t[2];
        if (sub === 'ENCODING') {
          if (!this._rExists(target)) return { out: ['(error) no such key'], err: true };
          const enc = R.kv[target] ? 'embstr' : R.lists[target] ? 'listpack' : R.hashes[target] ? 'listpack' : R.sets[target] ? 'listpack' : 'skiplist';
          return { out: [enc] };
        }
        if (sub === 'REFCOUNT') return this._rExists(target) ? { out: ['(integer) 1'] } : { out: ['(error) no such key'], err: true };
        if (sub === 'IDLETIME' || sub === 'FREQ') return this._rExists(target) ? { out: ['(integer) 0'] } : { out: ['(error) no such key'], err: true };
        if (sub === 'HELP') return { out: ['OBJECT <subcommand> [<key>] — ENCODING / REFCOUNT / IDLETIME / FREQ / HELP'] };
        return { out: ['(error) unknown OBJECT subcommand'], err: true };
      }
      case 'COPY': {
        const src = key, dst = t[2];
        if (!src || !dst) return { out: ['(error) wrong number of arguments for \'copy\' command'], err: true };
        if (!this._rExists(src)) return { out: ['(error) no such key'], err: true };
        const replace = t.some(x => x.toUpperCase() === 'REPLACE');
        if (this._rExists(dst) && !replace) return { out: ['(integer) 0'] };
        this._rPut(dst, this._rCopyVal(src));
        return { out: ['(integer) 1'] };
      }

      /* ===== 服务器 / 其它 ===== */
      case 'PING': return { out: [t[1] !== undefined ? `"${t.slice(1).join(' ')}"` : 'PONG'] };
      case 'DBSIZE': return { out: [`(integer) ${this._rAllKeys().length}`] };
      case 'SELECT': {
        const idx = toInt(t[1]);
        if (isNaN(idx) || idx < 0 || idx > 15) return { out: ['(error) DB index is out of range'], err: true };
        this.redisDbIndex = idx;
        return { out: ['OK'] };
      }
      case 'FLUSHDB': case 'FLUSHALL': {
        R.kv = {}; R.lists = {}; R.hashes = {}; R.sets = {}; R.zsets = {}; R.expiry = {};
        return { out: ['OK'] };
      }
      case 'INFO': {
        return {
          out: [
            '# Server', 'redis_version:7.2.0', 'redis_mode:standalone', 'os:TermQuest', 'tcp_port:6379', '',
            '# Keyspace', `db${this.redisDbIndex}:keys=${this._rAllKeys().length},expires=${Object.keys(R.expiry).length}`,
          ],
        };
      }
      case 'MULTI': { this.redisMulti = []; return { out: ['OK'] }; }
      case 'DISCARD': return { out: ['(error) DISCARD without MULTI'], err: true };
      case 'EXEC': return { out: ['(error) EXEC without MULTI'], err: true };
      case 'ECHO': return { out: [`"${t.slice(1).join(' ')}"`] };
      case 'COMMAND': return { out: ['OK'] };
      case 'TIME': { const now = Date.now(); return { out: [`1) ${Math.floor(now / 1000)}`, '2) 0'] }; }
      default:
        return { out: [`(error) unknown command '${t[0]}', with args beginning with: ${t.slice(1).map(a => `'${a}'`).join(' ')}`], err: true };
    }
  }
}

/* ============================================================
 * SQL 辅助函数
 * ============================================================ */

function splitValueGroups(s) {
  const groups = [];
  let depth = 0, q = null, cur = '';
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if (ch === '(') { depth++; if (depth === 1) { cur = ''; continue; } }
    else if (ch === ')') { depth--; if (depth === 0) { groups.push(cur); cur = ''; continue; } }
    if (depth >= 1) cur += ch;
  }
  return groups;
}

function parseValues(s) {
  const vals = [];
  let cur = '', q = null;
  for (const ch of s) {
    if (q) { if (ch === q) q = null; else cur += ch; }
    else if (ch === "'" || ch === '"') q = ch;
    else if (ch === ',') { vals.push(coerce(cur.trim())); cur = ''; }
    else cur += ch;
  }
  if (cur.trim() !== '' || vals.length) vals.push(coerce(cur.trim()));
  return vals;
}

function coerce(s) {
  if (s === 'NULL' || s === 'null') return null;
  if (s !== '' && !isNaN(parseFloat(s)) && String(parseFloat(s)) === s) return parseFloat(s);
  return s;
}
function coerceOut(s) {
  if (s === '') return null;
  if (/^-?\d+$/.test(s)) return parseInt(s);
  if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

function splitTop(s) {
  const parts = [];
  let cur = '', depth = 0, q = null;
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

// 顶层 UNION / UNION ALL 拆分
function splitSetOps(sql) {
  const toks = tokenizeSql(sql);
  const parts = [];
  let cur = [], depth = 0, pendingAll = null;
  for (let i = 0; i < toks.length; i++) {
    if (toks[i] === '(') depth++;
    else if (toks[i] === ')') depth--;
    if (depth === 0 && toks[i].toUpperCase() === 'UNION') {
      parts.push({ sql: cur.join(' '), all: pendingAll });
      cur = [];
      if ((toks[i + 1] || '').toUpperCase() === 'ALL') { pendingAll = true; i++; }
      else pendingAll = false;
      continue;
    }
    cur.push(toks[i]);
  }
  parts.push({ sql: cur.join(' '), all: pendingAll });
  return parts.length > 1 ? parts : null;
}

// 从 FROM 之后的串里按顶层关键字切出各子句
function splitSelectRest(rest) {
  const toks = tokenizeSql(rest);
  const found = [];
  let depth = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === '(') depth++;
    else if (t === ')') depth--;
    if (depth > 0) continue;
    const up = t.toUpperCase();
    const nextUp = (toks[i + 1] || '').toUpperCase();
    if (up === 'WHERE') found.push({ kw: 'where', i, skip: 1 });
    else if (up === 'GROUP' && nextUp === 'BY') found.push({ kw: 'group', i, skip: 2 });
    else if (up === 'HAVING') found.push({ kw: 'having', i, skip: 1 });
    else if (up === 'ORDER' && nextUp === 'BY') found.push({ kw: 'order', i, skip: 2 });
    else if (up === 'LIMIT') found.push({ kw: 'limit', i, skip: 1 });
  }
  found.sort((a, b) => a.i - b.i);
  const res = { fromPart: rest, where: null, groupBy: null, having: null, orderBy: null, orderDesc: false, lim1: undefined, lim2: undefined, limOff: undefined };
  if (!found.length) { res.fromPart = toks.join(' '); return res; }
  res.fromPart = toks.slice(0, found[0].i).join(' ');
  found.forEach((f, idx) => {
    const end = idx + 1 < found.length ? found[idx + 1].i : toks.length;
    const content = toks.slice(f.i + f.skip, end).join(' ').trim();
    if (f.kw === 'where') res.where = content;
    else if (f.kw === 'group') res.groupBy = content;
    else if (f.kw === 'having') res.having = content;
    else if (f.kw === 'order') {
      let c = content;
      if (/\s+DESC$/i.test(c)) { res.orderDesc = true; c = c.replace(/\s+DESC$/i, ''); }
      else c = c.replace(/\s+ASC$/i, '');
      res.orderBy = c.trim();
    } else if (f.kw === 'limit') {
      const lm = content.match(/^(\d+)(?:\s*,\s*(\d+)|\s+OFFSET\s+(\d+))?$/i);
      if (lm) { res.lim1 = lm[1]; res.lim2 = lm[2]; res.limOff = lm[3]; }
    }
  });
  return res;
}

// SQL 分词：保留引号串、把粘连的运算符切开（a>10 → a > 10）
function tokenizeSql(s) {
  const toks = [];
  const re = /'[^']*'|"[^"]*"|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*|\d+\.\d+|\d+|!=|<>|>=|<=|[-+/*%(),=<>]/g;
  let m;
  while ((m = re.exec(s)) !== null) toks.push(m[0]);
  return toks;
}

// Redis 分词（支持引号包裹含空格的参数）
function splitRedisArgs(cmd) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  return out;
}

// 严格整数（用于 Redis 数值参数）
function toInt(s) {
  return /^-?\d+$/.test(s === undefined ? '' : String(s)) ? parseInt(s) : NaN;
}

function globToRe(pat) {
  return new RegExp('^' + String(pat).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
}

function parseSetClause(setPart) {
  return splitTop(setPart).map(s => {
    const eq = s.indexOf('=');
    const col = s.slice(0, eq).trim();
    const valStr = s.slice(eq + 1).trim();
    return { col, ast: parseExpr(valStr) };
  });
}

function dumpCell(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

function fmtCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return String(v);
    return String(Math.round(v * 1e6) / 1e6);
  }
  return String(v);
}
function fmtFloat(n) {
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 1e6) / 1e6);
}

function zsort(z) { z.sort((a, b) => a.score - b.score || String(a.member).localeCompare(String(b.member))); }

function applyLimitArr(rows, lim1, lim2, limOff) {
  if (lim1 === undefined) return rows;
  const a = parseInt(lim1);
  if (lim2 !== undefined) return rows.slice(a, a + parseInt(lim2));
  if (limOff !== undefined) return rows.slice(parseInt(limOff), parseInt(limOff) + a);
  return rows.slice(0, a);
}

function sortCmp(av, bv, desc) {
  const an = parseFloat(av), bn = parseFloat(bv);
  const num = av !== null && bv !== null && av !== undefined && bv !== undefined && !isNaN(an) && !isNaN(bn);
  const c = num ? an - bn : String(fmtCell(av)).localeCompare(String(fmtCell(bv)));
  return desc ? -c : c;
}

function truthy(v) { return v === true || v === 1; }

function rowScope(t, r) {
  const s = { '*': [...r], __refVals: {} };
  t.cols.forEach((c, i) => { s[c] = r[i]; });
  return s;
}

function safeParse(str) { try { return parseExpr(str); } catch (e) { return null; } }

function nodeHasAgg(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'agg') return true;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) { if (v.some(nodeHasAgg)) return true; }
    else if (v && typeof v === 'object' && v.type) { if (nodeHasAgg(v)) return true; }
  }
  return false;
}

function selHeader(expr, raw) {
  if (expr && expr.type === 'agg') return aggHeader(expr);
  return raw;
}
function aggHeader(node) {
  const arg = node.arg.type === 'star' ? '*' : (node.arg.type === 'col' ? node.arg.name : exprText(node.arg));
  const d = node.distinct ? 'distinct ' : '';
  return `${node.fn.toLowerCase()}(${d}${arg})`;
}
function exprText(node) {
  if (!node) return '';
  if (node.type === 'col') return node.name;
  if (node.type === 'lit') return typeof node.value === 'string' ? `'${node.value}'` : String(node.value);
  return node.type || '';
}

/* ---- 表达式解析（递归下降）---- */
function parseExpr(str) {
  const toks = tokenizeSql(str);
  let i = 0;
  const peek = () => toks[i];
  const peekUp = () => (toks[i] || '').toUpperCase();
  const next = () => toks[i++];
  const expect = w => { if ((toks[i] || '').toUpperCase() !== w) throw new Error(`near "${toks[i] === undefined ? 'EOF' : toks[i]}": syntax error`); i++; };

  function parseOr() {
    let left = parseAnd();
    while (peekUp() === 'OR') { next(); left = { type: 'or', left, right: parseAnd() }; }
    return left;
  }
  function parseAnd() {
    let left = parseNot();
    while (peekUp() === 'AND') { next(); left = { type: 'and', left, right: parseNot() }; }
    return left;
  }
  function parseNot() {
    if (peekUp() === 'NOT') { next(); return { type: 'not', arg: parseNot() }; }
    return parseCmp();
  }
  function parseCmp() {
    let left = parseAdd();
    const up = peekUp();
    if (up === 'IS') {
      next();
      let neg = false;
      if (peekUp() === 'NOT') { neg = true; next(); }
      expect('NULL');
      return { type: 'isnull', arg: left, neg };
    }
    if (up === 'NOT') {
      const save = i; next();
      const u2 = peekUp();
      if (u2 === 'IN') return parseIn(left, true);
      if (u2 === 'LIKE') return parseLike(left, true);
      if (u2 === 'BETWEEN') return parseBetween(left, true);
      i = save;
      return left;
    }
    if (up === 'IN') return parseIn(left, false);
    if (up === 'LIKE') return parseLike(left, false);
    if (up === 'BETWEEN') return parseBetween(left, false);
    if (['=', '!=', '<>', '>', '<', '>=', '<='].includes(peek())) {
      const op = next();
      return { type: 'cmp', op, left, right: parseAdd() };
    }
    return left;
  }
  function parseIn(left, neg) {
    next(); expect('(');
    if (peekUp() === 'SELECT') {
      const sub = collectParen();
      return { type: 'inSub', arg: left, sub, neg };
    }
    const list = [];
    if (peek() !== ')') {
      list.push(parseOr());
      while (peek() === ',') { next(); list.push(parseOr()); }
    }
    expect(')');
    return { type: 'in', arg: left, list, neg };
  }
  function parseLike(left, neg) { next(); return { type: 'like', arg: left, pat: parseAdd(), neg }; }
  function parseBetween(left, neg) {
    next();
    const lo = parseAdd();
    expect('AND');
    const hi = parseAdd();
    return { type: 'between', arg: left, lo, hi, neg };
  }
  function collectParen() {
    let depth = 1, s = '';
    while (i < toks.length && depth > 0) {
      if (toks[i] === '(') depth++;
      else if (toks[i] === ')') { depth--; if (depth === 0) { i++; break; } }
      s += (s ? ' ' : '') + toks[i]; i++;
    }
    return s;
  }
  function parseAdd() {
    let left = parseMul();
    while (peek() === '+' || peek() === '-') { const op = next(); left = { type: 'arith', op, left, right: parseMul() }; }
    return left;
  }
  function parseMul() {
    let left = parseUnary();
    while (peek() === '*' || peek() === '/' || peek() === '%') { const op = next(); left = { type: 'arith', op, left, right: parseUnary() }; }
    return left;
  }
  function parseUnary() {
    if (peek() === '-') { next(); return { type: 'neg', arg: parseUnary() }; }
    if (peek() === '+') { next(); return parseUnary(); }
    return parsePrimary();
  }
  function parseArgs() {
    expect('(');
    const args = [];
    if (peek() !== ')') {
      args.push(parseOr());
      while (peek() === ',') { next(); args.push(parseOr()); }
    }
    expect(')');
    return args;
  }
  function parsePrimary() {
    const tk = peek();
    if (tk === undefined) throw new Error('unexpected end of expression');
    if (tk === '(') {
      next();
      if (peekUp() === 'SELECT') { const sub = collectParen(); return { type: 'scalarSub', sub }; }
      const e = parseOr();
      expect(')');
      return e;
    }
    const up = tk.toUpperCase();
    if (up === 'CASE') return parseCase();
    if (up === 'CAST') {
      next(); expect('(');
      const e = parseOr();
      expect('AS');
      const typeName = next();
      expect(')');
      return { type: 'cast', arg: e, to: (typeName || '').toUpperCase() };
    }
    if (up === 'COALESCE') { next(); return { type: 'coalesce', args: parseArgs() }; }
    if (/^(COUNT|SUM|AVG|MIN|MAX)$/.test(up)) {
      next(); expect('(');
      let distinct = false;
      if (peekUp() === 'DISTINCT') { distinct = true; next(); }
      let arg;
      if (peek() === '*') { next(); arg = { type: 'star' }; }
      else arg = parseOr();
      expect(')');
      return { type: 'agg', fn: up, arg, distinct };
    }
    if (/^[A-Za-z_]\w*$/.test(tk) && toks[i + 1] === '(') {
      const name = next();
      const args = parseArgs();
      return { type: 'func', name: name.toUpperCase(), args };
    }
    return parseLiteral();
  }
  function parseCase() {
    next();
    const whens = [];
    let elseExpr = null;
    while (peekUp() === 'WHEN') {
      next();
      const cond = parseOr();
      expect('THEN');
      const res = parseOr();
      whens.push({ cond, res });
    }
    if (peekUp() === 'ELSE') { next(); elseExpr = parseOr(); }
    expect('END');
    return { type: 'case', whens, else: elseExpr };
  }
  function parseLiteral() {
    const tk = next();
    if (/^'.*'$/.test(tk)) return { type: 'lit', value: tk.slice(1, -1).replace(/''/g, "'") };
    if (/^".*"$/.test(tk)) return { type: 'lit', value: tk.slice(1, -1) };
    if (/^-?\d+$/.test(tk)) return { type: 'lit', value: parseInt(tk) };
    if (/^-?\d*\.\d+$/.test(tk)) return { type: 'lit', value: parseFloat(tk) };
    if (tk.toUpperCase() === 'NULL') return { type: 'lit', value: null };
    if (tk.toUpperCase() === 'TRUE') return { type: 'lit', value: 1 };
    if (tk.toUpperCase() === 'FALSE') return { type: 'lit', value: 0 };
    return { type: 'col', name: tk };
  }

  return parseOr();
}

// 在“一组行”上求值（聚合可用）；scope 取组内首行
function computeAggNode(node, rows) {
  const fn = node.fn.toUpperCase();
  if (fn === 'COUNT') {
    if (node.arg && node.arg.type === 'star') return rows.length;
    let vals = rows.map(r => evalExpr(node.arg, r)).filter(v => v !== null && v !== undefined);
    if (node.distinct) vals = [...new Set(vals.map(fmtCell))];
    return vals.length;
  }
  let nums = rows.map(r => parseFloat(evalExpr(node.arg, r))).filter(n => !isNaN(n));
  if (node.distinct) nums = [...new Set(nums)];
  if (fn === 'SUM') return nums.length ? nums.reduce((a, b) => a + b, 0) : 0;
  if (fn === 'AVG') return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  if (fn === 'MAX') return nums.length ? Math.max(...nums) : null;
  if (fn === 'MIN') return nums.length ? Math.min(...nums) : null;
  return null;
}

// 表达式求值：scope = 单行映射；group = 可选的组行数组（聚合时用）
function evalExpr(node, scope, group) {
  if (node === null || node === undefined) return null;
  switch (node.type) {
    case 'lit': return node.value;
    case 'col': return resolveCol(node.name, scope);
    case 'star': return null;
    case 'neg': { const v = evalExpr(node.arg, scope, group); return v === null ? null : -toNum(v); }
    case 'arith': {
      const a = evalExpr(node.left, scope, group), b = evalExpr(node.right, scope, group);
      if (a === null || b === null) return null;
      const x = toNum(a), y = toNum(b);
      switch (node.op) {
        case '+': return x + y;
        case '-': return x - y;
        case '*': return x * y;
        case '/': return y === 0 ? null : x / y;
        case '%': return y === 0 ? null : x % y;
      }
      return null;
    }
    case 'and': return truthy(evalExpr(node.left, scope, group)) && truthy(evalExpr(node.right, scope, group));
    case 'or': return truthy(evalExpr(node.left, scope, group)) || truthy(evalExpr(node.right, scope, group));
    case 'not': { const a = evalExpr(node.arg, scope, group); return a === null ? null : !truthy(a); }
    case 'cmp': {
      const a = evalExpr(node.left, scope, group), b = evalExpr(node.right, scope, group);
      if (a === null || b === null) return null;
      return cmpValues(a, node.op, b);
    }
    case 'isnull': { const v = evalExpr(node.arg, scope, group); const is = (v === null || v === undefined); return node.neg ? !is : is; }
    case 'in': {
      const v = evalExpr(node.arg, scope, group);
      if (v === null) return null;
      const hit = node.list.some(e => valEq(v, evalExpr(e, scope, group)));
      return node.neg ? !hit : hit;
    }
    case 'inSub': {
      const v = evalExpr(node.arg, scope, group);
      if (v === null) return null;
      const hit = execSubqueryValues(node.sub).some(x => valEq(v, x));
      return node.neg ? !hit : hit;
    }
    case 'scalarSub': {
      const vals = execSubqueryValues(node.sub);
      return vals.length ? vals[0] : null;
    }
    case 'between': {
      const v = evalExpr(node.arg, scope, group), lo = evalExpr(node.lo, scope, group), hi = evalExpr(node.hi, scope, group);
      if (v === null || lo === null || hi === null) return null;
      const r = cmpValues(v, '>=', lo) && cmpValues(v, '<=', hi);
      return node.neg ? !r : r;
    }
    case 'like': {
      const v = evalExpr(node.arg, scope, group), p = evalExpr(node.pat, scope, group);
      if (v === null || p === null) return null;
      const re = new RegExp('^' + String(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
      const r = re.test(String(v));
      return node.neg ? !r : r;
    }
    case 'case': {
      for (const w of node.whens) if (truthy(evalExpr(w.cond, scope, group))) return evalExpr(w.res, scope, group);
      return node.else ? evalExpr(node.else, scope, group) : null;
    }
    case 'cast': {
      const v = evalExpr(node.arg, scope, group);
      if (v === null) return null;
      if (/^INT/.test(node.to)) return parseInt(toNum(v));
      if (/^(REAL|FLOAT|DOUBLE|NUMERIC|DECIMAL)/.test(node.to)) return toNum(v);
      return String(v);
    }
    case 'coalesce': {
      for (const a of node.args) { const v = evalExpr(a, scope, group); if (v !== null && v !== undefined) return v; }
      return null;
    }
    case 'func': return evalFunc(node.name, node.args.map(a => evalExpr(a, scope, group)));
    case 'agg': return group ? computeAggNode(node, group) : null;
    default: return null;
  }
}

function resolveCol(name, scope) {
  if (!scope) return null;
  if (name in scope) return scope[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(scope)) {
    if (k === '*' || k === '__refVals') continue;
    const bare = k.includes('.') ? k.slice(k.indexOf('.') + 1) : k;
    if (bare.toLowerCase() === lower) return scope[k];
  }
  return null;
}

function toNum(v) {
  if (typeof v === 'number') return v;
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function valEq(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  const an = parseFloat(a), bn = parseFloat(b);
  if (!isNaN(an) && !isNaN(bn) && String(a).trim() !== '' && String(b).trim() !== '') return an === bn;
  return String(a) === String(b);
}

function cmpValues(rv, op, tv) {
  let lv = rv, rt = tv;
  if (!(typeof rv === 'number' && typeof tv === 'number')) {
    const rn = parseFloat(rv), tn = parseFloat(tv);
    if (!isNaN(rn) && !isNaN(tn) && String(rv).trim() !== '' && String(tv).trim() !== '') { lv = rn; rt = tn; }
  }
  switch (op) {
    case '=': return lv == rt;
    case '!=': case '<>': return lv != rt;
    case '>': return lv > rt;
    case '<': return lv < rt;
    case '>=': return lv >= rt;
    case '<=': return lv <= rt;
  }
  return false;
}

function evalFunc(name, args) {
  switch (name) {
    case 'UPPER': return args[0] === null ? null : String(args[0]).toUpperCase();
    case 'LOWER': return args[0] === null ? null : String(args[0]).toLowerCase();
    case 'LENGTH': return args[0] === null ? null : String(args[0]).length;
    case 'SUBSTR': case 'SUBSTRING': {
      if (args[0] === null) return null;
      const s = String(args[0]);
      let start = toNum(args[1]);
      const len = args[2] !== undefined ? toNum(args[2]) : undefined;
      if (start > 0) start = start - 1;
      else if (start < 0) start = s.length + start;
      else start = 0;
      return len === undefined ? s.slice(start) : s.slice(start, start + len);
    }
    case 'TRIM': return args[0] === null ? null : String(args[0]).trim();
    case 'LTRIM': return args[0] === null ? null : String(args[0]).replace(/^\s+/, '');
    case 'RTRIM': return args[0] === null ? null : String(args[0]).replace(/\s+$/, '');
    case 'REPLACE': return args[0] === null ? null : String(args[0]).split(String(args[1])).join(String(args[2]));
    case 'ROUND': {
      if (args[0] === null) return null;
      const d = args[1] === undefined ? 0 : toNum(args[1]);
      const f = Math.pow(10, d);
      return Math.round(toNum(args[0]) * f) / f;
    }
    case 'ABS': return args[0] === null ? null : Math.abs(toNum(args[0]));
    case 'DATE': return args[0] === 'now' ? new Date().toISOString().slice(0, 10) : (args[0] === null ? null : String(args[0]));
    case 'DATETIME': return args[0] === 'now' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : (args[0] === null ? null : String(args[0]));
    case 'TIME': return args[0] === 'now' ? new Date().toISOString().slice(11, 19) : (args[0] === null ? null : String(args[0]));
    case 'IFNULL': return (args[0] === null || args[0] === undefined) ? args[1] : args[0];
    case 'IIF': return truthy(args[0]) ? args[1] : args[2];
    case 'INSTR': return args[0] === null ? null : String(args[0]).indexOf(String(args[1])) + 1;
    default: throw new Error(`no such function: ${name}`);
  }
}

// 子查询：返回首列值数组
function execSubqueryValues(subSql) {
  if (!_curEngine || !_curDb) return [];
  const r = _curEngine._runSelectSql(_curDb, subSql);
  if (r.err) return [];
  return r.out.slice(1).map(l => coerceOut(l.split('|')[0]));
}
