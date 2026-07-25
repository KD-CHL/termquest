// DbEngine —— 继承 LinuxEngine，叠加迷你 SQL 引擎（sqlite3）与 Redis 键值存储
// 会话模型：e.sqlSession = 数据库名（sqlite3 交互中）；e.redisSession = true（redis-cli 中）
import { LinuxEngine } from './linux-engine.js';

export class DbEngine extends LinuxEngine {
  reset() {
    super.reset();
    this.databases = {};   // { dbName: { tables: { name: { cols: [], rows: [][] } } } }
    this.redis = { kv: {}, lists: {}, hashes: {}, expiry: {} }; // expiry: { key: 到期时间戳(ms) }
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

  /* ---- Redis 惰性过期：清理已到期的键 ---- */
  _purgeExpired() {
    const R = this.redis, now = Date.now();
    for (const k of Object.keys(R.expiry)) {
      if (R.expiry[k] <= now) {
        delete R.kv[k]; delete R.lists[k]; delete R.hashes[k]; delete R.expiry[k];
      }
    }
  }

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

    // INSERT INTO t (cols) VALUES (...) [, (...), ...]  —— 支持一次插入多行
    if ((m = sql.match(/^INSERT INTO (\w+)\s*(?:\(([^)]*)\))?\s*VALUES\s*(.+)$/is))) {
      const [, name, colList, valPart] = m;
      const t = db.tables[name];
      if (!t) return { out: [`Error: no such table: ${name}`], err: true };
      const groups = splitValueGroups(valPart);
      if (!groups.length) return { out: [`Error: 无法解析 VALUES: ${valPart.slice(0, 30)}`], err: true };
      for (const g of groups) {
        const vals = parseValues(g);
        let cols = t.cols;
        if (colList) {
          cols = colList.split(',').map(c => c.trim());
          const full = new Array(t.cols.length).fill(null);
          cols.forEach((c, i) => { const idx = t.cols.indexOf(c); if (idx >= 0) full[idx] = vals[i]; });
          t.rows.push(full);
        } else {
          t.rows.push(vals);
        }
      }
      return { out: [] };
    }

