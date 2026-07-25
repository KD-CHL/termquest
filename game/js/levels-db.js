// 数据库模块关卡 —— SQLite（建表/增删改查/聚合）+ Redis（字符串/列表/哈希）
// setup/check 操作 DbEngine（e）：SQL 状态在 e.databases，Redis 状态在 e.redis。
export const DB_LEVELS = [
  /* ============ 01 SQLite 入门 ============ */
  {
    stage: '01 SQLite 入门', id: 'B01', title: '连接与建表', par: 4,
    desc: '用 <code>sqlite3 shop.db</code> 进入 SQL 会话，执行 <code>CREATE TABLE products (id INTEGER, name TEXT, price INTEGER);</code> 建表，<code>.tables</code> 确认，最后 <code>.quit</code> 退出。',
    hints: ['sqlite3 shop.db', 'CREATE TABLE products (id INTEGER, name TEXT, price INTEGER);', '.tables', '.quit'],
    setup(e) { e.reset(); },
    check(e) {
      const t = e.getTable('shop.db', 'products');
      return e.used.has('sqlite3') && !!t && t.cols.includes('name') && t.cols.includes('price') && !e.sqlSession;
    },
    done: 'sqlite3 <库名> 进入会话，CREATE TABLE 建表，.tables 查看，.quit 退出——SQL 世界的第一步。'
  },
  {
    stage: '01 SQLite 入门', id: 'B02', title: '插入第一批数据', par: 5,
    desc: '继续经营 shop.db：进入会话后，用三条 <code>INSERT INTO products VALUES (...)</code> 插入 apple(5)、keyboard(12)、mouse(8)，再 <code>SELECT * FROM products;</code> 查看全部数据。',
    hints: ['sqlite3 shop.db', "INSERT INTO products VALUES (1, 'apple', 5);", "INSERT INTO products VALUES (2, 'keyboard', 12);", "INSERT INTO products VALUES (3, 'mouse', 8);", 'SELECT * FROM products;'],
    setup(e) { e.reset(); e.getDb('shop.db').tables.products = { cols: ['id', 'name', 'price'], rows: [] }; },
    check(e) {
      const t = e.getTable('shop.db', 'products');
      return !!t && t.rows.length === 3 && e.lastOut.includes('keyboard');
    },
    done: 'INSERT INTO 表 VALUES (...) 逐行插入，SELECT * 查看全部——数据入库的标准流程。'
  },

  /* ============ 02 查询进阶 ============ */
  {
    stage: '02 查询进阶', id: 'B03', title: 'WHERE 条件筛选', par: 2,
    desc: '商品表已就绪。用 <code>SELECT name FROM products WHERE price > 10;</code> 找出所有价格超过 10 的商品。',
    hints: ['sqlite3 shop.db', 'SELECT name FROM products WHERE price > 10;'],
    setup(e) {
      e.reset();
      e.getDb('shop.db').tables.products = { cols: ['id', 'name', 'price'], rows: [[1, 'apple', 5], [2, 'keyboard', 12], [3, 'mouse', 8]] };
    },
    check(e) { return e.used.has('sql') && e.lastOut.includes('keyboard') && !e.lastOut.includes('apple'); },
    done: 'WHERE 是 SQL 的过滤器：price > 10 只留下符合条件的行。条件查询是数据分析的起点。'
  },
  {
    stage: '02 查询进阶', id: 'B04', title: '排序与限量', par: 2,
    desc: '找出最贵的两件商品：<code>SELECT * FROM products ORDER BY price DESC LIMIT 2;</code>（DESC 降序，LIMIT 2 只要前两行）。',
    hints: ['sqlite3 shop.db', 'SELECT * FROM products ORDER BY price DESC LIMIT 2;'],
    setup(e) {
      e.reset();
      e.getDb('shop.db').tables.products = { cols: ['id', 'name', 'price'], rows: [[1, 'apple', 5], [2, 'keyboard', 12], [3, 'mouse', 8]] };
    },
    check(e) {
      const lines = e.lastOut.split('\n');
      return e.used.has('sql') && lines.length >= 2 && lines[1].includes('keyboard') && !e.lastOut.includes('apple');
    },
    done: 'ORDER BY 列 DESC 降序排列，LIMIT n 截取前 n 行——"Top N"查询的经典组合。'
  },

  /* ============ 03 数据维护 ============ */
  {
    stage: '03 数据维护', id: 'B05', title: '改价与下架', par: 3,
    desc: 'apple 涨价到 99：<code>UPDATE products SET price = 99 WHERE name = \'apple\';</code>；编号 3 的鼠标下架：<code>DELETE FROM products WHERE id = 3;</code>。',
    hints: ['sqlite3 shop.db', "UPDATE products SET price = 99 WHERE name = 'apple';", 'DELETE FROM products WHERE id = 3;'],
    setup(e) {
      e.reset();
      e.getDb('shop.db').tables.products = { cols: ['id', 'name', 'price'], rows: [[1, 'apple', 5], [2, 'keyboard', 12], [3, 'mouse', 8]] };
    },
    check(e) {
      const t = e.getTable('shop.db', 'products');
      if (!t) return false;
      const apple = t.rows.find(r => r[1] === 'apple');
      return !!apple && apple[2] == 99 && !t.rows.some(r => r[0] == 3);
    },
    done: 'UPDATE ... SET ... WHERE 改数据，DELETE FROM ... WHERE 删数据。警告：漏写 WHERE 会波及全表！'
  },
  {
    stage: '03 数据维护', id: 'B06', title: '聚合统计', par: 3,
    desc: '盘点时间：先 <code>SELECT COUNT(*) FROM products;</code> 数商品种类，再 <code>SELECT AVG(price) FROM products;</code> 算平均价格。',
    hints: ['sqlite3 shop.db', 'SELECT COUNT(*) FROM products;', 'SELECT AVG(price) FROM products;'],
    setup(e) {
      e.reset();
      e.getDb('shop.db').tables.products = { cols: ['id', 'name', 'price'], rows: [[1, 'apple', 5], [2, 'keyboard', 12], [3, 'mouse', 8]] };
    },
    check(e) { return e.used.has('sql') && e.lastOut.includes('avg') && e.lastOut.includes('8.33'); },
    done: 'COUNT/SUM/AVG/MAX/MIN 是 SQL 五大聚合函数——一行代码就能完成统计报表。'
  },

  /* ============ 04 Redis 实战 ============ */
  {
    stage: '04 Redis 实战', id: 'B07', title: '键值缓存', par: 4,
    desc: '用 <code>redis-cli</code> 进入 Redis，<code>SET greeting hello-world</code> 存一个键，<code>GET greeting</code> 读出来，<code>KEYS *</code> 看看库里都有什么，最后 <code>exit</code>。',
    hints: ['redis-cli', 'SET greeting hello-world', 'GET greeting', 'KEYS *', 'exit'],
    setup(e) { e.reset(); },
    check(e) {
      const v = e.redis.kv.greeting;
      return e.used.has('redis-cli') && !!v && v.value === 'hello-world' && !e.redisSession;
    },
    done: 'Redis 是最常用的内存键值库：SET 存、GET 取、KEYS 列——毫秒级响应，缓存/会话/排行榜全靠它。'
  },
  {
    stage: '04 Redis 实战', id: 'B08', title: '队列与计数器', par: 5,
    desc: '用 Redis 列表做消息队列：<code>LPUSH queue first</code>、<code>RPUSH queue last</code>、<code>LRANGE queue 0 -1</code> 查看；再用 <code>INCR pageviews</code> 连点三次，模拟页面计数。',
    hints: ['redis-cli', 'LPUSH queue first', 'RPUSH queue last', 'LRANGE queue 0 -1', 'INCR pageviews', 'INCR pageviews', 'INCR pageviews'],
    setup(e) { e.reset(); },
    check(e) {
      const q = e.redis.lists.queue;
      const pv = e.redis.kv.pageviews;
      return !!q && q.length === 2 && q[0] === 'first' && q[1] === 'last' && !!pv && pv.value === '3';
    },
    done: 'LPUSH/RPUSH 两端入队、LRANGE 读取——Redis 列表天然是队列；INCR 原子自增，是计数器的最佳实现。'
  },
  {
    stage: '04 Redis 实战', id: 'B09', title: '哈希存对象', par: 4,
    desc: '用哈希存一个用户对象：<code>HSET user:1 name Alice</code>、<code>HSET user:1 age 30</code>，然后 <code>HGET user:1 name</code> 取单个字段，<code>HGETALL user:1</code> 看完整对象。',
    hints: ['redis-cli', 'HSET user:1 name Alice', 'HSET user:1 age 30', 'HGET user:1 name', 'HGETALL user:1'],
    setup(e) { e.reset(); },
    check(e) {
      const h = e.redis.hashes['user:1'];
      return !!h && h.name === 'Alice' && h.age === '30';
    },
    done: 'Redis 哈希 = 字段→值的映射，一个 key 存整个对象。HSET/HGET/HGETALL 是缓存用户信息的常用三件套。'
  },

  /* ============ 05 综合实战 ============ */
  {
    stage: '05 综合实战', id: 'B10', title: '一次线上排障', par: 6,
    desc: '综合挑战：① <code>sqlite3 app.db</code> 建表 <code>CREATE TABLE logs (id INTEGER, level TEXT, msg TEXT);</code>；② 插入一条 ERROR 和一条 INFO 日志；③ <code>SELECT * FROM logs WHERE level = \'ERROR\';</code> 定位错误；④ <code>.quit</code> 后 <code>redis-cli</code>，<code>SET deploy_status done</code> 标记部署完成。',
    hints: ['sqlite3 app.db', 'CREATE TABLE logs (id INTEGER, level TEXT, msg TEXT);', "INSERT INTO logs VALUES (1, 'ERROR', 'disk full');", "INSERT INTO logs VALUES (2, 'INFO', 'service started');", "SELECT * FROM logs WHERE level = 'ERROR';", '.quit', 'redis-cli', 'SET deploy_status done'],
    setup(e) { e.reset(); },
    check(e) {
      const t = e.getTable('app.db', 'logs');
      const kv = e.redis.kv.deploy_status;
      return !!t && t.rows.length === 2 && !!kv && kv.value === 'done' &&
        e.used.has('sqlite3') && e.used.has('redis-cli') && !e.sqlSession;
    },
    done: 'SQL 查日志定位问题，Redis 记录状态标记进度——关系型数据库 + 缓存的组合拳，后端工程师的日常。数据库模块通关！🎓'
  },

  /* ============ 06 SQL 进阶 ============ */
  {
    stage: '06 SQL 进阶', id: 'B11', title: 'GROUP BY 分组统计', par: 3,
    desc: 'orders 表记录了每笔订单的分类与金额。先 <code>SELECT category, COUNT(*) FROM orders GROUP BY category;</code> 统计各分类的订单数，再 <code>SELECT category, SUM(amount) FROM orders GROUP BY category HAVING SUM(amount) > 40;</code> 只看销售总额超过 40 的分类。',
    hints: ['sqlite3 shop.db', 'SELECT category, COUNT(*) FROM orders GROUP BY category;', 'SELECT category, SUM(amount) FROM orders GROUP BY category HAVING SUM(amount) > 40;'],
    setup(e) {
      e.reset();
      e.getDb('shop.db').tables.orders = { cols: ['id', 'category', 'amount'], rows: [[1, 'food', 20], [2, 'toys', 30], [3, 'food', 15], [4, 'food', 10], [5, 'toys', 5]] };
    },
    check(e) {
      return e.used.has('sql') && e.lastOut.includes('category|sum(amount)') &&
        e.lastOut.includes('food|45') && !e.lastOut.includes('toys');
    },
    done: 'GROUP BY 按列分组、聚合函数逐组计算，HAVING 再过滤掉不满足条件的组——报表统计的核心套路。'
  },
  {
    stage: '06 SQL 进阶', id: 'B12', title: 'OR / IN / BETWEEN 组合条件', par: 4,
    desc: '商品表扩容了，试试更灵活的 WHERE：① <code>SELECT name FROM products WHERE price < 10 OR price > 40;</code>（OR 取并集）；② <code>SELECT name FROM products WHERE name IN (\'apple\', \'mouse\', \'cable\');</code>（枚举取值）；③ <code>SELECT name FROM products WHERE price BETWEEN 5 AND 12;</code>（圈定区间）。',
    hints: ['sqlite3 shop.db', 'SELECT name FROM products WHERE price < 10 OR price > 40;', "SELECT name FROM products WHERE name IN ('apple', 'mouse', 'cable');", 'SELECT name FROM products WHERE price BETWEEN 5 AND 12;'],
    setup(e) {
      e.reset();
      e.getDb('shop.db').tables.products = { cols: ['id', 'name', 'price'], rows: [[1, 'apple', 5], [2, 'keyboard', 12], [3, 'mouse', 8], [4, 'monitor', 88], [5, 'cable', 3], [6, 'chair', 45]] };
    },
    check(e) {
      return e.used.has('sql') && e.lastOut.includes('apple') && e.lastOut.includes('keyboard') &&
        e.lastOut.includes('mouse') && !e.lastOut.includes('monitor') && !e.lastOut.includes('cable');
    },
    done: 'OR 取并集、IN 枚举取值、BETWEEN 圈定区间——WHERE 的三把瑞士军刀，组合起来过滤更精准。'
  },
  {
    stage: '06 SQL 进阶', id: 'B13', title: '批量插入与去重查询', par: 3,
    desc: '一条语句插入多行：<code>INSERT INTO visits VALUES (1, \'beijing\'), (2, \'shanghai\'), (3, \'beijing\'), (4, \'guangzhou\');</code>，然后 <code>SELECT DISTINCT city FROM visits;</code> 看看共有多少个不重复的城市。',
    hints: ['sqlite3 shop.db', "INSERT INTO visits VALUES (1, 'beijing'), (2, 'shanghai'), (3, 'beijing'), (4, 'guangzhou');", 'SELECT DISTINCT city FROM visits;'],
    setup(e) {
      e.reset();
      e.getDb('shop.db').tables.visits = { cols: ['id', 'city'], rows: [] };
    },
    check(e) {
      const t = e.getTable('shop.db', 'visits');
      const lines = e.lastOut.split('\n');
      return !!t && t.rows.length === 4 && e.used.has('sql') && lines.length === 4 &&
        e.lastOut.includes('beijing') && e.lastOut.includes('shanghai') && e.lastOut.includes('guangzhou');
    },
    done: 'VALUES (...), (...) 一次插入多行，DISTINCT 去除重复行——批量写入与去重统计都很常用。'
  },

  /* ============ 07 Redis 进阶 ============ */
  {
    stage: '07 Redis 进阶', id: 'B14', title: '过期时间与原子计数', par: 6,
    desc: '用 <code>SET session:token abc123</code> 存一个会话令牌，<code>EXPIRE session:token 300</code> 设定 5 分钟后过期，<code>TTL session:token</code> 查看剩余秒数；再用 <code>INCRBY pageviews 5</code> 和 <code>DECRBY pageviews 2</code> 以原子加减维护页面计数。',
    hints: ['redis-cli', 'SET session:token abc123', 'EXPIRE session:token 300', 'TTL session:token', 'INCRBY pageviews 5', 'DECRBY pageviews 2'],
    setup(e) { e.reset(); },
    check(e) {
      const pv = e.redis.kv.pageviews;
      return e.used.has('redis-cli') && e.redis.expiry['session:token'] > Date.now() && !!pv && pv.value === '3';
    },
    done: 'EXPIRE/TTL 让缓存会"自毁"——会话、验证码全靠它；INCRBY/DECRBY 原子加减，计数器信手拈来。'
  },
  {
    stage: '07 Redis 进阶', id: 'B15', title: '哈希进阶操作', par: 7,
    desc: '一条 <code>HMSET user:2 name Bob age 25 city shanghai</code> 批量写入字段，<code>HKEYS user:2</code> 看字段名、<code>HLEN user:2</code> 数字段数，<code>HINCRBY user:2 age 1</code> 给年龄 +1，最后 <code>HDEL user:2 city</code> 删掉字段并用 <code>HEXISTS user:2 city</code> 确认已删除。',
    hints: ['redis-cli', 'HMSET user:2 name Bob age 25 city shanghai', 'HKEYS user:2', 'HLEN user:2', 'HINCRBY user:2 age 1', 'HDEL user:2 city', 'HEXISTS user:2 city'],
    setup(e) { e.reset(); },
    check(e) {
      const h = e.redis.hashes['user:2'];
      return e.used.has('redis-cli') && !!h && h.name === 'Bob' && h.age === '26' &&
        !('city' in h) && e.lastOut.includes('(integer) 0');
    },
    done: 'HMSET 批量写、HKEYS/HLEN 查结构、HINCRBY 字段自增、HDEL + HEXISTS 删除并验证——哈希对象管理一气呵成。'
  },
];
