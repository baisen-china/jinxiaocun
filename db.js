/**
 * 数据库层：使用 better-sqlite3（本地文件数据库，零配置、零外部服务）
 * 表结构覆盖进销存核心：商品 / 供应商 / 客户 / 采购 / 销售 / 库存流水
 */
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.INVENTORY_DB || path.join(DATA_DIR, 'inventory.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// 写锁排队：SQLite 同一时刻只允许一个写事务，后来的写请求会等到前面的提交完。
// better-sqlite3 的默认驱动超时本来就是 5000ms（不是一冲突就抛 SQLITE_BUSY），
// 这里显式写一遍是防止后续有人改 new Database(..., { timeout: 0 }) 时无意取消了保护；
// 同时放宽到 10s —— 启动时的自愈迁移、一次性历史数据回填都是长事务，
// 此刻若有前端请求进来，5s 有可能不够等到腾出手。
// 注意：这只解决「排队等待」，不解决多进程并发。见 README「禁止多进程部署」。
db.pragma('busy_timeout = 10000');

// 金额取整口径：不在这里自己实现，统一用 lib/num.js 的 r2，与服务端、前端完全一致。
// 差别在哪里：见 lib/num.js 顶部说明——1.005 用「截断」口径得 ¥1.00、用 r2 得 ¥1.01，
// 迁移写库与运行时读数若口径不同，会出现小额账目对不上且极难发现。
const { r2 } = require('./lib/num');

// 建表
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  display_name TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT UNIQUE,
  name TEXT NOT NULL,
  category TEXT DEFAULT '',
  unit TEXT DEFAULT '个',
  purchase_price REAL NOT NULL DEFAULT 0,
  sale_price REAL NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  min_stock INTEGER NOT NULL DEFAULT 0,
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  address TEXT DEFAULT '',
  note TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  address TEXT DEFAULT '',
  note TEXT DEFAULT '',
  credit_limit REAL NOT NULL DEFAULT 100000  -- 授信额度（赊货金额上限），默认 100000
);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_no TEXT UNIQUE NOT NULL,
  supplier_id INTEGER,
  total_amount REAL NOT NULL DEFAULT 0,
  deposit REAL NOT NULL DEFAULT 0,
  note TEXT DEFAULT '',
  operator TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
);

CREATE TABLE IF NOT EXISTS purchase_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  price REAL NOT NULL DEFAULT 0,
  subtotal REAL NOT NULL DEFAULT 0,
  FOREIGN KEY (purchase_id) REFERENCES purchases(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

-- 批次（存货计价：FIFO 先进先出）。每笔采购入库行 = 一个批次，记录供应商/批号/单价/数量/剩余量。
-- products.purchase_price 维护为「剩余批次加权平均单价」，使 stock*purchase_price ≡ Σ(批次剩余×批次单价)=FIFO 在库货值，
-- 原报表（stock*purchase_price 类）无需改写即精确。销售出库按 received_at 升序从最老批次实际消耗，成本落库到 sale_items.cost。
CREATE TABLE IF NOT EXISTS inventory_lots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  supplier_id INTEGER,
  purchase_id INTEGER,
  purchase_item_id INTEGER,
  batch_no TEXT DEFAULT '',
  unit_cost REAL NOT NULL DEFAULT 0,
  qty INTEGER NOT NULL DEFAULT 0,
  remaining_qty INTEGER NOT NULL DEFAULT 0,
  source TEXT DEFAULT 'purchase',      -- purchase(采购入库) / sale_return(销售退回) / adjust(盘点增益)
  received_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  note TEXT DEFAULT '',
  FOREIGN KEY (product_id) REFERENCES products(id)
);
CREATE INDEX IF NOT EXISTS idx_lots_product ON inventory_lots(product_id, remaining_qty);
CREATE INDEX IF NOT EXISTS idx_lots_recv ON inventory_lots(received_at, id);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_no TEXT UNIQUE NOT NULL,
  customer_id INTEGER,
  total_amount REAL NOT NULL DEFAULT 0,
  deposit REAL NOT NULL DEFAULT 0,
  total_profit REAL NOT NULL DEFAULT 0,
  note TEXT DEFAULT '',
  operator TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  price REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  subtotal REAL NOT NULL DEFAULT 0,
  profit REAL NOT NULL DEFAULT 0,
  FOREIGN KEY (sale_id) REFERENCES sales(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE IF NOT EXISTS stock_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  change_qty INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL,
  ref_id INTEGER,
  balance INTEGER NOT NULL DEFAULT 0,
  note TEXT DEFAULT '',
  operator TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

-- 收付款：一笔收付款对应一个往来单位（供应商/客户），可分摊到多张单据（一付多票）
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL,        -- 'pay' 付给供应商 | 'receive' 收客户款
  party_type TEXT,                -- 'supplier' | 'customer' | NULL(无往来单位)
  party_id INTEGER,               -- suppliers.id 或 customers.id
  amount REAL NOT NULL DEFAULT 0, -- 本次收付款总金额
  method TEXT DEFAULT 'cash',     -- cash/bank/alipay/wechat/other
  note TEXT DEFAULT '',
  operator TEXT DEFAULT '',
  is_deposit INTEGER NOT NULL DEFAULT 0,  -- 1=订单定金（建单时自动生成）
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  CHECK (direction IN ('pay','receive'))
);

-- 收付款分摊明细：支持一付多票；某笔收付款未分摊部分自动成为该单位的预付款/预收款
CREATE TABLE IF NOT EXISTS payment_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL,
  doc_type TEXT NOT NULL,         -- 'purchase' | 'sale'
  doc_id INTEGER NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  -- 这笔分摊的钱从哪来：cash = 当次收付的现金/转账（含定金），advance = 用既有预付款/预收款抵扣
  source TEXT NOT NULL DEFAULT 'cash',
  FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE CASCADE
);

