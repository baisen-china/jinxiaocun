/**
 * 金额取整口径测试 —— 覆盖 lib/num.js 的 r2。
 *
 * 为什么值得单独测：r2 是唯一一处「算错 1 分钱也不会报错」的地方。
 * 所有金额、毛利、分摊、库存货值都经过它，一旦它的半进位方向或浮点纠偏被改动，
 * 系统不会崩，只会在对账时慢慢对不上。这里用穷举样本把口径钉死。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { r2 } = require('../lib/num');

test('半值向远离零方向进位（1.005 的浮点真值是 1.00499…，必须仍进位到 1.01）', () => {
  assert.strictEqual(r2(1.005), 1.01);
  assert.strictEqual(r2(2.675), 2.68);
  assert.strictEqual(r2(8.895), 8.9);
  assert.strictEqual(r2(-1.005), -1.01);   // 负数方向必须对称，Math.round 单独用会得 -1.00
});

test('正负完全对称：r2(-x) === -r2(x)', () => {
  for (let i = 1; i <= 5000; i++) {
    const x = i / 1000;
    if (r2(-x) !== -r2(x)) assert.fail(`x=${x}：r2(-x)=${r2(-x)} 与 -r2(x)=${-r2(x)} 不对称`);
  }
});

test('20 万个三位小数样本与「对称半进位」口径逐一相符', () => {
  // 期望值用整数运算构造，避免期望值本身受浮点影响。
  for (let k = -100000; k <= 100000; k++) {
    const expect = (k >= 0 ? Math.floor((k + 5) / 10) : -Math.floor((-k + 5) / 10)) / 100;
    const got = r2(k / 1000);
    if (got !== expect) assert.fail(`k=${k}（值 ${k / 1000}）期望 ${expect}，实际 ${got}`);
  }
});

test('非有限值原样返回，不静默洗成 0（否则脏数据被抹平就查不出源头）', () => {
  assert.ok(Number.isNaN(r2(NaN)));
  assert.strictEqual(r2(Infinity), Infinity);
  assert.strictEqual(r2(-Infinity), -Infinity);
  assert.ok(Number.isNaN(r2('不是数字')));
  assert.ok(Number.isNaN(r2(undefined)));
});

test('字符串数字与浮点残差', () => {
  assert.strictEqual(r2('1.005'), 1.01);
  assert.strictEqual(r2(0.1 + 0.2), 0.3);
  assert.strictEqual(r2(-0), 0);
  assert.strictEqual(r2(0), 0);
});
