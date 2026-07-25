// DbEngine —— 继承 LinuxEngine，叠加迷你 SQL 引擎（sqlite3）与 Redis 键值存储
// 会话模型：e.sqlSession = 数据库名（sqlite3 交互中）；e.redisSession = true（redis-cli 中）
import { LinuxEngine } from './linux-engine.js';

export class DbEngine extends LinuxEngine {
  reset() {
    super.reset();
    this.databases = {};   // { dbName: { tables: { name: { cols: [], rows: [][] } } } }
    this.redis = { kv: {}, lists: {}, hashes: {} };
    this.sqlSession = null;
    this.redisSession = false;
    this._seedDbFiles();
  }

  _seedDbFiles() {
    this.writeFile('/home/user/schema.sql', 'CREATE TABLE users (id INTEGER, name TEXT, age INTEGER);\n');
  }

  /* ---- 数据库辅助 ---- */
  getDb(name) {
    if (!this.databases[name]) this.databases[name] = { tables: {} };
    return this.databases[name];
  }
  getTable(db, name) { return this.databases[db]?.tables[name]; }

  /* ---- SQL 执行：返回 { out: [行], err } ---- */
  execSql(dbName, sql) {
    sql = sql.trim().replace(/;\s*$/, '');
    if (!sql) return { out: [] };
    const db = this.getDb(dbName);
    let m;

    // .tables / .schema
    if (/^\.tables$/i.test(sql)) return { out: [Object.keys(db.tables).join('  ') || '(空)'] };
    if ((m = sql.match(/^\.schema\s*(\w*)$/i))) {
      const names = m[1] ? [m[1]] : Object.keys(db.tables);
      const out = [];
      for (const n of names) {
        const t = db.tables[n];
        if (t) out.push(`CREATE TABLE ${n} (${t.cols.map(c => c + ' TEXT').join(', ')});`);
      }
      return { out: out.length ? out : [`Error: no such table: ${m[1]}`], err: !out.length };
    }

    // CREATE TABLE
    if ((m = sql.match(/^CREATE TABLE (\w+)\s*\((.*)\)$/is))) {
      const [, name, colDefs] = m;
      if (db.tables[name]) return { out: [`Error: table ${name} already exists`], err: true };
      const cols = colDefs.split(',').map(c => c.trim().split(/\s+/)[0]).filter(Boolean);
      db.tables[name] = { cols, rows: [] };
      return { out: [] };
    }

    // DROP TABLE
    if ((m = sql.match(/^DROP TABLE (\w+)$/i))) {
      if (!db.tables[m[1]]) return { out: [`Error: no such table: ${m[1]}`], err: true };
      delete db.tables[m[1]];
      return { out: [] };
    }

    // INSERT INTO t (cols) VALUES (...)  /  INSERT INTO t VALUES (...)
    if ((m = sql.match(/^INSERT INTO (\w+)\s*(?:\(([^)]*)\))?\s*VALUES\s*\((.*)\)$/is))) {
      const [, name, colList, valStr] = m;
      const t = db.tables[name];
      if (!t) return { out: [`Error: no such table: ${name}`], err: true };
      const vals = parseValues(valStr);
      let cols = t.cols;
      if (colList) {
        cols = colList.split(',').map(c => c.trim());
        const full = new Array(t.cols.length).fill(null);
        cols.forEach((c, i) => { const idx = t.cols.indexOf(c); if (idx >= 0) full[idx] = vals[i]; });
        t.rows.push(full);
      } else {
        t.rows.push(vals);
      }
      return { out: [] };
    }