-- 收付款金额调整申请：普通用户提交 → 管理员审批通过后才真正改金额
CREATE TABLE IF NOT EXISTS payment_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL,
  old_amount REAL NOT NULL DEFAULT 0,
  new_amount REAL NOT NULL DEFAULT 0,
  reason TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',   -- pending(待审) / approved(已通过) / rejected(已驳回)
  requested_by TEXT DEFAULT '',
  requested_at TEXT DEFAULT '',
  approved_by TEXT DEFAULT '',
  approved_at TEXT DEFAULT '',
  reject_reason TEXT DEFAULT '',
  FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE CASCADE
);

-- 改价记录：商品调价（商品管理里改进货价/售价）与单据改价（开单时单价与标准价不一致）
CREATE TABLE IF NOT EXISTS price_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  log_type TEXT NOT NULL DEFAULT 'doc',   -- product(商品调价) / doc(单据改价)
  product_id INTEGER,
  product_name TEXT DEFAULT '',
  doc_type TEXT DEFAULT '',               -- purchase / sale
  doc_id INTEGER,
  bill_no TEXT DEFAULT '',
  price_field TEXT DEFAULT '',            -- purchase_price(进货价) / sale_price(销售价)
  old_price REAL NOT NULL DEFAULT 0,
  new_price REAL NOT NULL DEFAULT 0,
  qty REAL NOT NULL DEFAULT 0,
  diff_amount REAL NOT NULL DEFAULT 0,    -- (新价-旧价) × 数量
  party_name TEXT DEFAULT '',
  operator TEXT DEFAULT '',
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 元信息：记录一次性迁移标记等
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_stock_product ON stock_logs(product_id);
CREATE INDEX IF NOT EXISTS idx_purchase_created ON purchases(created_at);
CREATE INDEX IF NOT EXISTS idx_sale_created ON sales(created_at);
CREATE INDEX IF NOT EXISTS idx_alloc_doc ON payment_allocations(doc_type, doc_id);
CREATE INDEX IF NOT EXISTS idx_alloc_pay ON payment_allocations(payment_id);
CREATE INDEX IF NOT EXISTS idx_padj_payment ON payment_adjustments(payment_id);
CREATE INDEX IF NOT EXISTS idx_padj_status ON payment_adjustments(status);
CREATE INDEX IF NOT EXISTS idx_price_logs_at ON price_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_price_logs_product ON price_logs(product_id);
CREATE INDEX IF NOT EXISTS idx_price_logs_type ON price_logs(log_type);
-- 明细表按所属单据取数（单据详情、财务明细的数量统计）走索引，避免全表扫描
CREATE INDEX IF NOT EXISTS idx_purchase_items_pid ON purchase_items(purchase_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_sid ON sale_items(sale_id);
-- 往来账高频过滤：供应商/客户明细按归属单位+方向聚合
CREATE INDEX IF NOT EXISTS idx_payments_party ON payments(party_type, party_id, direction);
`);

// 判定是否为空库（新装）：在建表之后、seed 之前判定，供时区迁移判断是否需要平移历史数据
const isFreshDb = db.prepare(`
  SELECT ((SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM products) +
          (SELECT COUNT(*) FROM purchases) + (SELECT COUNT(*) FROM sales) +
          (SELECT COUNT(*) FROM stock_logs)) AS c
`).get().c === 0;

// 迁移：收付款模型升级（兼容旧版「一付一票、首付款靠推断」的数据）
function migratePayments() {
  const cols = db.prepare("PRAGMA table_info(payments)").all().map(c => c.name);
  if (cols.includes('doc_type')) {
    // 旧结构：type, doc_type, doc_id, amount, method, note, operator, created_at
    db.exec('ALTER TABLE payments RENAME TO payments_old;');
    db.exec(`
      CREATE TABLE payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        direction TEXT NOT NULL,
        party_type TEXT,
        party_id INTEGER,
        amount REAL NOT NULL DEFAULT 0,
        method TEXT DEFAULT 'cash',
        note TEXT DEFAULT '',
        operator TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
    `);
    const oldRows = db.prepare('SELECT * FROM payments_old ORDER BY id').all();
    const insNew = db.prepare('INSERT INTO payments (direction, party_type, party_id, amount, method, note, operator, created_at) VALUES (?,?,?,?,?,?,?,?)');
    const insAlloc = db.prepare('INSERT INTO payment_allocations (payment_id, doc_type, doc_id, amount) VALUES (?,?,?,?)');
    const getDoc = db.prepare('SELECT * FROM purchases WHERE id = ?');
    const getSale = db.prepare('SELECT * FROM sales WHERE id = ?');
    const tx = db.transaction(() => {
      for (const o of oldRows) {
        let direction, party_type = null, party_id = null;
        if (o.doc_type === 'purchase') {
          direction = 'pay';
          const doc = getDoc.get(o.doc_id);
          if (doc) { party_type = 'supplier'; party_id = doc.supplier_id; }
        } else {
          direction = 'receive';
          const doc = getSale.get(o.doc_id);
          if (doc) { party_type = 'customer'; party_id = doc.customer_id; }
        }
        const info = insNew.run(direction, party_type, party_id, o.amount, o.method || 'cash', o.note || '', o.operator || '', o.created_at);
        if (o.doc_type && o.doc_id) insAlloc.run(info.lastInsertRowid, o.doc_type, o.doc_id, o.amount);
      }
    });
    tx();
    db.exec('DROP TABLE payments_old;');
  }
  // 旧版 purchases/sales 可能无 deposit 字段
  const pCols = db.prepare("PRAGMA table_info(purchases)").all().map(c => c.name);
  if (!pCols.includes('deposit')) db.prepare('ALTER TABLE purchases ADD COLUMN deposit REAL DEFAULT 0').run();
  const sCols = db.prepare("PRAGMA table_info(sales)").all().map(c => c.name);
  if (!sCols.includes('deposit')) db.prepare('ALTER TABLE sales ADD COLUMN deposit REAL DEFAULT 0').run();
}
migratePayments();

// 迁移：为「约定了定金但未生成定金收付款」的历史单据，自动补建定金记录
// 这是一次性历史迁移（meta 打标记）：它补的是「老版本开单时还没有『自动生成定金收付款』这套逻辑」
// 所留下的历史欠账；之后的单据一律由 server.js 在开单时用 createDepositPayment 实时生成。
// 原来没有标记、每次启动都跑：一旦用户删掉了某笔自动生成的定金记录，下次重启就会被当成
// 「历史欠账」再补一笔——钱凭空复活，且删一次补一次，账面上完全看不出来。
function migrateDeposits() {
  // payments 表若缺 is_deposit 列则补上（兼容早期版本）——这一步本身幂等，可以每次执行
  const payCols = db.prepare("PRAGMA table_info(payments)").all().map(c => c.name);
  if (!payCols.includes('is_deposit')) {
    db.prepare('ALTER TABLE payments ADD COLUMN is_deposit INTEGER NOT NULL DEFAULT 0').run();
  }
  const KEY = 'deposit_backfill_v1';
  // 已补过就不再补：新单据一律由开单流程实时生成定金记录，不需要启动时回填
  if (db.prepare('SELECT value FROM meta WHERE key = ?').get(KEY)) return;
  // 只处理「仍在生效」的单据：退单（returned）与退单待审（pending_return）单据的分摊已被释放，
  // 若不加状态过滤，会把「定金还没付」误判出来再补建，导致退单单据上不断累积假付款。
  const hasStatus = db.prepare("PRAGMA table_info(purchases)").all().map(c => c.name).includes('status');
  const alive = hasStatus ? "AND (status IS NULL OR status = 'active')" : '';
  const docs = db.prepare(`
    SELECT 'purchase' AS dt, id, deposit, supplier_id AS party_id FROM purchases WHERE deposit > 0 ${alive}
    UNION ALL
    SELECT 'sale' AS dt, id, deposit, customer_id AS party_id FROM sales WHERE deposit > 0 ${alive}
  `).all();
  const allocSum = db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM payment_allocations WHERE doc_type=? AND doc_id=?');
  const ins = db.transaction(() => {
    for (const d of docs) {
      const allocated = r2(allocSum.get(d.dt, d.id).s);
      // 已付（含历史定金）已达约定定金，则跳过（避免重复）
      if (allocated >= r2(d.deposit) - 0.001) continue;
      const remain = r2(d.deposit - allocated);
      if (remain <= 0.001) continue;
      const direction = d.dt === 'purchase' ? 'pay' : 'receive';
      const partyType = d.dt === 'purchase' ? 'supplier' : 'customer';
      const info = db.prepare('INSERT INTO payments (direction, party_type, party_id, amount, method, note, operator, is_deposit) VALUES (?,?,?,?,?,?,?,1)')
        .run(direction, partyType, d.party_id, remain, 'other', '订单定金（迁移补全）', 'system');
      db.prepare("INSERT INTO payment_allocations (payment_id, doc_type, doc_id, amount, source) VALUES (?,?,?,?,'cash')").run(info.lastInsertRowid, d.dt, d.id, remain);
    }
    // 打标记：整段迁移只跑一次，避免用户删掉某笔定金后又被"补回来"
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(KEY, String(Date.now()));
  });
  ins();
}
migrateDeposits();

// 迁移：为客户表补充「授信额度（赊货金额）」字段（幂等）
function migrateCustomerCredit() {
  const cols = db.prepare("PRAGMA table_info(customers)").all().map(c => c.name);
  if (!cols.includes('credit_limit')) {
    db.prepare('ALTER TABLE customers ADD COLUMN credit_limit REAL NOT NULL DEFAULT 100000').run();
  }
  // 兜底：确保历史数据（若有 NULL）都有授信额度（默认 100000）；保留用户显式设置的 0（表示禁止赊账）
  db.prepare('UPDATE customers SET credit_limit = 100000 WHERE credit_limit IS NULL').run();
}
migrateCustomerCredit();

// 迁移：为采购/销售单补充「退单」相关字段（幂等）
// status: active(正常) / returned(已退单)；另记录退单原因、时间、操作人
function migrateReturnStatus() {
  for (const t of ['purchases', 'sales']) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
    if (!cols.includes('status')) db.prepare(`ALTER TABLE ${t} ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`).run();
    if (!cols.includes('return_reason')) db.prepare(`ALTER TABLE ${t} ADD COLUMN return_reason TEXT DEFAULT ''`).run();
    if (!cols.includes('returned_at')) db.prepare(`ALTER TABLE ${t} ADD COLUMN returned_at TEXT DEFAULT ''`).run();
    if (!cols.includes('returned_by')) db.prepare(`ALTER TABLE ${t} ADD COLUMN returned_by TEXT DEFAULT ''`).run();
  }
}
migrateReturnStatus();

// 依赖 status 列的两个复合索引，必须放在 migrateReturnStatus 之后建：
// 老库靠历史迁移早已补上 status 列，而**全新空库**是在 migrateReturnStatus 里才 ALTER TABLE 加列，
// 若在最初的建表 exec 里就建这两个索引，空库首次启动会因 "no such column: status" 直接崩溃。
db.exec(`
CREATE INDEX IF NOT EXISTS idx_sales_customer_status ON sales(customer_id, status);
CREATE INDEX IF NOT EXISTS idx_purchases_supplier_status ON purchases(supplier_id, status);
`);

// 迁移：为采购/销售单补充「退单审批」相关字段（幂等）
// 退单审批流：active(正常) -> pending_return(普通用户申请退单、已锁定、待管理员审批) -> returned(管理员审批通过、已真正退单)
// 另记录申请人、审批人、驳回人及时间，形成完整审计链
function migrateReturnApproval() {
  for (const t of ['purchases', 'sales']) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
    const add = (name, def) => { if (!cols.includes(name)) db.prepare(`ALTER TABLE ${t} ADD COLUMN ${name} ${def}`).run(); };
    add('return_requested_by', "TEXT DEFAULT ''");
    add('return_requested_at', "TEXT DEFAULT ''");
    add('return_approved_by', "TEXT DEFAULT ''");
    add('return_approved_at', "TEXT DEFAULT ''");
    add('return_rejected_by', "TEXT DEFAULT ''");
    add('return_rejected_at', "TEXT DEFAULT ''");
    add('return_rejected_reason', "TEXT DEFAULT ''");
  }
}
migrateReturnApproval();

// 迁移：为 users 增加「大小写不敏感」密码哈希（幂等）
// password_hash 保持原有精确比对；password_hash_ci 存小写化后的 bcrypt，
// 供「简单模式」做大小写不敏感登录。历史账号首次登录成功时自动回填。
function migrateUserPasswordCi() {
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!cols.includes('password_hash_ci')) db.prepare('ALTER TABLE users ADD COLUMN password_hash_ci TEXT').run();
}
migrateUserPasswordCi();

// 迁移/自愈：把历史上「缺 party_id」的收付款按分摊单据反推归属（幂等）
// 背景：旧版前端在「单据行点付款/收款」时未带 party_id，导致预付款无归属、下次无法自动抵扣。
// 规则：仅当该笔收付款的全部分摊单据都属于同一往来单位时才回填，存在多单位或没有分摊则跳过（避免误判）。
function repairPaymentParties() {
  const orphans = db.prepare('SELECT id FROM payments WHERE party_id IS NULL').all();
  if (!orphans.length) return 0;
  const upd = db.prepare('UPDATE payments SET party_type=?, party_id=? WHERE id=? AND party_id IS NULL');
  let fixed = 0;
  const tx = db.transaction(() => {
    for (const p of orphans) {
      const allocs = db.prepare('SELECT doc_type, doc_id FROM payment_allocations WHERE payment_id=?').all(p.id);
      if (!allocs.length) continue; // 纯预付款且无单据，无从推断
      const owners = new Set();
      for (const a of allocs) {
        const o = a.doc_type === 'purchase'
          ? (db.prepare('SELECT supplier_id AS o FROM purchases WHERE id=?').get(a.doc_id) || {}).o
          : (db.prepare('SELECT customer_id AS o FROM sales WHERE id=?').get(a.doc_id) || {}).o;
        if (o) owners.add((a.doc_type === 'purchase' ? 'supplier' : 'customer') + ':' + o);
      }
      if (owners.size === 1) {
        const pair = [...owners][0].split(':');
        const r = upd.run(pair[0], parseInt(pair[1]), p.id);
        fixed += r.changes;
      }
    }
  });
  tx();
  return fixed;
}
const repairedPayments = repairPaymentParties();
if (repairedPayments > 0) console.log(`[db] 已自动补全 ${repairedPayments} 笔收付款的往来单位归属`);

// 一次性数据修复：单据「已付/已收」不可能超过单据总额（幂等，靠 meta 标记）
// 背景：旧版「用预付款/预收款抵扣」弹窗默认填入全部可用预存、后端又不校验单据未结金额，
//       导致同一单据被抵扣到超过总额（应付/应收变负数）。这里按分摊先后把累计额截断到单据总额，
//       被截掉的金额不会消失——它仍然留在对应收付款上，成为该单位的预付款/预收款余额。
function fixOverAllocated() {
  const flag = db.prepare('SELECT value FROM meta WHERE key=?').get('fix_overalloc_v1');
  if (flag) return null;
  const fixed = [];
  const tx = db.transaction(() => {
    for (const [docType, tbl] of [['purchase', 'purchases'], ['sale', 'sales']]) {
      const docs = db.prepare(`SELECT * FROM (
          SELECT d.id, d.bill_no, d.total_amount,
            COALESCE((SELECT SUM(a.amount) FROM payment_allocations a WHERE a.doc_type=? AND a.doc_id=d.id),0) AS alloc
          FROM ${tbl} d
        ) WHERE alloc > total_amount + 0.001`).all(docType);
      for (const d of docs) {
        // 以下每一步都必须走 r2：这段跑完之后，剩下的金额会由运行时按同一口径读出展示，
        // 若这里用截断式取整写库，账面上就会出现 1 分钱级别的对不上
        const total = r2(d.total_amount);
        const rows = db.prepare('SELECT id, payment_id, amount FROM payment_allocations WHERE doc_type=? AND doc_id=? ORDER BY payment_id ASC, id ASC')
          .all(docType, d.id);
        let cum = 0, freed = 0;
        for (const r of rows) {
          const amt = r2(r.amount);
          const roomLeft = r2(Math.max(0, total - cum));
          if (roomLeft <= 0.001) {
            db.prepare('DELETE FROM payment_allocations WHERE id=?').run(r.id);
            freed = r2(freed + amt);
          } else if (amt > roomLeft + 0.001) {
            db.prepare('UPDATE payment_allocations SET amount=? WHERE id=?').run(roomLeft, r.id);
            freed = r2(freed + (amt - roomLeft));
            cum = r2(cum + roomLeft);
          } else {
            cum = r2(cum + amt);
          }
        }
        fixed.push({ docType, billNo: d.bill_no, total, before: r2(d.alloc), freed });
      }
    }
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)').run('fix_overalloc_v1', String(Date.now()));
  });
  tx();
  return fixed;
}
const overAllocFixed = fixOverAllocated();
if (overAllocFixed && overAllocFixed.length) {
  for (const f of overAllocFixed) {
    console.log(`[db] 修正超额${f.docType === 'purchase' ? '付款' : '收款'}：${f.billNo} 总额 ${f.total}，原记 ${f.before} → 已截断，${f.freed} 转为预存余额`);
  }
}

// 一次性数据修复：清理「挂在已退单单据上的付款分摊」（幂等，靠 meta 标记）
// 背景：旧版「余款自动抵扣」的候选单据查询没有排除退单单据。
//       退单时该单分摊已被清空（未结金额恢复成整单总额），于是下一笔付款的余款又被自动分摊回去，
//       钱被「钉死」在一张已经不存在的应付款上——往来账看不出、报表又扣掉，两边对不上。
// 处理：删掉这些分摊，金额自然退回该笔收付款的未分摊余额，即变为该单位的预付款/预收款（不丢钱）。
//       若该笔收付款本身就是历史迁移补建的定金（note 标记）且已无任何分摊，则连付款记录一并删除，
//       避免凭空多出一笔预付款。
// 注意：只处理 status='returned'。退单待审（pending_return）的单据仍保留分摊，
//       因为一旦审批被驳回，单据要恢复原状、已付金额必须还在。
function fixReturnedAllocations() {
  const flag = db.prepare('SELECT value FROM meta WHERE key=?').get('fix_returned_alloc_v1');
  if (flag) return null;
  const rows = db.prepare(`
    SELECT a.id, a.payment_id, a.doc_type, a.doc_id, a.amount, d.status, d.bill_no
    FROM payment_allocations a
    JOIN (SELECT 'purchase' AS dt, id, status, bill_no FROM purchases
          UNION ALL
          SELECT 'sale' AS dt, id, status, bill_no FROM sales) d
      ON d.dt = a.doc_type AND d.id = a.doc_id
    WHERE d.status = 'returned'
    ORDER BY a.payment_id ASC, a.id ASC`).all();
  if (!rows.length) {
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)').run('fix_returned_alloc_v1', String(Date.now()));
    return [];
  }
  const affected = new Set(rows.map(r => r.payment_id));
  const tx = db.transaction(() => {
    for (const r of rows) db.prepare('DELETE FROM payment_allocations WHERE id=?').run(r.id);
    // 清理迁移补建、且现在已无任何分摊的定金记录（只认带标记的，绝不误删真实收付款）
    for (const pid of affected) {
      const p = db.prepare('SELECT * FROM payments WHERE id=?').get(pid);
      if (!p) continue;
      const left = db.prepare('SELECT COUNT(*) AS c FROM payment_allocations WHERE payment_id=?').get(pid).c;
      if (left === 0 && Number(p.is_deposit) === 1 && String(p.note || '').includes('迁移补全')) {
        db.prepare('DELETE FROM payments WHERE id=?').run(pid);
      }
    }
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)').run('fix_returned_alloc_v1', String(Date.now()));
  });
  tx();
  return rows.map(r => ({ ...r, amount: r2(r.amount) }));
}
const returnedAllocFixed = fixReturnedAllocations();
if (returnedAllocFixed && returnedAllocFixed.length) {
  const total = r2(returnedAllocFixed.reduce((s, r) => s + r.amount, 0));
  const docs = new Set(returnedAllocFixed.map(r => r.bill_no)).size;
  console.log(`[db] 已释放 ${docs} 张退单单据上被误占用的收付款分摊共 ${total} 元，金额已退回对应预付款/预收款余额`);
}

// 迁移：给分摊记录补「资金来源」标记（cash 现金/转账 / advance 预存抵扣），幂等
// 历史数据无从得知当时是收的现款还是动用的预存，按业务常识推断：
// 预存一定是「单据开立之前就已经收到的钱」，所以付款记录时间早于单据创建时间的分摊 = 预存抵扣，其余 = 现金。
function migrateAllocSource() {
  const cols = db.prepare('PRAGMA table_info(payment_allocations)').all().map(c => c.name);
  if (!cols.includes('source')) {
    db.prepare("ALTER TABLE payment_allocations ADD COLUMN source TEXT NOT NULL DEFAULT 'cash'").run();
  }
  const KEY = 'alloc_source_v1';
  if (db.prepare('SELECT value FROM meta WHERE key=?').get(KEY)) return;
  const tx = db.transaction(() => {
    const a = db.prepare(`UPDATE payment_allocations SET source='advance'
      WHERE doc_type='sale' AND EXISTS (
        SELECT 1 FROM payments p JOIN sales s ON s.id = payment_allocations.doc_id
        WHERE p.id = payment_allocations.payment_id AND p.created_at < s.created_at)`).run();
    const b = db.prepare(`UPDATE payment_allocations SET source='advance'
      WHERE doc_type='purchase' AND EXISTS (
        SELECT 1 FROM payments p JOIN purchases b ON b.id = payment_allocations.doc_id
        WHERE p.id = payment_allocations.payment_id AND p.created_at < b.created_at)`).run();
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)').run(KEY, String(Date.now()));
    return (a.changes || 0) + (b.changes || 0);
  });
  const n = tx();
  if (n > 0) console.log(`[db] 分摊来源标记：${n} 笔历史分摊识别为预存抵扣，其余按现金收付`);
}
migrateAllocSource();

function seed() {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?,?,?,?)')
      .run('admin', hash, 'admin', '管理员');

    const insP = db.prepare(
      'INSERT INTO products (sku, name, category, unit, purchase_price, sale_price, stock, min_stock, note) VALUES (?,?,?,?,?,?,?,?,?)'
    );
    const products = [
      ['P001', '矿泉水 550ml', '饮料', '箱', 24.0, 45.0, 120, 30, '整箱进货'],
      ['P002', '方便面 红烧牛肉', '速食', '箱', 36.0, 60.0, 80, 20, ''],
      ['P003', '抽纸 3层', '日用', '提', 12.0, 22.0, 15, 25, '低于下限，演示预警'],
      ['P004', '蓝牙耳机', '数码', '个', 55.0, 99.0, 40, 10, ''],
      ['P005', 'A4 打印纸', '办公', '包', 18.0, 28.0, 60, 15, ''],
    ];
    for (const p of products) insP.run(...p);

    db.prepare('INSERT INTO suppliers (name, contact, phone, address, note) VALUES (?,?,?,?,?)')
      .run('旺达商贸', '王经理', '13800000001', '城东批发市场 12 号', '主要饮料供应商');
    db.prepare('INSERT INTO suppliers (name, contact, phone, address, note) VALUES (?,?,?,?,?)')
      .run('云仓数码', '李主管', '13900000002', '科技园 B 座 3 层', '数码配件');

    db.prepare('INSERT INTO customers (name, contact, phone, address, note) VALUES (?,?,?,?,?)')
      .run('社区便利店', '张老板', '13700000003', '幸福小区门口', '长期客户');
    db.prepare('INSERT INTO customers (name, contact, phone, address, note) VALUES (?,?,?,?,?)')
      .run('星河办公', '陈采购', '13600000004', '星河大厦 18 楼', '');
  }
}

seed();

// ---------- 时区统一：把历史上按 UTC 存储的时间平移为本地时间 ----------
// 早期各业务表的默认值是 datetime('now')（UTC），而收付款表用的是 datetime('now','localtime')。
// 结果：采购/销售/库存流水比电脑时间慢 8 小时，收付款却是对的，看起来"时间不同步"。
// 这里做一次性平移（幂等，靠 meta 标记防重复），之后所有写入都显式使用本地时间。
function fixTimezoneToLocal() {
  const key = 'tz_localtime_v1';
  const done = db.prepare('SELECT value FROM meta WHERE key=?').get(key);
  if (done) return;

  // 全新数据库：表默认值已是本地时间，无需平移，只打标记
  if (isFreshDb) {
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, String(Date.now()));
    return;
  }

  // 这些表的历史数据是 UTC，需要转成本地时间（payments 本来就是本地时间，跳过）
  const tables = ['purchases', 'sales', 'stock_logs', 'products', 'users'];
  const tx = db.transaction(() => {
    for (const t of tables) {
      const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
      if (!cols.includes('created_at')) continue;
      // datetime(x,'localtime') 会把 x 当作 UTC 解释并转为本地时间；无效值保持原样
      db.prepare(`UPDATE ${t}
        SET created_at = COALESCE(datetime(created_at, 'localtime'), created_at)
        WHERE created_at IS NOT NULL AND datetime(created_at, 'localtime') IS NOT NULL`).run();
    }
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, String(Date.now()));
  });
  tx();
}
fixTimezoneToLocal();

// 迁移：历史销售单的「改价」回填（一次性）
// 背景：改价记录表是后加的，历史单据当时没有留痕。
// 规则：用「销售明细单价 ≠ 商品当前标准售价」推断是否改过价，差额按行写入 price_logs（标注为历史推算）。
// 只做一次（meta 打标记）；此后的新单据由 server.js 在开单时实时记录，不会重复。
function backfillPriceLogs() {
  const KEY = 'price_logs_backfill_v1';
  if (db.prepare('SELECT value FROM meta WHERE key = ?').get(KEY)) return 0;
  let rows = [];
  try {
    rows = db.prepare(`SELECT si.sale_id, si.product_id, si.qty, si.price, si.subtotal,
        s.bill_no, s.created_at, s.operator,
        COALESCE(c.name, '散客') AS party, pr.name AS product_name, COALESCE(pr.sale_price, 0) AS sale_price
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      JOIN products pr ON pr.id = si.product_id
      LEFT JOIN customers c ON c.id = s.customer_id`).all();
  } catch (e) {
    rows = [];
  }
  const ins = db.prepare(`INSERT INTO price_logs
    (log_type, product_id, product_name, doc_type, doc_id, bill_no, price_field, old_price, new_price, qty, diff_amount, party_name, operator, note, created_at)
    VALUES ('doc',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let n = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const std = r2(r.sale_price);
      const act = r2(r.price);
      if (Math.abs(std - act) < 0.005) continue;
      ins.run(r.product_id, r.product_name || '', 'sale', r.sale_id, r.bill_no || '', 'sale_price',
        std, act, r.qty || 0, r2((act - std) * (r.qty || 0)), r.party || '', r.operator || '',
        '历史推算（按商品当前标准售价比对）', r.created_at || '');
      n++;
    }
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(KEY, String(n));
  });
  tx();
  return n;
}
backfillPriceLogs();