    // SELECT [DISTINCT] 列 FROM 表 [WHERE ...] [GROUP BY 列 [HAVING ...]] [ORDER BY 列 [DESC]] [LIMIT n | LIMIT off,cnt | LIMIT n OFFSET m]
    if ((m = sql.match(/^SELECT\s+(DISTINCT\s+)?(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+GROUP\s+BY\s+(\w+))?(?:\s+HAVING\s+(.+?))?(?:\s+ORDER\s+BY\s+(\w+)(\s+DESC)?)?(?:\s+LIMIT\s+(\d+)(?:\s*,\s*(\d+)|\s+OFFSET\s+(\d+))?)?$/is))) {
      const [, distinct, selPart, name, where, groupCol, having, orderCol, desc, lim1, lim2, limOff] = m;
      const t = db.tables[name];
      if (!t) return { out: [`Error: no such table: ${name}`], err: true };
      let rows = t.rows;
      if (where) rows = rows.filter(r => evalWhere(r, t.cols, where));

      // 纯聚合（无 GROUP BY）—— 保持原有输出格式，额外支持 AS 别名
      const aggM = selPart.trim().match(/^(COUNT|SUM|AVG|MAX|MIN)\s*\(\s*(\*|\w+)\s*\)(?:\s+AS\s+(\w+))?$/i);
      if (!groupCol && aggM) {
        const [, fn, col, alias] = aggM;
        const result = computeAgg({ fn, col }, rows, t.cols);
        return { out: [alias || `${fn.toLowerCase()}(${col === '*' ? '*' : col})`, String(result)] };
      }

      // GROUP BY 分组聚合（可带 HAVING 过滤组）
      if (groupCol) {
        const gi = t.cols.indexOf(groupCol);
        if (gi < 0) return { out: [`Error: no such column: ${groupCol}`], err: true };
        const items = splitTop(selPart).map(parseSelItem);
        for (const it of items) if (!it.agg && t.cols.indexOf(it.expr) < 0) return { out: [`Error: no such column`], err: true };
        const groups = new Map();
        for (const r of rows) {
          const k = String(r[gi]);
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(r);
        }
        let grouped = [...groups.values()].map(grows => ({
          grows,
          cells: items.map(it => it.agg ? computeAgg(it.agg, grows, t.cols) : grows[0][t.cols.indexOf(it.expr)]),
        }));
        if (having) {
          const hm = having.trim().match(/^(COUNT|SUM|AVG|MAX|MIN)\s*\(\s*(\*|\w+)\s*\)\s*(!=|<>|>=|<=|=|>|<)\s*(.+)$/i);
          if (!hm) return { out: [`Error: 无法解析 HAVING: ${having.trim()}`], err: true };
          const tv = parseValue(hm[4]);
          grouped = grouped.filter(g => cmpValues(computeAgg({ fn: hm[1], col: hm[2] }, g.grows, t.cols), hm[3], tv));
        }
        if (orderCol) {
          const oi = items.findIndex(it => it.expr.toLowerCase() === orderCol.toLowerCase() || (it.alias || '').toLowerCase() === orderCol.toLowerCase());
          if (oi >= 0) {
            grouped = [...grouped].sort((a, b) => {
              const av = a.cells[oi], bv = b.cells[oi];
              const an = parseFloat(av), bn = parseFloat(bv);
              const c = (!isNaN(an) && !isNaN(bn)) ? an - bn : String(av).localeCompare(String(bv));
              return desc ? -c : c;
            });
          }
        }
        grouped = applyLimit(grouped, lim1, lim2, limOff);
        const header = items.map(it => it.alias || (it.agg ? `${it.agg.fn.toLowerCase()}(${it.agg.col === '*' ? '*' : it.agg.col})` : it.expr)).join('|');
        const out = [header];
        for (const g of grouped) out.push(g.cells.map(c => c ?? '').join('|'));
        return { out };
      }

      // 列选择（支持 col AS alias 别名，影响输出表头）
      let selIdx, headerCols;
      if (selPart.trim() === '*') {
        selIdx = t.cols.map((_, i) => i); headerCols = t.cols;
      } else {
        const items = splitTop(selPart).map(parseSelItem);
        selIdx = items.map(it => t.cols.indexOf(it.expr));
        if (selIdx.some(i => i < 0)) return { out: [`Error: no such column`], err: true };
        headerCols = items.map(it => it.alias || it.expr);
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

      let dataRows = rows.map(r => selIdx.map(i => r[i]));
      if (distinct) {
        const seen = new Set();
        dataRows = dataRows.filter(cells => {
          const k = cells.map(c => c ?? '').join('|');
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }
      dataRows = applyLimit(dataRows, lim1, lim2, limOff);

      const out = [headerCols.join('|')];
      for (const cells of dataRows) out.push(cells.map(c => c ?? '').join('|'));
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
    this._purgeExpired(); // 惰性过期：已到期的键一律视为不存在
    const t = cmd.trim().split(/\s+/);
    const op = (t[0] || '').toUpperCase();
    const key = t[1];
    const R = this.redis;
    const str = x => x === undefined ? '(nil)' : String(x);

    switch (op) {
      case 'SET': {
        if (!key || t[2] === undefined) return { out: ['(error) wrong number of arguments'], err: true };
        R.kv[key] = { value: t.slice(2).join(' '), type: 'string' };
        delete R.expiry[key]; // SET 会清除原有 TTL
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
          delete R.expiry[k];
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
      case 'PING': return { out: [t[1] !== undefined ? `"${t.slice(1).join(' ')}"` : 'PONG'] };
      case 'DBSIZE': {
        const n = Object.keys(R.kv).length + Object.keys(R.lists).length + Object.keys(R.hashes).length;
        return { out: [`(integer) ${n}`] };
      }
      case 'EXPIRE': {
        const secs = toInt(t[2]);
        if (isNaN(secs)) return { out: ['(error) value is not an integer or out of range'], err: true };
        if (!(R.kv[key] || R.lists[key] || R.hashes[key])) return { out: ['(integer) 0'] };
        R.expiry[key] = Date.now() + secs * 1000;
        return { out: ['(integer) 1'] };
      }
      case 'TTL': {
        if (!(R.kv[key] || R.lists[key] || R.hashes[key])) return { out: ['(integer) -2'] };
        if (R.expiry[key] === undefined) return { out: ['(integer) -1'] };
        return { out: [`(integer) ${Math.max(0, Math.ceil((R.expiry[key] - Date.now()) / 1000))}`] };
      }
      case 'PERSIST': {
        if (R.expiry[key] === undefined) return { out: ['(integer) 0'] };
        delete R.expiry[key];
        return { out: ['(integer) 1'] };
      }
      case 'MSET': {
        const args = t.slice(1);
        if (args.length < 2 || args.length % 2) return { out: ['(error) wrong number of arguments'], err: true };
        for (let i = 0; i < args.length; i += 2) {
          R.kv[args[i]] = { value: args[i + 1], type: 'string' };
          delete R.expiry[args[i]];
        }
        return { out: ['OK'] };
      }
      case 'MGET': {
        const keys = t.slice(1);
        if (!keys.length) return { out: ['(error) wrong number of arguments'], err: true };
        return { out: keys.map((k, i) => `${i + 1}) ${R.kv[k] ? `"${R.kv[k].value}"` : '(nil)'}`) };
      }
      case 'APPEND': {
        if (!key || t[2] === undefined) return { out: ['(error) wrong number of arguments'], err: true };
        if (R.lists[key] || R.hashes[key]) return { out: ['(error) WRONGTYPE Operation against a key holding the wrong kind of value'], err: true };
        const cur = R.kv[key] ? R.kv[key].value : '';
        R.kv[key] = { value: cur + t.slice(2).join(' '), type: 'string' };
        return { out: [`(integer) ${R.kv[key].value.length}`] };
      }
      case 'STRLEN': return { out: [`(integer) ${R.kv[key] ? R.kv[key].value.length : 0}`] };
      case 'SETNX': {
        if (!key || t[2] === undefined) return { out: ['(error) wrong number of arguments'], err: true };
        if (R.kv[key] || R.lists[key] || R.hashes[key]) return { out: ['(integer) 0'] };
        R.kv[key] = { value: t.slice(2).join(' '), type: 'string' };
        return { out: ['(integer) 1'] };
      }
      case 'INCRBY': case 'DECRBY': {
        const n = toInt(t[2]);
        if (isNaN(n)) return { out: ['(error) value is not an integer or out of range'], err: true };
        const v = R.kv[key];
        const cur = v ? parseInt(v.value) : 0;
        if (v && isNaN(cur)) return { out: ['(error) value is not an integer'], err: true };
        const next = op === 'INCRBY' ? cur + n : cur - n;
        R.kv[key] = { value: String(next), type: 'string' };
        return { out: [`(integer) ${next}`] };
      }
      case 'DECR': {
        const v = R.kv[key];
        const cur = v ? parseInt(v.value) : 0;
        if (v && isNaN(cur)) return { out: ['(error) value is not an integer'], err: true };
        R.kv[key] = { value: String(cur - 1), type: 'string' };
        return { out: [`(integer) ${cur - 1}`] };
      }
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
      case 'HDEL': {
        const h = R.hashes[key];
        if (!h || !(t[2] in h)) return { out: ['(integer) 0'] };
        delete h[t[2]];
        if (!Object.keys(h).length) { delete R.hashes[key]; delete R.expiry[key]; }
        return { out: ['(integer) 1'] };
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
        if (!key || args.length < 2 || args.length % 2) return { out: ['(error) wrong number of arguments'], err: true };
        if (!R.hashes[key]) R.hashes[key] = {};
        for (let i = 0; i < args.length; i += 2) R.hashes[key][args[i]] = args[i + 1];
        return { out: ['OK'] };
      }
      case 'HMGET': {
        const fs = t.slice(2);
        if (!fs.length) return { out: ['(error) wrong number of arguments'], err: true };
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

// 把 "(...), (...), ..." 拆成各个括号内的值串（引号内的括号/逗号不算）
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

// 按顶层逗号拆分 SELECT 列表（括号/引号内的逗号不算）
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

// 解析选择项："expr [AS alias]"，识别聚合函数 COUNT/SUM/AVG/MAX/MIN(列|*)
function parseSelItem(s) {
  const am = s.match(/^(.+?)\s+AS\s+(\w+)$/is);
  const expr = am ? am[1].trim() : s;
  const alias = am ? am[2] : null;
  const agg = expr.match(/^(COUNT|SUM|AVG|MAX|MIN)\s*\(\s*(\*|\w+)\s*\)$/i);
  return agg ? { expr, alias, agg: { fn: agg[1], col: agg[2] } } : { expr, alias };
}

// 在一组行上计算聚合值
function computeAgg(agg, rows, cols) {
  const fn = agg.fn.toUpperCase();
  if (fn === 'COUNT') return rows.length;
  const ci = cols.indexOf(agg.col);
  const nums = rows.map(r => parseFloat(r[ci])).filter(n => !isNaN(n));
  if (fn === 'SUM') return nums.reduce((a, b) => a + b, 0);
  if (fn === 'AVG') return nums.length ? (nums.reduce((a, b) => a + b, 0) / nums.length) : 0;
  if (fn === 'MAX') return nums.length ? Math.max(...nums) : null;
  if (fn === 'MIN') return nums.length ? Math.min(...nums) : null;
  return null;
}

// 通用比较：数字按数值比，其余按字符串比
function cmpValues(rv, op, tv) {
  const rn = parseFloat(rv), tn = parseFloat(tv);
  const num = !isNaN(rn) && !isNaN(tn);
  const lv = num ? rn : String(rv), rt = num ? tn : String(tv);
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

// LIMIT n | LIMIT offset, count | LIMIT n OFFSET m
function applyLimit(rows, lim1, lim2, limOff) {
  if (lim1 === undefined) return rows;
  const a = parseInt(lim1);
  if (lim2 !== undefined) return rows.slice(a, a + parseInt(lim2));
  if (limOff !== undefined) return rows.slice(parseInt(limOff), parseInt(limOff) + a);
  return rows.slice(0, a);
}

// 严格整数（用于 Redis 数值参数）
function toInt(s) {
  return /^-?\d+$/.test(s === undefined ? '' : String(s)) ? parseInt(s) : NaN;
}

// WHERE 求值：支持 = != <> > < >= <= LIKE、IN (...)、BETWEEN a AND b、IS [NOT] NULL，
// 以及 AND / OR 连接（OR 优先级低于 AND；BETWEEN 里的 AND 不作逻辑分隔）
function evalWhere(row, cols, where) {
  return splitWhere(where).some(andConds =>
    andConds.length > 0 && andConds.every(cond => evalCond(row, cols, cond)));
}

// 把 WHERE 串拆成 OR 项数组，每个 OR 项是 AND 条件数组
function splitWhere(where) {
  const orTerms = [];
  let andConds = [], buf = '', pendingBetween = false;
  const tokRe = /'[^']*'|"[^"]*"|\S+/g;
  let tk;
  while ((tk = tokRe.exec(where)) !== null) {
    const w = tk[0], up = w.toUpperCase();
    if ((up === 'AND' || up === 'OR') && !/^['"]/.test(w)) {
      if (up === 'AND' && pendingBetween) { buf += ' ' + w; pendingBetween = false; continue; }
      if (buf.trim()) andConds.push(buf.trim());
      buf = '';
      if (up === 'OR') { orTerms.push(andConds); andConds = []; }
    } else {
      if (up === 'BETWEEN') pendingBetween = true;
      buf += (buf ? ' ' : '') + w;
    }
  }
  if (buf.trim()) andConds.push(buf.trim());
  orTerms.push(andConds);
  return orTerms;
}

// 单个条件求值
function evalCond(row, cols, cond) {
  let m;
  if ((m = cond.match(/^(\w+)\s+IS\s+NOT\s+NULL$/i))) {
    const ci = cols.indexOf(m[1]);
    return ci >= 0 && row[ci] !== null && row[ci] !== undefined;
  }
  if ((m = cond.match(/^(\w+)\s+IS\s+NULL$/i))) {
    const ci = cols.indexOf(m[1]);
    return ci >= 0 && (row[ci] === null || row[ci] === undefined);
  }
  if ((m = cond.match(/^(\w+)\s+IN\s*\((.*)\)$/is))) {
    const ci = cols.indexOf(m[1]);
    if (ci < 0) return false;
    const rv = row[ci];
    return parseValues(m[2]).some(v => {
      const rn = parseFloat(rv), vn = parseFloat(v);
      return (!isNaN(rn) && !isNaN(vn)) ? rn === vn : String(rv) === String(v);
    });
  }
  if ((m = cond.match(/^(\w+)\s+BETWEEN\s+(\S+)\s+AND\s+(\S+)$/is))) {
    const ci = cols.indexOf(m[1]);
    if (ci < 0) return false;
    const rv = row[ci], lo = parseValue(m[2]), hi = parseValue(m[3]);
    const rn = parseFloat(rv), lon = parseFloat(lo), hin = parseFloat(hi);
    if (!isNaN(rn) && !isNaN(lon) && !isNaN(hin)) return rn >= lon && rn <= hin;
    const s = String(rv);
    return s >= String(lo) && s <= String(hi);
  }
  m = cond.match(/^(\w+)\s*(!=|<>|>=|<=|=|>|<|LIKE)\s*(.+)$/i);
  if (!m) return false;
  const ci = cols.indexOf(m[1]);
  if (ci < 0) return false;
  const rv = row[ci];
  const target = m[3].trim().replace(/^['"]|['"]$/g, '');
  const op = m[2].toUpperCase();
  if (op === 'LIKE') {
    const re = new RegExp('^' + target.replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
    return re.test(String(rv));
  }
  return cmpValues(rv, op, target);
}