    // SELECT
    if ((m = sql.match(/^SELECT (.+?) FROM (\w+)(?:\s+WHERE (.+?))?(?:\s+ORDER BY (\w+)( DESC)?)?(?:\s+LIMIT (\d+))?$/is))) {
      const [, selPart, name, where, orderCol, desc, limit] = m;
      const t = db.tables[name];
      if (!t) return { out: [`Error: no such table: ${name}`], err: true };
      let rows = t.rows;
      if (where) rows = rows.filter(r => evalWhere(r, t.cols, where));

      // 聚合
      const agg = selPart.match(/^(COUNT|SUM|AVG|MAX|MIN)\s*\(\s*(\*|\w+)\s*\)$/i);
      if (agg) {
        const [, fn, col] = agg;
        const ci = col === '*' ? -1 : t.cols.indexOf(col);
        let result;
        if (fn.toUpperCase() === 'COUNT') result = rows.length;
        else {
          const nums = rows.map(r => parseFloat(r[ci])).filter(n => !isNaN(n));
          if (fn.toUpperCase() === 'SUM') result = nums.reduce((a, b) => a + b, 0);
          else if (fn.toUpperCase() === 'AVG') result = nums.length ? (nums.reduce((a, b) => a + b, 0) / nums.length) : 0;
          else if (fn.toUpperCase() === 'MAX') result = nums.length ? Math.max(...nums) : null;
          else if (fn.toUpperCase() === 'MIN') result = nums.length ? Math.min(...nums) : null;
        }
        return { out: [`${fn.toLowerCase()}(${col === '*' ? '*' : col})`, String(result)] };
      }

      // 列选择
      let selCols, selIdx;
      if (selPart.trim() === '*') { selCols = t.cols; selIdx = t.cols.map((_, i) => i); }
      else {
        selCols = selPart.split(',').map(c => c.trim());
        selIdx = selCols.map(c => t.cols.indexOf(c));
        if (selIdx.some(i => i < 0)) return { out: [`Error: no such column`], err: true };
      }

      if (orderCol) {
        const oi = t.cols.indexOf(orderCol);
        if (oi >= 0) {
          rows = [...rows].sort((a, b) => {
            const av = a[oi], bv = b[oi];
            const an = parseFloat(av), bn = parseFloat(bv);
            const cmp = (!isNaN(an) && !isNaN(bn)) ? an - bn : String(av).localeCompare(String(bv));
            return desc ? -cmp : cmp;
          });
        }
      }
      if (limit) rows = rows.slice(0, parseInt(limit));

      const out = [selCols.join('|')];
      for (const r of rows) out.push(selIdx.map(i => r[i] ?? '').join('|'));
      return { out };
    }

    // UPDATE t SET col=val [, ...] [WHERE ...]
    if ((m = sql.match(/^UPDATE (\w+) SET (.+?)(?:\s+WHERE (.+))?$/is))) {
      const [, name, setPart, where] = m;
      const t = db.tables[name];
      if (!t) return { out: [`Error: no such table: ${name}`], err: true };
      const sets = setPart.split(',').map(s => {
        const [c, v] = s.split('=').map(x => x.trim());
        return { ci: t.cols.indexOf(c), val: parseValue(v) };
      });
      let n = 0;
      for (const r of t.rows) {
        if (!where || evalWhere(r, t.cols, where)) {
          for (const s of sets) if (s.ci >= 0) r[s.ci] = s.val;
          n++;
        }
      }
      return { out: [`(${n} 行受影响)`] };
    }

    // DELETE FROM t [WHERE ...]
    if ((m = sql.match(/^DELETE FROM (\w+)(?:\s+WHERE (.+))?$/is))) {
      const [, name, where] = m;
      const t = db.tables[name];
      if (!t) return { out: [`Error: no such table: ${name}`], err: true };
      const before = t.rows.length;
      t.rows = where ? t.rows.filter(r => !evalWhere(r, t.cols, where)) : [];
      return { out: [`(${before - t.rows.length} 行受影响)`] };
    }