// ---------- 作废单据的审计留痕 ----------
// 作废会把单据连同明细一起删掉（录错的单据不该一直占据账目），
// 但「谁在什么时候因为什么作废了哪张单」必须留下，否则就变成无据可查的删数据。
db.exec(`
CREATE TABLE IF NOT EXISTS doc_voids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_type TEXT NOT NULL,                 -- purchase / sale
  doc_id INTEGER NOT NULL,
  bill_no TEXT NOT NULL DEFAULT '',
  party_id INTEGER,
  total_amount REAL NOT NULL DEFAULT 0,
  void_reason TEXT DEFAULT '',
  snapshot TEXT DEFAULT '',               -- 作废前的单据头 + 明细 + 分摊快照（JSON）
  operator TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_doc_voids_at ON doc_voids(created_at);
CREATE INDEX IF NOT EXISTS idx_doc_voids_doc ON doc_voids(doc_type, doc_id);
CREATE INDEX IF NOT EXISTS idx_purchases_bill_no ON purchases(bill_no);
CREATE INDEX IF NOT EXISTS idx_sales_bill_no ON sales(bill_no);
`);

// ---------- 删除收付款的审计留痕 ----------
// 删一笔收付款，等于把「已经发生的资金往来」从账上抹掉，而且它不是作废单据那种可逆操作：
// 单据作废至少还有 doc_voids 记着谁删的、删了什么。收付款原本什么都不留。
// 更隐蔽的是 payment_adjustments 的外键是 ON DELETE CASCADE——删一笔钱，
// 会把它历史上所有「申请改金额 → 谁批的 → 改成多少」的审批记录一起删光，事后完全无法追责。
// 所以这里在删除前先把「记录本体 + 分摊去向 + 即将被级联删除的审批历史」整体快照存档。
db.exec(`
CREATE TABLE IF NOT EXISTS payment_deletions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL,
  direction TEXT NOT NULL DEFAULT '',          -- pay / receive
  party_type TEXT,
  party_id INTEGER,
  party_name TEXT DEFAULT '',
  amount REAL NOT NULL DEFAULT 0,
  method TEXT DEFAULT '',
  note TEXT DEFAULT '',
  source_operator TEXT DEFAULT '',             -- 原记录的录入人
  pay_created_at TEXT DEFAULT '',
  delete_reason TEXT DEFAULT '',
  snapshot TEXT DEFAULT '',                    -- JSON：记录本体 + 分摊明细 + 调账审批历史
  deleted_by TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_pay_del_at ON payment_deletions(created_at);
CREATE INDEX IF NOT EXISTS idx_pay_del_pid ON payment_deletions(payment_id);
`);

