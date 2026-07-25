// 数据库命令集 —— sqlite3（SQL 会话）/ redis-cli（Redis 会话）
// 会话中所有输入当作 SQL / Redis 命令；.quit / exit 退出会话。
import { app } from './state.js';
import { print, printCmd } from './terminal.js';
import { sfx } from './effects.js';
import { tokenize } from './commands.js';
import { linuxExecute } from './linux-commands.js';

function E() { return app.engine; }
function after(mutated) { if (app.afterCommand) app.afterCommand(mutated); }
function track(name) { app.cmdUsage[name] = (app.cmdUsage[name] || 0) + 1; }

export function dbExecute(input) {
  input = input.trim();
  if (!input) return;
  const e = E();

  // ── SQL 会话中 ──
  if (e.sqlSession) {
    printCmd(input);
    if (/^\.quit$/i.test(input) || input === 'exit') {
      print(`已退出 sqlite3（数据库 ${e.sqlSession} 已保存到内存）`, 'info');
      e.sqlSession = null;
      sfx('ui-close'); track('.quit'); e.used.add('sqlite3'); after(true); return;
    }
    app.cmdCount++; if (app.updateCmdCount) app.updateCmdCount();
    track('sql'); e.used.add('sql');
    const res = e.execSql(e.sqlSession, input);
    if (res.out.length) res.out.forEach(l => print(l, res.err ? 'err' : 'out'));
    e.lastOut = res.out.join('\n');
    if (res.err) { sfx('err-syntax'); after(false); } else { sfx('text-grep'); after(true); }
    return;
  }

  // ── Redis 会话中 ──
  if (e.redisSession) {
    printCmd(input);
    if (/^(exit|quit)$/i.test(input)) {
      print('已退出 redis-cli', 'info');
      e.redisSession = false;
      sfx('ui-close'); track('exit'); e.used.add('redis-cli'); after(true); return;
    }
    app.cmdCount++; if (app.updateCmdCount) app.updateCmdCount();
    track('redis'); e.used.add('redis');
    const res = e.execRedis(input);
    res.out.forEach(l => print(l, res.err ? 'err' : 'ok'));
    e.lastOut = res.out.join('\n');
    if (res.err) { sfx('err-syntax'); after(false); } else { sfx('net-connect'); after(true); }
    return;
  }

  // ── 未在会话中 ──
  const base = input.split(/\s/)[0];
  if (base === 'sqlite3') {
    printCmd(input);
    app.cmdCount++; if (app.updateCmdCount) app.updateCmdCount();
    track('sqlite3'); e.used.add('sqlite3');
    const db = tokenize(input)[1] || 'test.db';
    e.sqlSession = db;
    e.getDb(db);
    sfx('ui-open');
    print(`SQLite version 3.42.0 —— 已连接 ${db}`, 'head');
    print('输入 SQL 语句（以 ; 结尾可省略），.tables 查看表，.quit 退出', 'info');
    after(true); return;
  }
  if (base === 'redis-cli') {
    printCmd(input);
    app.cmdCount++; if (app.updateCmdCount) app.updateCmdCount();
    track('redis-cli'); e.used.add('redis-cli');
    e.redisSession = true;
    sfx('ui-open');
    print('已连接 Redis 127.0.0.1:6379', 'head');
    print('试试 SET / GET / LPUSH / HSET ... exit 退出', 'info');
    after(true); return;
  }
  if (base === 'help') { printCmd(input); showDbHelp(); return; }
  linuxExecute(input);
}

function showDbHelp() {
  ['── SQLite ──',
    '  sqlite3 <库名>   进入 SQL 会话',
    '  CREATE TABLE 表 (列 类型, ...) · DROP TABLE 表 · ALTER TABLE 表 ADD COLUMN 列 类型',
    '  CREATE INDEX 名 ON 表(列) · CREATE VIEW 名 AS SELECT ...',
    '  INSERT INTO 表 VALUES (...),(...) · UPDATE 表 SET 列=值 WHERE 条件 · DELETE FROM 表 WHERE 条件',
    '  SELECT 列|* FROM 表 [WHERE 条件] [GROUP BY 列 [HAVING 条件]] [ORDER BY 列 DESC] [LIMIT n]',
    '  WHERE: = != > < LIKE \'%x%\' · IN (...) · IN (SELECT ...) · BETWEEN a AND b · IS [NOT] NULL · NOT · AND/OR',
    '  JOIN: SELECT ... FROM a [INNER|LEFT|RIGHT] JOIN b ON a.x=b.y（支持表别名 a.col）',
    '  聚合/函数: COUNT/SUM/AVG/MIN/MAX · CASE WHEN...THEN...END · COALESCE · CAST',
    '  UPPER/LOWER/LENGTH/SUBSTR/TRIM/REPLACE · ROUND/ABS · date(\'now\') · UNION [ALL]',
    '  事务: BEGIN · COMMIT · ROLLBACK',
    '  .tables · .schema · .databases · .dump · .headers on · .mode column · .quit',
    '── Redis ──',
    '  redis-cli   进入 Redis 会话',
    '  字符串: SET[EX] · GET · GETSET · GETDEL · GETRANGE · SETRANGE · MSET/MGET · APPEND · STRLEN',
    '  计数: INCR · DECR · INCRBY · DECRBY · INCRBYFLOAT',
    '  列表: LPUSH/RPUSH · LRANGE · LLEN · LPOP/RPOP · LINSERT · LSET · LTRIM · LREM · RPOPLPUSH',
    '  哈希: HSET · HGET · HGETALL · HMSET/HMGET · HKEYS/HVALS · HLEN · HDEL · HEXISTS · HINCRBY',
    '  集合: SADD · SREM · SMEMBERS · SISMEMBER · SCARD · SUNION/SINTER/SDIFF · SPOP · SRANDMEMBER',
    '  有序集合: ZADD · ZRANGE · ZREVRANGE · ZRANGEBYSCORE · ZSCORE · ZCARD · ZINCRBY · ZREM · ZRANK',
    '  键: DEL · EXISTS · KEYS * · TYPE · EXPIRE · PEXPIRE · EXPIREAT · TTL · PTTL · PERSIST',
    '       RENAME · RENAMENX · RANDOMKEY · SCAN · COPY · OBJECT',
    '  服务器/事务: PING · DBSIZE · INFO · SELECT n · FLUSHDB · FLUSHALL · MULTI/EXEC/DISCARD · exit',
    '── 其余 ──',
    '  ls · cat · echo ... 照常可用 · clear 清屏',
  ].forEach(l => print(l, 'info'));
}