    return { out: [`Error: 无法解析 SQL: ${sql.slice(0, 40)}...`], err: true };
  }

  /* ---- Redis 命令：返回 { out: [行], err } ---- */
  execRedis(cmd) {
    const t = cmd.trim().split(/\s+/);
    const op = (t[0] || '').toUpperCase();
    const key = t[1];
    const R = this.redis;
    const str = x => x === undefined ? '(nil)' : String(x);

    switch (op) {
      case 'SET': {
        if (!key || t[2] === undefined) return { out: ['(error) wrong number of arguments'], err: true };
        R.kv[key] = { value: t.slice(2).join(' '), type: 'string' };
        return { out: ['OK'] };
      }
      case 'GET': {
        const v = R.kv[key];
        return { out: [v ? `"${v.value}"` : '(nil)'] };
      }
      case 'DEL': {
        let n = 0;
        for (const k of t.slice(1)) {
          if (R.kv[k]) { delete R.kv[k]; n++; }
          if (R.lists[k]) { delete R.lists[k]; n++; }
          if (R.hashes[k]) { delete R.hashes[k]; n++; }
        }
        return { out: [`(integer) ${n}`] };
      }
      case 'KEYS': {
        const pat = (key || '*').replace(/\*/g, '.*').replace(/\?/g, '.');
        const all = [...Object.keys(R.kv), ...Object.keys(R.lists), ...Object.keys(R.hashes)];
        const matched = all.filter(k => new RegExp('^' + pat + '$').test(k));
        return { out: matched.length ? matched.map((k, i) => `${i + 1}) "${k}"`) : ['(empty list)'] };
      }
      case 'EXISTS': {
        const exists = (R.kv[key] || R.lists[key] || R.hashes[key]) ? 1 : 0;
        return { out: [`(integer) ${exists}`] };
      }
      case 'INCR': {
        const v = R.kv[key];
        const cur = v ? parseInt(v.value) : 0;
        if (v && isNaN(cur)) return { out: ['(error) value is not an integer'], err: true };
        R.kv[key] = { value: String(cur + 1), type: 'string' };
        return { out: [`(integer) ${cur + 1}`] };
      }
      case 'TYPE': {
        const type = R.kv[key] ? 'string' : R.lists[key] ? 'list' : R.hashes[key] ? 'hash' : 'none';
        return { out: [type] };
      }
      case 'LPUSH': {
        if (!R.lists[key]) R.lists[key] = [];
        R.lists[key].unshift(...t.slice(2));
        return { out: [`(integer) ${R.lists[key].length}`] };
      }
      case 'RPUSH': {
        if (!R.lists[key]) R.lists[key] = [];
        R.lists[key].push(...t.slice(2));
        return { out: [`(integer) ${R.lists[key].length}`] };
      }
      case 'LRANGE': {
        const list = R.lists[key] || [];
        let start = parseInt(t[2]) || 0, stop = t[3] === undefined ? -1 : parseInt(t[3]);
        if (stop === -1) stop = list.length - 1;
        const slice = list.slice(start, stop + 1);
        return { out: slice.length ? slice.map((v, i) => `${i + 1}) "${v}"`) : ['(empty list)'] };
      }
      case 'LLEN': return { out: [`(integer) ${(R.lists[key] || []).length}`] };
      case 'HSET': {
        if (!R.hashes[key]) R.hashes[key] = {};
        const isNew = !(t[2] in R.hashes[key]);
        R.hashes[key][t[2]] = t.slice(3).join(' ');
        return { out: [`(integer) ${isNew ? 1 : 0}`] };
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
      default:
        return { out: [`(error) unknown command '${t[0]}'`], err: true };
    }
  }
}

/* ============ SQL 辅助 ============ */
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
function parseValue(s) {
  s = (s || '').trim();
  if (/^['"]/.test(s)) return s.replace(/^['"]|['"]$/g, '');
  return coerce(s);
}
function coerce(s) {
  if (s === 'NULL' || s === 'null') return null;
  if (!isNaN(parseFloat(s)) && String(parseFloat(s)) === s) return parseFloat(s);
  return s;
}

// WHERE 求值：支持 = != <> > < >= <= LIKE，以及 AND 连接
function evalWhere(row, cols, where) {
  const conds = where.split(/\s+AND\s+/i);
  return conds.every(cond => {
    const m = cond.trim().match(/^(\w+)\s*(!=|<>|>=|<=|=|>|<|LIKE)\s*(.+)$/i);
    if (!m) return false;
    const ci = cols.indexOf(m[1]);
    if (ci < 0) return false;
    const rv = row[ci];
    let target = m[3].trim().replace(/^['"]|['"]$/g, '');
    const op = m[2].toUpperCase();
    if (op === 'LIKE') {
      const re = new RegExp('^' + target.replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
      return re.test(String(rv));
    }
    const rn = parseFloat(rv), tn = parseFloat(target);
    const num = !isNaN(rn) && !isNaN(tn);
    const lv = num ? rn : String(rv), tv = num ? tn : target;
    switch (op) {
      case '=': return lv == tv;
      case '!=': case '<>': return lv != tv;
      case '>': return lv > tv;
      case '<': return lv < tv;
      case '>=': return lv >= tv;
      case '<=': return lv <= tv;
    }
    return false;
  });
}
