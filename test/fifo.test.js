/**
 * 批次 FIFO 成本测试。
 *
 * 这是全系统唯一「会悄悄算错钱」的核心算法：
 * 销售出库成本、毛利、库存货值都从它派生，错了不会抛异常，只会让利润表偏一点。
 *
 * 安全意识：本文件在 require('../db') 之前把 INVENTORY_DB 指向临时目录。
 * db.js 一被加载就会建表并跑启动迁移，若不改路径就会直接动生产库 data/inventory.db。
 * 这行赋值必须保持在 require 之前，不要为了「整理顺序」把它挪下去。
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-fifo-test-'));
process.env.INVENTORY_DB = path.join(tmpDir, 'test.db');

const db = require('../db');
const { r2 } = require('../lib/num');

const mkProduct = (name, stock, price) => db.prepare(
  `INSERT INTO products (name, unit, stock, purchase_price) VALUES (?,?,?,?)`
).run(name, '个', stock, price).lastInsertRowid;

let pid;        // 两批次：100@10、100@12
let pidEdge;    // 用于货值恒等式（会产生除不尽的均价）

before(() => {
  pid = mkProduct('测试商品A', 200, 10);
  db.createLot({ product_id: pid, unit_cost: 10, qty: 100, source: 'purchase' });
  db.createLot({ product_id: pid, unit_cost: 12, qty: 100, source: 'purchase' });

  pidEdge = mkProduct('测试商品B', 100, 1.35);
  db.createLot({ product_id: pidEdge, unit_cost: 1.33, qty: 30, source: 'purchase' });
  db.createLot({ product_id: pidEdge, unit_cost: 1.37, qty: 70, source: 'purchase' });
});

after(() => {
  try { db.close(); } catch (e) { /* 已关闭则忽略 */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* Windows 偶发占用，忽略 */ }
});

test('跨批次扣减按「先进先出」计价，而不是按加权均价', () => {
  const cost = db.fifoConsume(pid, 150);
  // 100×10 + 50×12 = 1600。若误用均价 11 → 1650，差 50 元，且不会报错。
  assert.strictEqual(r2(cost), 1600);

  const lots = db.getLots(pid);
  assert.strictEqual(lots.length, 1, '老批次应被扣完并移出可用列表');
  assert.strictEqual(lots[0].remaining_qty, 50);
  assert.strictEqual(lots[0].unit_cost, 12);
});

test('剩余批次的加权均价回写到 purchase_price', () => {
  assert.strictEqual(db.recomputeProductCost(pid), 12);   // 只剩 50@12
  const p = db.prepare('SELECT purchase_price FROM products WHERE id=?').get(pid);
  assert.strictEqual(p.purchase_price, 12);
});

test('超量扣减必须抛错，且不得改动任何批次的剩余量', () => {
  const beforeQty = db.getLots(pid).map((l) => l.remaining_qty);
  assert.throws(() => db.fifoConsume(pid, 999), /库存不足/);
  const afterQty = db.getLots(pid).map((l) => l.remaining_qty);
  // 实现上先算方案再统一落库，所以失败时是「一点都不动」，不会扣一半留一半。
  assert.deepStrictEqual(afterQty, beforeQty);
});

test('批次全部扣完后 recompute 不覆盖手工进价（空库存商品的进价不能被清零）', () => {
  assert.strictEqual(r2(db.fifoConsume(pid, 50)), 600);
  db.prepare('UPDATE products SET purchase_price=? WHERE id=?').run(9.99, pid);
  assert.strictEqual(db.recomputeProductCost(pid), null);
  assert.strictEqual(
    db.prepare('SELECT purchase_price FROM products WHERE id=?').get(pid).purchase_price,
    9.99,
    '无剩余批次时不得改写 purchase_price'
  );
});

test('报表货值口径：stock × purchase_price 与 Σ(剩余数量×单价) 每件误差不超过半分', () => {
  const agg = db.prepare(
    `SELECT COALESCE(SUM(remaining_qty),0) AS q, COALESCE(SUM(remaining_qty*unit_cost),0) AS c
     FROM inventory_lots WHERE product_id=?`
  ).get(pidEdge);
  const lotValue = agg.c;                       // 30×1.33 + 70×1.37 = 135.8
  const avg = db.recomputeProductCost(pidEdge); // 1.358 → 1.36
  const reportValue = agg.q * avg;

  assert.strictEqual(agg.q, 100);
  assert.strictEqual(avg, 1.36);
  // purchase_price 只存两位小数，货值必然有舍入差；真正的约束是「每件不超过半分」，
  // 也就是合计偏差不超过 0.005×数量，而不是要求绝对相等。
  assert.ok(
    Math.abs(reportValue - lotValue) <= 0.005 * agg.q + 1e-9,
    `货值偏差过大：报表 ${reportValue} vs 批次 ${lotValue}`
  );
});