// 单号唯一索引：从根上防止两张单撞同一个号（老的 COUNT+1 生成方式会撞号）。
// 历史数据若已经有重复单号，这里只告警、不建索引，避免整个服务起不来。
function ensureBillNoUnique() {
  for (const t of ['purchases', 'sales']) {
    try {
      const dup = db.prepare(`SELECT bill_no, COUNT(*) AS c FROM ${t} GROUP BY bill_no HAVING c > 1 LIMIT 5`).all();
      if (dup.length) {
        console.warn(`[db] ${t} 存在重复单号，跳过唯一索引：${dup.map(d => `${d.bill_no}×${d.c}`).join('，')}`);
        continue;
      }
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_${t}_bill_no ON ${t}(bill_no)`);
    } catch (e) {
      console.warn(`[db] 创建 ${t} 单号唯一索引失败：${e.message}`);
    }
  }
}
ensureBillNoUnique();

// ---------- 批次成本模型（FIFO 先进先出）----------
// 设计要点：
//  - 每笔采购入库行 = 一个批次，记 供应商/批号/单价/数量/剩余量。
//  - products.purchase_price 维护成「剩余批次的加权平均单价」：stock*purchase_price 恒等于
//    Σ(批次剩余量×批次单价) = FIFO 在库货值，因此所有 stock*purchase_price 类报表无需改写即精确。
//  - 销售出库成本按 FIFO 从最老批次实际消耗算，落库在 sale_items.cost。
//  - 历史数据由 rebuildLots() 在建表后一次性从 purchase_items 重建（幂等，meta 打标记）。
function createLot(o) {
  const ins = db.prepare(`INSERT INTO inventory_lots
    (product_id, supplier_id, purchase_id, purchase_item_id, batch_no, unit_cost, qty, remaining_qty, source, received_at, note)
    VALUES (?,?,?,?,?,?,?,?,?, COALESCE(?, datetime('now','localtime')), ?)`);
  return ins.run(
    o.product_id, o.supplier_id ?? null, o.purchase_id ?? null, o.purchase_item_id ?? null,
    o.batch_no || '', r2(o.unit_cost || 0), o.qty || 0, o.qty || 0,
    o.source || 'purchase', o.received_at || null, o.note || ''
  ).lastInsertRowid;
}

// FIFO 消耗：从最老批次（received_at, id 升序）扣减 qty，返回本行真实总成本（精确，未取整）。
// 批次可发量不足则抛错（正常不会发生，因为出库前 products.stock 已先行校验）。
function fifoConsume(productId, qty) {
  const lots = db.prepare(`SELECT id, unit_cost, remaining_qty FROM inventory_lots
    WHERE product_id=? AND remaining_qty>0 ORDER BY received_at ASC, id ASC`).all(productId);
  let need = qty, costSum = 0;
  const takeList = [];
  for (const lot of lots) {
    if (need <= 0) break;
    const take = Math.min(lot.remaining_qty, need);
    costSum += take * lot.unit_cost;
    need -= take;
    takeList.push({ id: lot.id, take });
  }
  if (need > 0.0001) {
    const avail = qty - need;
    throw new Error(`商品库存不足（批次可发 ${avail}，需 ${qty}）`);
  }
  const upd = db.prepare('UPDATE inventory_lots SET remaining_qty = remaining_qty - ? WHERE id=?');
  for (const t of takeList) upd.run(t.take, t.id);
  return costSum;
}

// 把 products.purchase_price 重算为剩余批次的加权平均单价（保留两位）。
// 无批次时不覆盖（保留手工设置的进价，避免空库存商品进价被清零）。
function recomputeProductCost(productId) {
  const r = db.prepare(`SELECT COALESCE(SUM(remaining_qty),0) AS q, COALESCE(SUM(remaining_qty*unit_cost),0) AS c
    FROM inventory_lots WHERE product_id=?`).get(productId);
  if (r.q <= 0) return null;
  const avg = r.c / r.q;
  db.prepare('UPDATE products SET purchase_price=? WHERE id=?').run(r2(avg), productId);
  return r2(avg);
}

// 取某商品剩余批次（按 FIFO 顺序），供接口/报表展示。
function getLots(productId) {
  return db.prepare(`SELECT l.*, s.name AS supplier_name FROM inventory_lots l
    LEFT JOIN suppliers s ON s.id = l.supplier_id
    WHERE l.product_id=? AND l.remaining_qty>0 ORDER BY l.received_at ASC, l.id ASC`).all(productId);
}

// 历史迁移：从 purchase_items 重建批次（每个采购明细=一个历史批次），
// 再用 FIFO 把批次总量对齐到当前 stock（多出的部分视为已被历史销售消耗）。
// 幂等：lots 已有数据则跳过；由 meta 标记保证仅跑一次。
function rebuildLots() {
  const flag = db.prepare('SELECT value FROM meta WHERE key=?').get('lots_rebuild_v1');
  if (flag) return;
  const lotsExist = db.prepare('SELECT COUNT(*) AS c FROM inventory_lots').get().c;
  if (lotsExist > 0) {
    db.prepare('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)').run('lots_rebuild_v1', String(Date.now()));
    return;
  }
  const tx = db.transaction(() => {
    const products = db.prepare('SELECT id FROM products').all();
    for (const prod of products) {
      const pid = prod.id;
      const rows = db.prepare(`SELECT pi.id AS pi_id, pi.qty, pi.price, pi.purchase_id,
          p.supplier_id, p.created_at, p.bill_no
        FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id
        WHERE pi.product_id = ? AND (p.status IS NULL OR p.status != 'returned')
        ORDER BY p.created_at ASC, p.id ASC, pi.id ASC`).all(pid);
      let total = 0;
      const insLot = db.prepare(`INSERT INTO inventory_lots
        (product_id, supplier_id, purchase_id, purchase_item_id, batch_no, unit_cost, qty, remaining_qty, source, received_at, note)
        VALUES (?,?,?,?,?,?,?,?, 'purchase', ?, ?)`);
      for (const r of rows) {
        const q = Math.max(0, parseInt(r.qty) || 0);
        if (q <= 0) continue;
        const cost = r2(r.price || 0);
        insLot.run(pid, r.supplier_id ?? null, r.purchase_id, r.pi_id,
          r.bill_no || ('P' + r.purchase_id), cost, q, q, r.created_at, '历史批次重建');
        total += q;
      }
      const stock = db.prepare('SELECT stock FROM products WHERE id=?').get(pid).stock;
      let excess = total - stock;
      if (total === 0 && stock > 0) {
        // 有库存但无采购单历史（手工建档/期初导入）：以当前进货价建账，保留原有成本口径，避免 FIFO 出库无批次可扣
        const pp = db.prepare('SELECT purchase_price FROM products WHERE id=?').get(pid).purchase_price || 0;
        db.prepare(`INSERT INTO inventory_lots (product_id, supplier_id, purchase_id, purchase_item_id, batch_no, unit_cost, qty, remaining_qty, source, note)
          VALUES (?,NULL,NULL,NULL,'期初',?,?,?,'adjust','期初库存建账')`).run(pid, r2(pp), stock, stock);
      } else if (excess > 0) {
        // 历史已售：FIFO 扣减最老批次，使 Σ剩余 对齐当前库存
        const lots = db.prepare(`SELECT id, remaining_qty FROM inventory_lots WHERE product_id=? AND remaining_qty>0 ORDER BY received_at ASC, id ASC`).all(pid);
        for (const lot of lots) {
          if (excess <= 0) break;
          const take = Math.min(lot.remaining_qty, excess);
          db.prepare('UPDATE inventory_lots SET remaining_qty = remaining_qty - ? WHERE id=?').run(take, lot.id);
          excess -= take;
        }
      } else if (excess < 0) {
        // 历史盘盈/调整导致 stock 大于批次总量：补一个调整批次填平差额（按现有批次均价）
        const diff = -excess;
        const avg = total > 0
          ? db.prepare('SELECT COALESCE(SUM(remaining_qty*unit_cost),0)/COALESCE(SUM(remaining_qty),1) AS a FROM inventory_lots WHERE product_id=?').get(pid).a
          : 0;
        db.prepare(`INSERT INTO inventory_lots (product_id, supplier_id, purchase_id, purchase_item_id, batch_no, unit_cost, qty, remaining_qty, source, note)
          VALUES (?,NULL,NULL,NULL,'ADJ',?,?,?,'adjust','历史库存差额补足')`).run(pid, r2(avg), diff, diff);
      }
      recomputeProductCost(pid);
    }
  });
  tx();
  db.prepare('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)').run('lots_rebuild_v1', String(Date.now()));
}

rebuildLots();

// 把批次能力挂到 db 对象上（保持 module.exports = db 不变，server.js 沿用 db.prepare）
db.createLot = createLot;
db.fifoConsume = fifoConsume;
db.recomputeProductCost = recomputeProductCost;
db.getLots = getLots;
db.rebuildLots = rebuildLots;

module.exports = db;
