/**
 * 天下第一家进销存 · 本地服务
 * 技术栈：Express + better-sqlite3 + express-session
 * 绑定 0.0.0.0，可在局域网及通过穿透工具实现外网访问
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { buildWorkbook } = require('./lib/xlsx');
const { readTable } = require('./lib/xlsx-read');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
// 数据目录跟随数据库文件所在目录（测试/多实例时用 INVENTORY_DB 指定）
const DATA_DIR = process.env.INVENTORY_DB ? path.dirname(process.env.INVENTORY_DB) : path.join(__dirname, 'data');

// 会话密钥：首次启动自动生成 32 字节随机值并落盘
// 原来密钥写死在源码里，任何拿到源码的人都能伪造登录态；改为随机密钥后，重启也不会把已登录用户踢下线
function sessionSecret() {
  const file = path.join(DATA_DIR, '.session_secret');
  try {
    if (fs.existsSync(file)) {
      const v = fs.readFileSync(file, 'utf8').trim();
      if (v.length >= 32) return v;
    }
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const v = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, v, { mode: 0o600 });
    return v;
  } catch (e) {
    console.warn('[session] 密钥文件不可用，退回内存随机密钥（重启后需重新登录）：' + e.message);
    return crypto.randomBytes(32).toString('hex');
  }
}

// 请求体大小上限：原来不设限，几 MB 甚至更大的 JSON 会被完整解析进内存，是纯粹的 DoS 面。
// 业务上最大的请求是带 500 行明细的开单（约几十 KB），1 MB 绰绰有余。
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: sessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

// ---------- 健康检查 ----------
// 供外部监控（Uptime Kuma / 云监控 / 反向代理探活）使用，**不鉴权**。
// 刻意不返回任何业务数据（商品数、单据数、用户名都算敏感），只回答两件事：
//   ① 进程还活着；② 数据库还能读（能读不出来说明文件被锁/被删/磁盘故障）。
// 数据库不可读时返回 503 而不是 200——否则监控看到 200 会以为一切正常，问题被掩盖。
const healthStmt = db.prepare('SELECT 1 AS ok');
app.get('/health', (req, res) => {
  let dbOk = false;
  try { dbOk = healthStmt.get().ok === 1; } catch (e) { dbOk = false; }
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'ok' : 'degraded',
    db: dbOk ? 'ok' : 'error',
    uptime: Math.round(process.uptime()),
    time: new Date().toISOString()
  });
});

// 金额取整口径：与数据库迁移脚本共用同一个实现（lib/num.js），避免启动时迁移写库
// 与运行时读数采用不同舍入方式，导致小额账目对不上。详见 lib/num.js 顶部说明。
const { r2 } = require('./lib/num');

// 金额格式化（用于错误信息展示）
const fmtMoney = (n) => '¥' + Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------- 数值安全校验 ----------
// 为什么要单独一套：JSON.parse 会把 1e999 解析成 Infinity，而 `Infinity > 0` 为真，
// 于是所有写着「金额必须大于 0」的校验都会被它绕过去，一路写进 REAL 列。
// 后果有三：(1) JSON.stringify(Infinity) === null，接口返回给前端显示 ¥0；
//          (2) 这笔 Infinity 预存会把它所在单位的所有单据一次性全部抵完；
//          (3) 导出 Excel 时写入非法数值会损坏工作簿。
// 同理，`Number('abc')` 得到 NaN，NaN 参与任何比较都为 false，也一样能绕过 >0 校验。
const MAX_MONEY = 1e12;   // 单笔金额上限 1 万亿元：远超真实业务，又远离浮点失真区间
const MAX_QTY = 1e9;      // 单一数量上限 10 亿

// 转成「有限的两位小数金额」；非法则返回 null
function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const r = r2(n);
  if (!Number.isFinite(r) || Math.abs(r) > MAX_MONEY) return null;
  return r;
}
// 转成「有限的非负两位小数」（用于单价、定金、额度等不得为负的金额）；非法则返回 null
function moneyNonNeg(v) {
  const m = money(v);
  return (m === null || m < 0) ? null : m;
}
// 转成「有限的正整数数量」（1 ~ MAX_QTY）；非法则返回 null
function intQty(v, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n < 0 || n > (max == null ? MAX_QTY : max)) return null;
  return n;
}
// 校验失败时统一抛出的业务错（供 db.transaction 包裹的开单流程使用）
function bad(msg) { const e = new Error(msg); e.userError = true; return e; }

// 写入改价记录（改价报表数据来源）
// log_type: product=商品管理里调价 / doc=开单时单价与标准价不一致
// 记录失败不阻断业务（改价留痕属于辅助信息）
function logPrice(o) {
  try {
    const oldP = r2(o.old_price || 0), newP = r2(o.new_price || 0), qty = Number(o.qty) || 0;
    db.prepare(`INSERT INTO price_logs
      (log_type, product_id, product_name, doc_type, doc_id, bill_no, price_field, old_price, new_price, qty, diff_amount, party_name, operator, note, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      o.log_type || 'doc', o.product_id || null, o.product_name || '', o.doc_type || '', o.doc_id || null,
      o.bill_no || '', o.price_field || '', oldP, newP, qty, r2((newP - oldP) * qty),
      o.party_name || '', o.operator || '', o.note || '', nowLocal()
    );
  } catch (e) { /* 忽略：留痕失败不影响开单 */ }
}

// 单价是否变化（分位比较）
const priceChanged = (a, b) => Math.abs(r2(a) - r2(b)) > 0.005;

// 统一使用本机本地时间写入（避免 SQLite 的 datetime('now') 默认走 UTC，导致时间比电脑慢 8 小时）
// 输出格式与 SQLite 一致：YYYY-MM-DD HH:MM:SS
function nowLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---------- 鉴权 ----------
// 每次请求都回库确认「这个用户还存在」。
// 原来只判断 session 里有没有 userId：管理员把某个账号删掉之后，该账号已经发出的 cookie
// 依然能正常调用所有接口，直到 session 自然过期（7 天）——等于删号没删干净。
// 这里一旦发现用户已被删除，立刻销毁会话并返回 401，前端会自动退回登录页。
function userAlive(id) {
  try { return !!db.prepare('SELECT id FROM users WHERE id = ?').get(id); }
  catch (e) { return false; }
}
function kickDeadSession(req) {
  try { req.session.destroy(() => {}); } catch (e) { /* 销毁失败也照样拒绝访问 */ }
}
function requireAuth(req, res, next) {
  const uid = req.session && req.session.userId;
  if (!uid) return res.status(401).json({ error: '未登录' });
  if (!userAlive(uid)) {
    kickDeadSession(req);
    return res.status(401).json({ error: '账号已不存在，请重新登录' });
  }
  next();
}

// 仅管理员可访问：从库里实时读取角色，避免旧会话缺 role 字段时误判
function requireAdmin(req, res, next) {
  const uid = req.session && req.session.userId;
  if (!uid) return res.status(401).json({ error: '未登录' });
  const u = db.prepare('SELECT role FROM users WHERE id = ?').get(uid);
  if (!u) {
    kickDeadSession(req);
    return res.status(401).json({ error: '账号已不存在，请重新登录' });
  }
  if (u.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
}

// 取当前会话用户是否为管理员（供业务接口内部判断，如普通用户退单只能锁定）
function isAdminSession(req) {
  const u = db.prepare('SELECT role FROM users WHERE id = ?').get(req.session.userId);
  return !!(u && u.role === 'admin');
}

// ---------- 登录防爆破 ----------
// 原来登录接口没有任何失败限制：脚本可以一秒试上百个密码，而每次失败后端要跑 1~5 次 bcrypt
// （bcrypt 天生慢），既是弱密码被撞开的风险，也是一个 CPU 放大的 DoS 抓手。
// 这里按「IP + 账号」双维度限流：连续失败若干次后锁定一段时间，登录成功立刻清零。
const LOGIN_MAX_FAIL = 5;                     // 连续失败几次开始锁定
const LOGIN_WINDOW_MS = 15 * 60 * 1000;       // 失败计数的统计窗口
const LOGIN_LOCK_MS = 10 * 60 * 1000;         // 锁定时长
const MAX_PWD_LEN = 200;                      // 密码长度上限：超长串会让 bcrypt 白耗 CPU
const LOGIN_SWEEP_MS = 60 * 1000;             // 清理过期条目的最小间隔（攒够一段时间再扫，省 CPU）
const LOGIN_MAX_KEYS = 10000;                 // 这张表的硬性上限，到顶就淘汰最早的
const loginAttempts = new Map();              // key -> { fail, firstAt, lockedUntil }
let lastSweepAt = 0;

// 清理策略原本写的是「超过 5000 条才清一次」，这有个空子：
// 攻击者只要把频率压在这条线以下（比如每秒 3 个随机 IP×随机账号名），
// 清理永远不会触发，Map 会一路涨到撑爆内存。
// 改成按时间节流定期扫：与表的大小无关，只要『窗口外且未锁』就清掉。
function sweepLoginAttempts(now) {
  if (now - lastSweepAt < LOGIN_SWEEP_MS) return;
  lastSweepAt = now;
  // 仍在锁定期内的记录必须保留，否则清空就等于帮攻击者解锁
  for (const [k, v] of loginAttempts) {
    if (v.lockedUntil < now && v.firstAt < now - LOGIN_WINDOW_MS) loginAttempts.delete(k);
  }
  // 兜底：如果扫完还超限，说明有人在短时间内换了上万个账号名硬灌。
  // Map 按插入顺序迭代，淘汰最早的一批即可收口。
  if (loginAttempts.size > LOGIN_MAX_KEYS) {
    let excess = loginAttempts.size - LOGIN_MAX_KEYS;
    for (const k of loginAttempts.keys()) { if (excess-- <= 0) break; loginAttempts.delete(k); }
  }
}
function loginKey(req, username) {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  return `${ip}|${String(username == null ? '' : username).toLowerCase()}`;
}
function loginThrottle(key) {
  const now = Date.now();
  sweepLoginAttempts(now);
  const rec = loginAttempts.get(key);
  if (!rec) return { ok: true };
  if (rec.lockedUntil > now) return { ok: false, retryAfter: Math.ceil((rec.lockedUntil - now) / 1000) };
  if (rec.firstAt < now - LOGIN_WINDOW_MS) { loginAttempts.delete(key); return { ok: true }; }
  return { ok: rec.fail < LOGIN_MAX_FAIL };
}
function loginFail(key) {
  const now = Date.now();
  const rec = loginAttempts.get(key) || { fail: 0, firstAt: now, lockedUntil: 0 };
  if (now - rec.firstAt > LOGIN_WINDOW_MS) { rec.firstAt = now; rec.fail = 0; }
  rec.fail += 1;
  if (rec.fail >= LOGIN_MAX_FAIL) { rec.lockedUntil = now + LOGIN_LOCK_MS; rec.fail = 0; }
  loginAttempts.set(key, rec);
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const key = loginKey(req, username);
  const gate = loginThrottle(key);
  if (!gate.ok) {
    const min = Math.ceil((gate.retryAfter || 0) / 60);
    return res.status(429).json({ error: `连续输错密码多次，账号已被临时锁定，请 ${min} 分钟后重试` });
  }
  if (!username || !password) return res.status(400).json({ error: '请输入账号和密码' });
  // 密码长度上限：bcrypt 只取前 72 字节，更长的串既不会提高强度，又会被反复拿来跑哈希
  if (String(password).length > MAX_PWD_LEN) {
    loginFail(key);
    return res.status(401).json({ error: '账号或密码错误' });
  }
  const user = db.prepare('SELECT * FROM users WHERE lower(username) = lower(?)').get(username);
  const mode = passwordMode();
  const hit = user ? matchPassword(password, user, mode) : { ok: false };
  if (!user || !hit.ok) {
    loginFail(key);
    return res.status(401).json({ error: '账号或密码错误' });
  }
  loginAttempts.delete(key);
  // 简单模式下顺手补齐「小写哈希」：历史账号只需一次，之后即可稳定大小写不敏感登录
  if (hit.ciPlain) {
    try { db.prepare('UPDATE users SET password_hash_ci = ? WHERE id = ?').run(bcrypt.hashSync(hit.ciPlain, 10), user.id); } catch (e) { /* 回填失败不影响登录 */ }
  }
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;
  res.json({ id: user.id, username: user.username, displayName: user.display_name, role: user.role });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, username, display_name, role FROM users WHERE id = ?').get(req.session.userId);
  res.json(user);
});

// 修改密码（可选）
app.post('/api/me/password', requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!matchPassword(oldPassword, user, passwordMode()).ok) return res.status(400).json({ error: '原密码错误' });
  const err = validatePassword(newPassword);
  if (err) return res.status(400).json({ error: err.startsWith('密码至少') ? '新密码至少 6 位' : err });
  const h = hashPasswordPair(newPassword);
  db.prepare('UPDATE users SET password_hash = ?, password_hash_ci = ? WHERE id = ?').run(h.exact, h.ci, user.id);
  res.json({ ok: true });
});

// ---------- 用户管理（仅管理员） ----------
app.get('/api/users', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT id, username, display_name, role, created_at FROM users ORDER BY id').all();
  res.json(rows);
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, display_name, role } = req.body || {};
  if (!username || !/^[A-Za-z0-9_]{2,20}$/.test(username)) return res.status(400).json({ error: '账号为 2-20 位字母、数字或下划线' });
  const pwdErr = validatePassword(password);
  if (pwdErr) return res.status(400).json({ error: pwdErr });
  if (db.prepare('SELECT id FROM users WHERE lower(username) = lower(?)').get(username)) return res.status(400).json({ error: '账号已存在' });
  const r = role === 'admin' ? 'admin' : 'user';
  const h = hashPasswordPair(password);
  const info = db.prepare('INSERT INTO users (username, password_hash, password_hash_ci, role, display_name) VALUES (?,?,?,?,?)')
    .run(username, h.exact, h.ci, r, display_name || username);
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.put('/api/users/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const { display_name, role, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  // 防止把唯一的 admin 降级成普通用户，否则系统将无管理员可用
  if (u.role === 'admin' && role && role !== 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c;
    if (adminCount <= 1) return res.status(400).json({ error: '系统至少需要保留一名管理员' });
  }
  const newRole = role ? (role === 'admin' ? 'admin' : 'user') : u.role;
  let pwdHash = u.password_hash;
  let pwdCi = u.password_hash_ci;
  if (password && String(password).length > 0) {
    const pwdErr = validatePassword(password);
    if (pwdErr) return res.status(400).json({ error: pwdErr });
    const h = hashPasswordPair(password);
    pwdHash = h.exact; pwdCi = h.ci;
  }
  db.prepare('UPDATE users SET display_name = ?, role = ?, password_hash = ?, password_hash_ci = ? WHERE id = ?')
    .run(display_name || u.display_name || u.username, newRole, pwdHash, pwdCi, id);
  res.json({ ok: true });
});

app.post('/api/users/:id/reset-password', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const pwd = (req.body && req.body.password) || '';
  const pwdErr = validatePassword(pwd);
  if (pwdErr) return res.status(400).json({ error: pwdErr.replace(/^密码/, '新密码') });
  const h = hashPasswordPair(pwd);
  db.prepare('UPDATE users SET password_hash = ?, password_hash_ci = ? WHERE id = ?').run(h.exact, h.ci, id);
  res.json({ ok: true });
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.session.userId) return res.status(400).json({ error: '不能删除当前登录账号' });
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (u.role === 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c;
    if (adminCount <= 1) return res.status(400).json({ error: '系统至少需要保留一名管理员，无法删除' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---------- 系统配置（全局，管理员可改；普通用户只读） ----------
// branding    ：商店名称 + 开机欢迎语（登录页也要用，故另有公开接口）
// splash      ：开机动画停留秒数（2-30）+ 空闲自动播放的等待分钟（0-99，0=不播放）
// sidebarSales：侧边栏销售额显示开关，默认全部显示
// permissions ：普通用户操作权限，默认全部允许（关闭后仅管理员可操作）
// password    ：密码策略 simple(大小写不敏感/无复杂度) | medium(大小写敏感/无复杂度) | complex(复杂密码)
const DEFAULT_BRANDING = { shopName: '天下第一家', welcomeText: '欢迎使用天下第一家的进销存系统' };
const DEFAULT_SPLASH = { duration: 6, idleMinutes: 5 };
const DEFAULT_BROADCAST_INTERVAL = 120;   // 插播广播默认间隔（秒）
const PWD_MODES = ['simple', 'medium', 'complex'];
function getSettings() {
  let o = {};
  const row = db.prepare("SELECT value FROM meta WHERE key = 'ui_settings'").get();
  if (row && row.value) { try { o = JSON.parse(row.value) || {}; } catch (e) { o = {}; } }
  const ss = o.sidebarSales || {};
  const pm = o.permissions || {};
  const bd = o.branding || {};
  const sl = o.splash || {};
  const pd = o.password || {};
  const ms = o.music || {};
  const bcd = o.broadcast || {};
  const on = (v) => v !== false;   // 未设置视为开启
  const txt = (v, d, max) => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s ? s.slice(0, max) : d;
  };
  // 数值配置：非法 / 越界一律回落默认值，并夹到合法区间
  const num = (v, min, max, d) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return d;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  return {
    branding: {
      shopName: txt(bd.shopName, DEFAULT_BRANDING.shopName, 20),
      welcomeText: txt(bd.welcomeText, DEFAULT_BRANDING.welcomeText, 60)
    },
    splash: {
      duration: num(sl.duration, 2, 30, DEFAULT_SPLASH.duration),
      idleMinutes: num(sl.idleMinutes, 0, 99, DEFAULT_SPLASH.idleMinutes)
    },
    sidebarSales: { today: on(ss.today), month: on(ss.month), year: on(ss.year) },
    permissions: { userReturn: on(pm.userReturn), userAdjustAmount: on(pm.userAdjustAmount) },
    password: { mode: PWD_MODES.includes(pd.mode) ? pd.mode : 'simple' },
    // 侧栏背景音乐开关：默认关闭（未设置视为关闭，与其它「未设置视为开启」的开关相反）
    music: { enabled: ms.enabled === true },
    // 插播广播：音乐播放过程中每达到 interval 秒就暂停音乐插播一次 Broadcast/guangbo.mp3
    // 开关默认关闭；间隔默认 120 秒，允许 30 ~ 3600 秒
    broadcast: {
      enabled: bcd.enabled === true,
      interval: num(bcd.interval, 30, 3600, DEFAULT_BROADCAST_INTERVAL)
    }
  };
}
function saveSettings(next) {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('ui_settings', JSON.stringify(next));
}

// ---------- 密码策略 ----------
// simple ：登录大小写不敏感，密码无复杂度要求（默认，兼容老账号）
// medium ：登录大小写敏感，密码无复杂度要求
// complex：登录大小写敏感，设置密码时要求「至少 8 位 + 大写/小写/数字/符号中至少 3 类」
function passwordMode() {
  const m = getSettings().password.mode;
  return PWD_MODES.includes(m) ? m : 'simple';
}
// 校验即将设置的密码，返回错误文案；null 表示通过
function validatePassword(pwd) {
  const s = String(pwd == null ? '' : pwd);
  const mode = passwordMode();
  if (mode === 'complex') {
    if (s.length < 8) return '复杂模式要求密码至少 8 位';
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(s)).length;
    if (classes < 3) return '复杂模式要求密码包含大写字母、小写字母、数字、符号中的至少 3 类';
    return null;
  }
  if (s.length < 6) return '密码至少 6 位';
  return null;
}
// 生成双哈希：exact 用于大小写敏感比对，ci 用于大小写不敏感比对
function hashPasswordPair(pwd) {
  return { exact: bcrypt.hashSync(String(pwd), 10), ci: bcrypt.hashSync(String(pwd).toLowerCase(), 10) };
}
// 登录/改密时的密码比对
// 返回 { ok, ciPlain }；ciPlain 为命中的小写密码（用于回填 ci 哈希），无则 undefined
function matchPassword(input, user, mode) {
  const raw = String(input == null ? '' : input);
  try {
    if (bcrypt.compareSync(raw, user.password_hash)) return { ok: true };
  } catch (e) { /* 哈希异常按不匹配处理 */ }
  if (mode !== 'simple') return { ok: false };
  const lower = raw.toLowerCase();
  if (user.password_hash_ci) {
    try { if (bcrypt.compareSync(lower, user.password_hash_ci)) return { ok: true }; } catch (e) { /* 忽略 */ }
  }
  // 历史账号还没有小写哈希：尝试常见大小写变体，命中即认为是同一密码（稍后回填）
  const variants = [lower, raw.toUpperCase(), raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase()];
  for (const v of variants) {
    if (v === raw) continue;
    try { if (bcrypt.compareSync(v, user.password_hash)) return { ok: true, ciPlain: v.toLowerCase() }; } catch (e) { /* 忽略 */ }
  }
  return { ok: false };
}

// 权限判定：管理员始终允许；普通用户取决于系统配置
function canUserReturn(req) { return isAdminSession(req) || getSettings().permissions.userReturn; }
function canUserAdjustAmount(req) { return isAdminSession(req) || getSettings().permissions.userAdjustAmount; }

app.get('/api/settings', requireAuth, (req, res) => res.json(getSettings()));

// 公开：登录页也要显示商店名称、欢迎语与开机动画时长，故不鉴权（只暴露这两组）
app.get('/api/public-settings', (req, res) => {
  const s = getSettings();
  res.json({ branding: s.branding, splash: s.splash });
});

app.put('/api/settings', requireAdmin, (req, res) => {
  const cur = getSettings();
  const body = req.body || {};
  const b = body.sidebarSales || {};
  const pick = (k) => (b[k] === undefined ? cur.sidebarSales[k] : !!b[k]);
  const p = body.permissions || {};
  const pickP = (k) => (p[k] === undefined ? cur.permissions[k] : !!p[k]);
  const bd = body.branding || {};
  const pickB = (k, max) => {
    if (bd[k] === undefined) return cur.branding[k];
    const s = String(bd[k] || '').trim().slice(0, max);
    return s || DEFAULT_BRANDING[k];
  };
  const sl = body.splash || {};
  const pickS = (k, min, max) => {
    if (sl[k] === undefined) return cur.splash[k];
    const n = Number(sl[k]);
    if (!Number.isFinite(n)) return cur.splash[k];
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  const pw = body.password || {};
  const nextMode = PWD_MODES.includes(pw.mode) ? pw.mode : cur.password.mode;
  const ms = body.music || {};
  const pickM = (k) => (ms[k] === undefined ? cur.music[k] : !!ms[k]);
  const bcd = body.broadcast || {};
  const pickBc = (k) => (bcd[k] === undefined ? cur.broadcast[k] : !!bcd[k]);
  // 间隔：非法视为不变，越界夹到合法区间（与 getSettings 保持同一口径）
  const pickBcInterval = () => {
    if (bcd.interval === undefined) return cur.broadcast.interval;
    const n = Number(bcd.interval);
    if (!Number.isFinite(n)) return cur.broadcast.interval;
    return Math.min(3600, Math.max(30, Math.round(n)));
  };
  const next = {
    branding: { shopName: pickB('shopName', 20), welcomeText: pickB('welcomeText', 60) },
    splash: { duration: pickS('duration', 2, 30), idleMinutes: pickS('idleMinutes', 0, 99) },
    sidebarSales: { today: pick('today'), month: pick('month'), year: pick('year') },
    permissions: { userReturn: pickP('userReturn'), userAdjustAmount: pickP('userAdjustAmount') },
    password: { mode: nextMode },
    music: { enabled: pickM('enabled') },
    broadcast: { enabled: pickBc('enabled'), interval: pickBcInterval() }
  };
  saveSettings(next);
  res.json(next);
});

// ---------- 侧栏背景音乐（目录固定为项目根目录下 mp3/） ----------
// 目录不可配置：用户把 .mp3 文件拷进该目录即可播放。启动时自动创建，避免首次使用找不到目录。
const MUSIC_DIR = path.join(__dirname, 'mp3');
try { fs.mkdirSync(MUSIC_DIR, { recursive: true }); } catch (e) { /* 创建失败不阻断启动，前端会提示目录为空 */ }

// 列出 mp3/ 下的音乐（仅 .mp3，按文件名排序）
app.get('/api/music/list', requireAuth, (req, res) => {
  let files = [];
  try {
    files = fs.readdirSync(MUSIC_DIR)
      .filter((f) => /\.mp3$/i.test(f))
      .map((f) => {
        let size = 0;
        try { size = fs.statSync(path.join(MUSIC_DIR, f)).size; } catch (e) { /* 忽略单个文件异常 */ }
        return { name: f, url: '/mp3/' + encodeURIComponent(f), size };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  } catch (e) {
    return res.status(500).json({ error: '读取音乐目录失败：' + e.message });
  }
  res.json({ dir: 'mp3', files });
});

// 播放音频：带 Range 支持（便于拖动进度条）。仅允许 mp3/ 目录下的 .mp3，拒绝路径穿越。
app.get('/mp3/:file', requireAuth, (req, res) => {
  const name = String(req.params.file || '');
  if (!/\.mp3$/i.test(name) || name.includes('/') || name.includes('\\')) return res.status(404).end();
  const full = path.join(MUSIC_DIR, path.basename(name));
  if (!full.startsWith(MUSIC_DIR + path.sep)) return res.status(404).end();
  res.sendFile(full, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// ---------- 插播广播（目录固定为项目根目录下 Broadcast/，文件名固定 guangbo.mp3） ----------
// 与音乐一样不可配置：用户把 guangbo.mp3 拷进该目录即可。文件名写死，接口不接收任何文件名参数，
// 从根上排除路径穿越；文件不存在时前端静默跳过，不打断音乐。
const BROADCAST_DIR = path.join(__dirname, 'Broadcast');
const BROADCAST_FILE = 'guangbo.mp3';
const BROADCAST_PATH = path.join(BROADCAST_DIR, BROADCAST_FILE);
try { fs.mkdirSync(BROADCAST_DIR, { recursive: true }); } catch (e) { /* 创建失败不阻断启动，前端会提示缺少文件 */ }

function broadcastInfo() {
  const s = getSettings().broadcast;
  let size = 0, mtime = 0, exists = false;
  try {
    const st = fs.statSync(BROADCAST_PATH);
    exists = st.isFile();
    size = st.size;
    mtime = Math.floor(st.mtimeMs);
  } catch (e) { exists = false; }
  return {
    enabled: s.enabled,
    interval: s.interval,
    file: BROADCAST_FILE,
    dir: 'Broadcast',
    exists,
    size,
    // 版本号取「大小 + 修改时间」：替换文件后浏览器不会命中旧音频缓存
    url: exists ? `/api/broadcast/audio?v=${size}-${mtime}` : null
  };
}

app.get('/api/broadcast/info', requireAuth, (req, res) => res.json(broadcastInfo()));

// 播放广播音频：路径写死，不接收参数
app.get('/api/broadcast/audio', requireAuth, (req, res) => {
  res.sendFile(BROADCAST_PATH, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// 一键备份：把当前数据库热备份成一个 .db 文件直接下载（WAL 模式下也能保证一致性快照）
// 用法：配置页「数据安全」点「立即备份」；备份文件可原样改名回 data/inventory.db 还原
function stampNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
app.get('/api/backup', requireAdmin, async (req, res) => {
  const tmp = path.join(os.tmpdir(), `inv_backup_${Date.now()}.db`);
  try {
    await db.backup(tmp);
    const shop = String(getSettings().branding.shopName || '进销存').replace(/[\\/:*?"<>|]/g, '');
    const fname = `${shop}_数据备份_${stampNow()}.db`;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="inventory_backup.db"; filename*=UTF-8''${encodeURIComponent(fname)}`);
    const stream = fs.createReadStream(tmp);
    stream.on('close', () => fs.unlink(tmp, () => {}));
    stream.on('error', () => fs.unlink(tmp, () => {}));
    stream.pipe(res);
  } catch (e) {
    fs.unlink(tmp, () => {});
    res.status(500).json({ error: '备份失败：' + e.message });
  }
});

// 侧边栏销售统计：今日 / 本月 / 本年累计（排除已退单）
app.get('/api/sidebar-stats', requireAuth, (req, res) => {
  const row = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN date(created_at) = date('now','localtime') THEN total_amount ELSE 0 END), 0) AS today,
      COALESCE(SUM(CASE WHEN strftime('%Y-%m', created_at) = strftime('%Y-%m','now','localtime') THEN total_amount ELSE 0 END), 0) AS month,
      COALESCE(SUM(CASE WHEN strftime('%Y', created_at) = strftime('%Y','now','localtime') THEN total_amount ELSE 0 END), 0) AS year
    FROM sales WHERE (status IS NULL OR status != 'returned')`).get();
  res.json({
    settings: getSettings(),
    stats: { today: r2(row.today), month: r2(row.month), year: r2(row.year) }
  });
});

// ---------- 通用列表/校验 ----------
// 列表分页：带 ?page= 时返回 {total,page,page_size,has_more,items}，
// 不带时保持原来的「数组 + 上限」返回，老调用不会被打断
function listPaged(baseSql, params, orderSql, req, res, defLimit) {
  const page = parseInt(req.query.page, 10);
  const pageSize = Math.min(1000, Math.max(1, parseInt(req.query.page_size, 10) || 50));
  if (page > 0) {
    const total = db.prepare(`SELECT COUNT(*) AS c FROM (${baseSql})`).get(...params).c;
    const items = db.prepare(`${baseSql} ${orderSql} LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
    return res.json({ total, page, page_size: pageSize, has_more: page * pageSize < total, items });
  }
  const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit, 10) || defLimit || 500));
  res.json(db.prepare(`${baseSql} ${orderSql} LIMIT ?`).all(...params, limit));
}

function paginate(rows, page, pageSize) {
  const total = rows.length;
  const p = Math.max(1, page || 1);
  const ps = Math.max(1, pageSize || 50);
  const start = (p - 1) * ps;
  return { total, page: p, pageSize: ps, items: rows.slice(start, start + ps) };
}

// ---------- 商品 ----------
app.get('/api/products', requireAuth, (req, res) => {
  const { search, category, low } = req.query;
  let sql = 'SELECT * FROM products WHERE 1=1';
  const params = [];
  if (search) { sql += ' AND (name LIKE ? OR sku LIKE ? OR category LIKE ?)'; const s = `%${search}%`; params.push(s, s, s); }
  if (category) { sql += ' AND category = ?'; params.push(category); }
  if (low === '1') { sql += ' AND stock <= min_stock'; }
  sql += ' ORDER BY id DESC';
  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

// 批次明细：某商品当前在库批次（按 FIFO 顺序），用于「同品不同供应商/批次价差」的可视化与追溯
app.get('/api/products/:id/lots', requireAuth, (req, res) => {
  const pid = parseInt(req.params.id);
  const prod = db.prepare('SELECT id, name, sku, stock, purchase_price, unit FROM products WHERE id = ?').get(pid);
  if (!prod) return res.status(404).json({ error: '商品不存在' });
  const lots = db.getLots(pid).map(l => ({
    id: l.id, batch_no: l.batch_no, supplier_name: l.supplier_name || '',
    unit_cost: r2(l.unit_cost), qty: l.qty, remaining_qty: l.remaining_qty,
    source: l.source, received_at: l.received_at, note: l.note || ''
  }));
  const totalQty = lots.reduce((s, l) => s + l.remaining_qty, 0);
  const totalCost = r2(lots.reduce((s, l) => s + l.remaining_qty * l.unit_cost, 0));
  res.json({ product: prod, lots, totalQty, totalCost });
});

app.get('/api/products/categories', requireAuth, (req, res) => {
  const rows = db.prepare("SELECT DISTINCT category FROM products WHERE category <> '' ORDER BY category").all();
  res.json(rows.map(r => r.category));
});

// 商品清单导出：跟随页面搜索 / 仅看预警。
// 前 6 列表头与导入模板同名，方便肉眼对照；但「当前库存」故意不叫「初始库存」——
// 若同名，用户导出后再导入到另一个库时会把库存当成「初始库存」再叠加一次，直接翻倍。
// 导入只认自己那份模板的表头，多出来的列会被忽略，所以这里可以放心加列。
app.get('/api/products/export', requireAuth, (req, res) => {
  const search = String(req.query.search || '').trim();
  const low = req.query.low === '1' || req.query.low === 'true';
  let sql = 'SELECT * FROM products WHERE 1=1';
  const params = [];
  if (search) {
    sql += ' AND (name LIKE ? OR sku LIKE ? OR category LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s);
  }
  if (low) sql += ' AND stock <= min_stock';
  sql += ' ORDER BY category, sku, id';
  const rows = db.prepare(sql).all(...params);
  if (!rows.length) return res.status(400).json({ error: '当前筛选条件下没有商品，无法导出' });

  const head = ['商品编码', '商品名称', '分类', '单位', '进货价', '销售价', '当前库存', '库存预警值', '备注', '状态', '库存成本金额'];
  const body = rows.map(p => {
    const stock = Number(p.stock) || 0;
    const cost = Number(p.purchase_price) || 0;
    return [
      p.sku || '', p.name || '', p.category || '', p.unit || '',
      r2(cost), r2(p.sale_price), stock, Number(p.min_stock) || 0,
      p.note || '',
      stock <= (Number(p.min_stock) || 0) ? '预警' : '正常',
      r2(stock * cost)
    ];
  });
  const sumCost = rows.reduce((s, p) => s + (Number(p.stock) || 0) * (Number(p.purchase_price) || 0), 0);

  const sheets = [{
    name: '商品清单',
    rows: [
      ['商品清单'],
      [`导出时间：${nowLocal()}　｜　共 ${rows.length} 种商品　｜　库存成本合计 ${r2(sumCost)}${search ? `　｜　搜索：${search}` : ''}${low ? '　｜　仅库存预警' : ''}`],
      [],
      head,
      ...body,
      [],
      ['合计', `${rows.length} 种商品`, '', '', '', '', rows.reduce((s, p) => s + (Number(p.stock) || 0), 0), '', '', '', r2(sumCost)]
    ]
  }];

  let buf;
  try { buf = buildWorkbook(sheets); }
  catch (e) { return res.status(500).json({ error: '生成 Excel 失败：' + e.message }); }
  const stamp = db.prepare("SELECT strftime('%Y%m%d','now','localtime') AS d").get().d;
  const fname = `商品清单${low ? '_预警' : ''}_${stamp}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="products_${stamp}.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
});

// 商品库模板导出：数据表只有表头（避免示例行被误导入），说明表写规则与示例。
// 列顺序即导入解析的表头，请勿改动列名。
const PRODUCT_TEMPLATE_HEADERS = ['商品编码', '商品名称', '分类', '单位', '进货价', '销售价', '初始库存', '库存预警值', '备注'];
app.get('/api/products/template', requireAuth, (req, res) => {
  const stamp = nowLocal().slice(0, 10).replace(/-/g, '');
  const dataSheet = [PRODUCT_TEMPLATE_HEADERS];
  const helpSheet = [
    ['商品批量导入 · 填写说明'],
    [''],
    ['1. 本表第一行为表头，请勿修改列名；从第二行开始填写商品数据。'],
    ['2. 商品名称（第二列）为必填，其余可留空。'],
    ['3. 商品编码（第一列）用于去重：库中已存在相同编码的行不会被导入，会进入「未导入表」。'],
    ['4. 若同一文件内出现两个相同编码，先到的导入，后到的进「未导入表」。'],
    ['5. 进货价 / 销售价 / 初始库存 / 库存预警值 必须为不小于 0 的数字，留空视为 0。'],
    ['6. 初始库存 > 0 时，系统自动为该商品建立「期初」批次（用于后续 FIFO 成本核算）。'],
    ['7. 支持 .xlsx 与 .csv 两种格式，文件请使用 UTF-8 编码。'],
    [''],
    ['示例（请勿整行复制到数据表，此处仅为说明格式）：'],
    ['商品编码', '商品名称', '分类', '单位', '进货价', '销售价', '初始库存', '库存预警值', '备注'],
    ['P001', 'A4 纸', '办公', '包', 18, 25, 100, 20, '示例'],
    ['P002', '硒鼓', '办公', '个', 120, 160, 30, 10, '示例']
  ];
  const buf = buildWorkbook([
    { name: '商品导入模板', rows: dataSheet },
    { name: '填写说明', rows: helpSheet }
  ]);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="product_template_${stamp}.xlsx"; filename*=UTF-8''${encodeURIComponent('商品导入模板_' + stamp + '.xlsx')}`);
  res.send(buf);
});

// 商品编码去重用的表头别名（中文表头优先，兼容英文 key），精确匹配单元格文本。
const PRODUCT_HEADER_MAP = {
  sku: ['商品编码', 'sku', '编码', '条码', 'barcode', 'code'],
  name: ['商品名称', '名称', 'name', '品名'],
  category: ['分类', 'category', '类别', '类目'],
  unit: ['单位', 'unit'],
  purchase_price: ['进货价', '采购价', '进价', 'purchase_price', 'cost', '成本价'],
  sale_price: ['销售价', '售价', 'sale_price', 'price'],
  stock: ['初始库存', '库存', 'stock', 'qty', '数量'],
  min_stock: ['库存预警值', '预警值', '下限', 'min_stock', 'min', '预警'],
  note: ['备注', 'note', 'remark', '说明']
};

// 商品库导入：仅导入库中不存在商品编码的行；编码重复（库内已存在 / 本文件内重复）/ 校验不通过的行进「未导入表」。
app.post('/api/products/import', requireAuth, (req, res) => {
  const { file, filename } = req.body || {};
  if (!file) return res.status(400).json({ error: '未收到文件' });
  let buf;
  try { buf = Buffer.from(String(file).replace(/^data:[^;]*;base64,/, ''), 'base64'); }
  catch (e) { return res.status(400).json({ error: '文件解码失败' }); }
  let parsed;
  try { parsed = readTable(buf, filename); }
  catch (e) { return res.status(400).json({ error: '文件解析失败：' + e.message }); }
  if (!Array.isArray(parsed) || parsed.length < 2) {
    return res.status(400).json({ error: '文件中没有可导入的数据行（至少需要表头 + 1 行数据）' });
  }

  const header = parsed[0].map((h) => String(h == null ? '' : h).trim());
  const colOf = {};
  for (const field in PRODUCT_HEADER_MAP) {
    const idx = header.findIndex((h) => PRODUCT_HEADER_MAP[field].includes(h));
    if (idx >= 0) colOf[field] = idx;
  }
  if (colOf.name === undefined) {
    return res.status(400).json({ error: '未找到「商品名称」列，请使用系统模板或确保表头含「商品名称」' });
  }
  const get = (r, field) => { const i = colOf[field]; return i === undefined ? '' : (r[i] == null ? '' : r[i]); };

  // 库内已有编码（含名称），用于去重判定
  const existRows = db.prepare("SELECT sku, name FROM products WHERE sku IS NOT NULL AND sku <> ''").all();
  const existing = new Map(existRows.map((r) => [r.sku, r.name]));
  const importedThisRun = new Set();

  const imported = [];
  const skipped = [];
  let rowNo = 1;
  for (const raw of parsed.slice(1)) {
    rowNo++;
    if (raw.every((c) => c === '' || c == null)) continue; // 整行空白跳过
    const name = String(get(raw, 'name') || '').trim();
    const skuRaw = String(get(raw, 'sku') || '').trim();

    const reason = (() => {
      if (!name) return '商品名称为空';
      const pp = moneyNonNeg(get(raw, 'purchase_price') === '' ? 0 : get(raw, 'purchase_price'));
      const sp = moneyNonNeg(get(raw, 'sale_price') === '' ? 0 : get(raw, 'sale_price'));
      const st = intQty(get(raw, 'stock') === '' ? 0 : get(raw, 'stock'));
      const mn = intQty(get(raw, 'min_stock') === '' ? 0 : get(raw, 'min_stock'));
      if (pp === null) return '进货价非法（须为 ≥0 的数字）';
      if (sp === null) return '销售价非法（须为 ≥0 的数字）';
      if (st === null) return '初始库存非法（须为 ≥0 的整数）';
      if (mn === null) return '库存预警值非法（须为 ≥0 的整数）';
      const skuVal = skuRaw || null;
      if (skuVal) {
        if (existing.has(skuVal)) return `商品编码已存在（库内：${existing.get(skuVal)}）`;
        if (importedThisRun.has(skuVal)) return '商品编码在本文件中重复';
      }
      return null;
    })();

    if (reason) {
      skipped.push({ row: rowNo, sku: skuRaw, name, reason, cells: raw.slice() });
      continue;
    }
    imported.push({
      name,
      sku: skuRaw || null,
      category: String(get(raw, 'category') || '').trim(),
      unit: String(get(raw, 'unit') || '').trim() || '个',
      purchase_price: moneyNonNeg(get(raw, 'purchase_price') === '' ? 0 : get(raw, 'purchase_price')),
      sale_price: moneyNonNeg(get(raw, 'sale_price') === '' ? 0 : get(raw, 'sale_price')),
      stock: intQty(get(raw, 'stock') === '' ? 0 : get(raw, 'stock')),
      min_stock: intQty(get(raw, 'min_stock') === '' ? 0 : get(raw, 'min_stock')),
      note: String(get(raw, 'note') || '').trim()
    });
    if (skuRaw) importedThisRun.add(skuRaw);
  }

  // 入库（与 POST /api/products 同口径：校验已前置，事务内写入 + 期初批次建账）
  let inserted = 0;
  try {
    const tx = db.transaction(() => {
      const ins = db.prepare(`INSERT INTO products (sku, name, category, unit, purchase_price, sale_price, stock, min_stock, note, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);
      for (const d of imported) {
        const info = ins.run(d.sku, d.name, d.category, d.unit, d.purchase_price, d.sale_price, d.stock, d.min_stock, d.note, nowLocal());
        const id = info.lastInsertRowid;
        if (d.stock !== 0) {
          // 与 POST /api/products 建档口径完全一致：初始库存既写库存流水，也建立「期初」批次。
          // 缺了流水会：① 库存流水中看不到期初余额；② 删商品保护（按 stock_logs 判重）失效；③ 批次与流水口径不一致。
          db.prepare('INSERT INTO stock_logs (product_id, change_qty, type, ref_id, balance, note, operator, created_at) VALUES (?,?,?,?,?,?,?,?)')
            .run(id, d.stock, 'init', null, d.stock, '初始库存（批量导入）', req.session.username, nowLocal());
          db.createLot({ product_id: id, source: 'adjust', unit_cost: d.purchase_price, qty: d.stock, batch_no: '期初', note: '批量导入·初始库存建账' });
        }
        inserted++;
      }
    });
    tx();
  } catch (e) {
    return res.status(500).json({ error: '导入写入失败：' + e.message });
  }

  // 未导入表：原行（按表头长度对齐）+ 未导入原因
  let unimportedXlsx = null;
  if (skipped.length) {
    const hdr = header.slice();
    const need = Math.max(hdr.length, ...skipped.map((s) => s.cells.length));
    while (hdr.length < need) hdr.push('');
    hdr.push('未导入原因');
    const body = skipped.map((s) => {
      const cells = s.cells.slice();
      while (cells.length < need) cells.push('');
      cells.push(s.reason);
      return cells;
    });
    const out = buildWorkbook([{ name: '未导入商品', rows: [hdr, ...body] }]);
    unimportedXlsx = out.toString('base64');
  }

  res.json({
    imported: inserted,
    total: parsed.length - 1,
    skippedCount: skipped.length,
    skipped: skipped.map((s) => ({ row: s.row, sku: s.sku, name: s.name, reason: s.reason })),
    unimported_xlsx: unimportedXlsx
  });
});

app.post('/api/products', requireAuth, (req, res) => {
  const { sku, name, category, unit, purchase_price, sale_price, stock, min_stock, note } = req.body || {};
  if (!name) return res.status(400).json({ error: '商品名称必填' });
  // 建档数值必须合法：允许 0，但不允许负数（负进价会让毛利倒挂、负库存/负预警值毫无业务含义），
  // 也不允许 Infinity 这类非有限值（会写进 REAL 列，导出 Excel 时直接损坏文件）
  const newPP = moneyNonNeg(purchase_price == null || purchase_price === '' ? 0 : purchase_price);
  const newSP = moneyNonNeg(sale_price == null || sale_price === '' ? 0 : sale_price);
  if (newPP === null) return res.status(400).json({ error: `进货价必须是不小于 0 的数字，且不超过 ${MAX_MONEY}` });
  if (newSP === null) return res.status(400).json({ error: `销售价必须是不小于 0 的数字，且不超过 ${MAX_MONEY}` });
  const initStock = intQty(stock == null || stock === '' ? 0 : stock);
  const minStock = intQty(min_stock == null || min_stock === '' ? 0 : min_stock);
  if (initStock === null) return res.status(400).json({ error: `初始库存必须是不小于 0 的整数，且不超过 ${MAX_QTY}` });
  if (minStock === null) return res.status(400).json({ error: `库存预警值必须是不小于 0 的整数，且不超过 ${MAX_QTY}` });
  const skuVal = String(sku || '').trim() || null;
  // 商品编码去重：与现有编码比对，重复则拒绝
  if (skuVal) {
    const dup = db.prepare('SELECT id, name FROM products WHERE sku = ?').get(skuVal);
    if (dup) return res.status(400).json({ error: `商品编码「${skuVal}」已存在（商品：${dup.name}），请更换` });
  }
  let id;
  const tx = db.transaction(() => {
    const info = db.prepare(`INSERT INTO products (sku, name, category, unit, purchase_price, sale_price, stock, min_stock, note, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        skuVal, name, category || '', unit || '个',
        newPP, newSP, initStock, minStock, note || '', nowLocal()
      );
    id = info.lastInsertRowid;
    if (initStock !== 0) {
      db.prepare('INSERT INTO stock_logs (product_id, change_qty, type, ref_id, balance, note, operator, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, initStock, 'init', null, initStock, '初始库存', req.session.username, nowLocal());
      // 批次模型：初始库存也要有对应批次（期初建账），否则后续 FIFO 出库无批次可扣。
      // 以建档时填写的进货价作为该批次单价，成本口径与旧模型一致。
      db.createLot({ product_id: id, source: 'adjust', unit_cost: newPP, qty: initStock, batch_no: '期初', note: '新建商品·初始库存建账' });
    }
  });
  try { tx(); } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) return res.status(400).json({ error: `商品编码「${skuVal || ''}」已存在，请更换` });
    return res.status(500).json({ error: e.message });
  }
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
});

app.put('/api/products/:id', requireAuth, (req, res) => {
  const id = req.params.id;
  const { sku, name, category, unit, purchase_price, sale_price, min_stock, note } = req.body || {};
  if (!name) return res.status(400).json({ error: '商品名称必填' });
  // 与建档同口径：价格必须是不小于 0 的有限数字，预警值必须是不小于 0 的整数
  const edPP = moneyNonNeg(purchase_price == null || purchase_price === '' ? 0 : purchase_price);
  const edSP = moneyNonNeg(sale_price == null || sale_price === '' ? 0 : sale_price);
  const edMin = intQty(min_stock == null || min_stock === '' ? 0 : min_stock);
  if (edPP === null) return res.status(400).json({ error: `进货价必须是不小于 0 的数字，且不超过 ${MAX_MONEY}` });
  if (edSP === null) return res.status(400).json({ error: `销售价必须是不小于 0 的数字，且不超过 ${MAX_MONEY}` });
  if (edMin === null) return res.status(400).json({ error: `库存预警值必须是不小于 0 的整数，且不超过 ${MAX_QTY}` });
  const skuVal = String(sku || '').trim() || null;
  // 商品编码去重：排除自身，比对其他商品
  if (skuVal) {
    const dup = db.prepare('SELECT id, name FROM products WHERE sku = ? AND id <> ?').get(skuVal, id);
    if (dup) return res.status(400).json({ error: `商品编码「${skuVal}」已被商品「${dup.name}」使用，请更换` });
  }
  try {
    // 调价留痕：编辑商品的进货价 / 销售价时记录旧值 → 新值（改价报表数据来源）
    const before = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!before) return res.status(404).json({ error: '商品不存在' });
    db.prepare(`UPDATE products SET sku=?, name=?, category=?, unit=?, purchase_price=?, sale_price=?, min_stock=?, note=? WHERE id=?`)
      .run(skuVal, name, category || '', unit || '个', edPP, edSP, edMin, note || '', id);
    if (r2(before.purchase_price) > 0 && priceChanged(before.purchase_price, edPP)) {
      logPrice({
        log_type: 'product', product_id: parseInt(id), product_name: name, doc_type: '', doc_id: null, bill_no: '',
        price_field: 'purchase_price', old_price: before.purchase_price, new_price: edPP, qty: 0,
        party_name: '', operator: req.session.username || '',
        note: edPP > r2(before.purchase_price) ? '商品管理·进货价上调' : '商品管理·进货价下调'
      });
    }
    if (r2(before.sale_price) > 0 && priceChanged(before.sale_price, edSP)) {
      logPrice({
        log_type: 'product', product_id: parseInt(id), product_name: name, doc_type: '', doc_id: null, bill_no: '',
        price_field: 'sale_price', old_price: before.sale_price, new_price: edSP, qty: 0,
        party_name: '', operator: req.session.username || '',
        note: edSP > r2(before.sale_price) ? '商品管理·售价上调' : '商品管理·售价下调'
      });
    }
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) return res.status(400).json({ error: `商品编码「${skuVal || ''}」已存在，请更换` });
    return res.status(500).json({ error: e.message });
  }
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
});

// 删除商品会连带改变历史库存口径（虽然已挡掉有出入库记录的商品），属破坏性操作，需管理员权限
app.delete('/api/products/:id', requireAdmin, (req, res) => {
  const id = req.params.id;
  const prod = db.prepare('SELECT name FROM products WHERE id=?').get(id);
  if (!prod) return res.status(404).json({ error: '商品不存在或已被删除' });
  const used = db.prepare('SELECT COUNT(*) AS c FROM purchase_items WHERE product_id = ?').get(id).c +
              db.prepare('SELECT COUNT(*) AS c FROM sale_items WHERE product_id = ?').get(id).c;
  if (used > 0) return res.status(400).json({ error: `商品「${prod.name}」已有出入库记录，无法删除；如需下架请把库存调为 0 后改名标注（如「${prod.name}（停售）」）` });
  const logged = db.prepare('SELECT COUNT(*) AS c FROM stock_logs WHERE product_id = ?').get(id).c;
  if (logged > 0) return res.status(400).json({ error: `商品「${prod.name}」有 ${logged} 条库存变动日志，无法删除；如需下架请把库存调为 0 后改名标注` });
  try { db.prepare('DELETE FROM products WHERE id = ?').run(id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: '该商品仍被其他数据引用，暂不能删除：' + e.message }); }
});

// ---------- 供应商 ----------
app.get('/api/suppliers', requireAuth, (req, res) => {
  const { search } = req.query;
  let sql = 'SELECT * FROM suppliers WHERE 1=1'; const params = [];
  if (search) { sql += ' AND (name LIKE ? OR contact LIKE ? OR phone LIKE ?)'; const s = `%${search}%`; params.push(s, s, s); }
  sql += ' ORDER BY id DESC';
  res.json(db.prepare(sql).all(...params));
});

app.post('/api/suppliers', requireAuth, (req, res) => {
  const { name, contact, phone, address, note } = req.body || {};
  if (!name) return res.status(400).json({ error: '供应商名称必填' });
  const info = db.prepare('INSERT INTO suppliers (name, contact, phone, address, note) VALUES (?,?,?,?,?)')
    .run(name, contact || '', phone || '', address || '', note || '');
  res.json(db.prepare('SELECT * FROM suppliers WHERE id = ?').get(info.lastInsertRowid));
});

app.put('/api/suppliers/:id', requireAuth, (req, res) => {
  const { name, contact, phone, address, note } = req.body || {};
  if (!name) return res.status(400).json({ error: '供应商名称必填' });
  db.prepare('UPDATE suppliers SET name=?, contact=?, phone=?, address=?, note=? WHERE id=?')
    .run(name, contact || '', phone || '', address || '', note || '', req.params.id);
  res.json(db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id));
});

app.delete('/api/suppliers/:id', requireAuth, (req, res) => {
  const id = req.params.id;
  const sup = db.prepare('SELECT name FROM suppliers WHERE id=?').get(id);
  if (!sup) return res.status(404).json({ error: '供应商不存在或已被删除' });
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM purchases WHERE supplier_id=?').get(id).c;
  if (cnt > 0) {
    return res.status(400).json({
      error: `供应商「${sup.name}」已有 ${cnt} 张采购单，为保留历史账目不能删除。若已停止合作，可把名称改为「${sup.name}（停用）」并清空联系电话。`
    });
  }
  const payCnt = db.prepare('SELECT COUNT(*) AS c FROM payments WHERE party_type=? AND party_id=?').get('supplier', id).c;
  if (payCnt > 0) {
    return res.status(400).json({
      error: `供应商「${sup.name}」有 ${payCnt} 笔收付款记录，为保留资金流水不能删除。若已停止合作，可把名称改为「${sup.name}（停用）」。`
    });
  }
  try { db.prepare('DELETE FROM suppliers WHERE id = ?').run(id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: '该供应商仍被其他数据引用，暂不能删除：' + e.message }); }
});

// ---------- 客户 ----------
// 返回客户列表，并附带「当前应收」「授信额度」「可用额度」
app.get('/api/customers', requireAuth, (req, res) => {
  const { search } = req.query;
  let where = 'WHERE 1=1'; const params = [];
  if (search) { where += ' AND (c.name LIKE ? OR c.contact LIKE ? OR c.phone LIKE ?)'; const s = `%${search}%`; params.push(s, s, s); }
  // 应收只排除「已退单」：退单待审（pending_return）的货还没退、钱也没退，
  // 债权债务依然成立，必须计入应收与授信占用，否则客户提了退单申请就能凭空释放额度。
  const sql = `SELECT c.*,
    COALESCE(SUM(s.total_amount - (SELECT COALESCE(SUM(amount),0) FROM payment_allocations WHERE doc_type='sale' AND doc_id=s.id)),0) AS receivable
    FROM customers c
    LEFT JOIN sales s ON s.customer_id = c.id AND (s.status IS NULL OR s.status != 'returned')
    ${where}
    GROUP BY c.id
    ORDER BY c.id DESC`;
  const advMap = advanceMapOf('customer');
  const rows = db.prepare(sql).all(...params).map(r => {
    const limit = r.credit_limit == null ? 100000 : r2(r.credit_limit);
    const receivable = r2(r.receivable);
    const advance = advMap.get(r.id) || 0;
    // 预收款是客户「已经付过的钱」，先用它冲抵欠款，剩下的部分才占用授信额度
    const used = Math.max(0, r2(receivable - advance));
    return { ...r, credit_limit: limit, receivable, advance, credit_used: used, available: r2(limit - used) };
  });
  res.json(rows);
});

// 解析「授信额度（赊货金额）」：允许 0（表示禁止赊账），不允许负数或非法数值
// 返回 { err } 表示拒绝；{ value: null } 表示前端没传、保持原值
function parseCreditLimit(raw, fallback) {
  if (raw == null || raw === '') return { value: fallback };
  const v = moneyNonNeg(raw);
  if (v === null) return { err: `授信额度必须是不小于 0 的数字，且不超过 ${MAX_MONEY}` };
  return { value: v };
}
app.post('/api/customers', requireAuth, (req, res) => {
  const { name, contact, phone, address, note, credit_limit } = req.body || {};
  if (!name) return res.status(400).json({ error: '客户名称必填' });
  const cl = parseCreditLimit(credit_limit, 100000);
  if (cl.err) return res.status(400).json({ error: cl.err });
  const info = db.prepare('INSERT INTO customers (name, contact, phone, address, note, credit_limit) VALUES (?,?,?,?,?,?)')
    .run(name, contact || '', phone || '', address || '', note || '', cl.value);
  res.json(db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid));
});

app.put('/api/customers/:id', requireAuth, (req, res) => {
  const { name, contact, phone, address, note, credit_limit } = req.body || {};
  if (!name) return res.status(400).json({ error: '客户名称必填' });
  const cur = db.prepare('SELECT id, credit_limit FROM customers WHERE id = ?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: '客户不存在' });
  const oldLimit = cur.credit_limit == null ? 100000 : r2(cur.credit_limit);
  const cl = parseCreditLimit(credit_limit, oldLimit);
  if (cl.err) return res.status(400).json({ error: cl.err });
  // 授信额度是唯一的赊账风控闸门：普通用户若能自行调高，就能绕开「超额禁止开单」的限制无限赊货，
  // 相当于把风控开关交给了被风控对象，因此只有管理员可以改动。
  if (Math.abs(r2(cl.value) - oldLimit) > 0.005 && !isAdminSession(req)) {
    return res.status(403).json({ error: `授信额度属于风控参数（当前 ${fmtMoney(oldLimit)}），只有管理员可以调整。如需提高请联系管理员处理。` });
  }
  db.prepare('UPDATE customers SET name=?, contact=?, phone=?, address=?, note=?, credit_limit=? WHERE id=?')
    .run(name, contact || '', phone || '', address || '', note || '', cl.value, req.params.id);
  res.json(db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id));
});

app.delete('/api/customers/:id', requireAuth, (req, res) => {
  const id = req.params.id;
  const cus = db.prepare('SELECT name FROM customers WHERE id=?').get(id);
  if (!cus) return res.status(404).json({ error: '客户不存在或已被删除' });
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM sales WHERE customer_id=?').get(id).c;
  if (cnt > 0) {
    return res.status(400).json({
      error: `客户「${cus.name}」已有 ${cnt} 张销售单，为保留历史账目不能删除。若已停止合作，可把名称改为「${cus.name}（停用）」并清空联系电话。`
    });
  }
  const payCnt = db.prepare('SELECT COUNT(*) AS c FROM payments WHERE party_type=? AND party_id=?').get('customer', id).c;
  if (payCnt > 0) {
    return res.status(400).json({
      error: `客户「${cus.name}」有 ${payCnt} 笔收付款记录，为保留资金流水不能删除。若已停止合作，可把名称改为「${cus.name}（停用）」。`
    });
  }
  try { db.prepare('DELETE FROM customers WHERE id = ?').run(id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: '该客户仍被其他数据引用，暂不能删除：' + e.message }); }
});

// ---------- 往来单位交易清单（客户 / 供应商） ----------
// 按商品名称模糊匹配 + 日期段（含首尾）筛选，默认不限日期（返回全部历史）
function partnerTxData(type, id, q) {
  const isSup = type === 'supplier';
  const party = db.prepare(`SELECT id, name, contact, phone FROM ${isSup ? 'suppliers' : 'customers'} WHERE id = ?`).get(id);
  if (!party) return null;

  const docTbl = isSup ? 'purchases' : 'sales';
  const itemTbl = isSup ? 'purchase_items' : 'sale_items';
  const fk = isSup ? 'purchase_id' : 'sale_id';
  const partyCol = isSup ? 'supplier_id' : 'customer_id';
  const dir = isSup ? 'purchase' : 'sale';
  const product = String((q && q.product) || '').trim();
  const from = String((q && q.from) || '').slice(0, 10);
  const to = String((q && q.to) || '').slice(0, 10);

  const where = [`d.${partyCol} = ?`];
  const params = [id];
  if (from) { where.push("substr(d.created_at,1,10) >= ?"); params.push(from); }
  if (to) { where.push("substr(d.created_at,1,10) <= ?"); params.push(to); }
  if (product) {
    where.push(`EXISTS (SELECT 1 FROM ${itemTbl} it JOIN products pr ON it.product_id = pr.id
      WHERE it.${fk} = d.id AND pr.name LIKE ?)`);
    params.push('%' + product + '%');
  }

  const docs = db.prepare(`SELECT d.id, d.bill_no, d.created_at, d.total_amount, d.deposit, d.status, d.note, d.return_reason
    FROM ${docTbl} d WHERE ${where.join(' AND ')}
    ORDER BY d.created_at DESC, d.id DESC`).all(...params);

  // 一次性取出所有明细，避免 N+1 查询
  const itemsBy = new Map();
  if (docs.length) {
    const ids = docs.map((d) => d.id);
    const rows = db.prepare(`SELECT it.${fk} AS doc_id, it.qty, it.price, it.subtotal, pr.name, pr.sku, pr.unit
      FROM ${itemTbl} it JOIN products pr ON it.product_id = pr.id
      WHERE it.${fk} IN (${ids.map(() => '?').join(',')}) ORDER BY it.id`).all(...ids);
    for (const r of rows) {
      if (!itemsBy.has(r.doc_id)) itemsBy.set(r.doc_id, []);
      itemsBy.get(r.doc_id).push({ name: r.name, sku: r.sku || '', unit: r.unit || '', qty: Number(r.qty) || 0, price: r2(r.price), subtotal: r2(r.subtotal) });
    }
  }

  const paidStmt = db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM payment_allocations WHERE doc_type = ? AND doc_id = ?');
  let amount = 0, amountActive = 0, amountReturned = 0, qty = 0, countActive = 0, countReturned = 0, countPending = 0;

  const list = docs.map((d) => {
    const items = itemsBy.get(d.id) || [];
    const amt = r2(d.total_amount);
    const paid = r2(paidStmt.get(dir, d.id).s);
    const status = d.status || 'active';
    const q = items.reduce((s, it) => s + it.qty, 0);
    amount += amt;
    if (status === 'returned') { amountReturned += amt; countReturned++; }
    else {
      amountActive += amt;
      qty += q;
      if (status === 'pending_return') countPending++; else countActive++;
    }
    return {
      id: d.id, bill_no: d.bill_no, created_at: d.created_at || '', amount: amt,
      deposit: r2(d.deposit || 0), paid, outstanding: r2(amt - paid),
      qty: q, status, items,
      note: d.note || '', return_reason: d.return_reason || ''
    };
  });

  return {
    party: { id: party.id, name: party.name, contact: party.contact || '', phone: party.phone || '' },
    type,
    filters: { product, from, to },
    list,
    totals: {
      count: list.length, countActive, countPending, countReturned,
      amount: r2(amount), amountActive: r2(amountActive), amountReturned: r2(amountReturned), qty
    }
  };
}

function partnerType(req, res) {
  const t = req.params.type === 'supplier' ? 'supplier' : (req.params.type === 'customer' ? 'customer' : null);
  if (!t) { res.status(400).json({ error: '类型只能是 customer 或 supplier' }); return null; }
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: '单位 ID 不合法' }); return null; }
  return { type: t, id };
}

app.get('/api/partners/:type/:id/transactions', requireAuth, (req, res) => {
  const p = partnerType(req, res);
  if (!p) return;
  const d = partnerTxData(p.type, p.id, req.query || {});
  if (!d) return res.status(404).json({ error: p.type === 'supplier' ? '供应商不存在' : '客户不存在' });
  res.json(d);
});

app.get('/api/partners/:type/:id/transactions/export', requireAuth, (req, res) => {
  const p = partnerType(req, res);
  if (!p) return;
  const d = partnerTxData(p.type, p.id, req.query || {});
  if (!d) return res.status(404).json({ error: p.type === 'supplier' ? '供应商不存在' : '客户不存在' });
  if (!d.list.length) return res.status(400).json({ error: '没有符合条件的交易记录，无法导出' });

  const isSup = p.type === 'supplier';
  // 单次导出行数上限：buildWorkbook 是同步生成 ZIP，几万行会把主线程占满数秒，
  // 期间所有接口（连登录都算）全部无响应。与收付款导出的 PAY_EXPORT_MAX 同一思路：
  // 超限只截断明细，合计行仍按全量算，并在表头写明"仅含最近 N 笔"，避免被当成全部数据。
  const EXPORT_MAX_ROWS = 20000;
  const truncated = d.list.length > EXPORT_MAX_ROWS;
  const exportList = truncated ? d.list.slice(0, EXPORT_MAX_ROWS) : d.list;
  const statusText = { active: '正常', pending_return: '退单待审', returned: '已退单' };
  const rows = [
    [`${d.party.name} · ${isSup ? '采购交易清单' : '销售交易清单'}`],
    [`筛选：商品 ${d.filters.product || '全部'} ｜ 日期 ${d.filters.from || '不限'} ~ ${d.filters.to || '不限'} ｜ 共 ${d.totals.count} 笔`
      + (truncated ? ` ｜ ⚠ 单次最多导出 ${EXPORT_MAX_ROWS} 笔，本表仅含最近 ${EXPORT_MAX_ROWS} 笔；下方合计仍为全量` : '')],
    [],
    ['交易时间', '单号', isSup ? '供应商' : '客户', '商品明细', '数量合计', '金额', '已付', '未付', '状态', '备注']
  ];
  for (const r of exportList) {
    const detail = (r.items || []).map((it) => `${it.name}×${it.qty}${it.unit ? it.unit : ''}`).join('；');
    rows.push([
      (r.created_at || '').slice(0, 19),
      r.bill_no,
      d.party.name,
      detail,
      r.qty,
      r.amount,
      r.paid,
      r.outstanding,
      statusText[r.status] || r.status,
      r.status === 'returned' ? ('退单原因：' + (r.return_reason || '—')) : (r.note || '')
    ]);
  }
  rows.push([]);
  rows.push(['合计（不含已退单）', '', '', '', d.totals.qty, d.totals.amountActive, '', '', '', '']);
  rows.push(['已退单', '', '', '', '', d.totals.amountReturned, '', '', `${d.totals.countReturned} 笔`, '']);

  let buf;
  try { buf = buildWorkbook([{ name: isSup ? '采购交易清单' : '销售交易清单', rows }]); }
  catch (e) { return res.status(500).json({ error: '生成 Excel 失败：' + e.message }); }

  const stamp = db.prepare("SELECT strftime('%Y%m%d','now','localtime') AS d").get().d;
  const fname = `${d.party.name}_${isSup ? '采购' : '销售'}交易清单_${stamp}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="partner_tx_${stamp}.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
});

// ---------- 单据编号 ----------
// 注意：原来用 COUNT(*)+1 生成序号，一旦删过单据或历史上有跳号，
// 就会生成一个「已经存在」的单号（撞号），导致两单共号、按单号查/导出串单。
// 改为取当日已用过的最大序号 + 1（配合 db.js 里 bill_no 的唯一索引兜底）。
// 另外必须把 doc_voids 里的作废单号一起纳入：作废会删掉单据本身，只看在库单据的话，
// 作废掉「当天最后一张」后序号会回退，新单就会复用已作废的单号，对账时两笔生意串成一张。
function nextBillNo(prefix, table) {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const head = `${prefix}${ymd}-`;
  const pos = head.length + 1;
  const live = db.prepare(`SELECT COALESCE(MAX(CAST(substr(bill_no, ?) AS INTEGER)), 0) AS mx
    FROM ${table} WHERE bill_no LIKE ?`).get(pos, `${head}%`);
  const voided = db.prepare(`SELECT COALESCE(MAX(CAST(substr(bill_no, ?) AS INTEGER)), 0) AS mx
    FROM doc_voids WHERE doc_type = ? AND bill_no LIKE ?`).get(pos, prefix === 'CG' ? 'purchase' : 'sale', `${head}%`);
  const mx = Math.max(Number(live.mx) || 0, Number(voided.mx) || 0);
  return `${head}${String(mx + 1).padStart(4, '0')}`;
}

// ---------- 采购入库 ----------
const doPurchase = db.transaction((data, operator) => {
  const { supplier_id, note, items, deposit } = data;
  if (!Array.isArray(items) || items.length === 0) throw new Error('请至少添加一条商品');
  if (items.length > 500) throw new Error('单张单据最多 500 行明细，请拆单录入');
  const billNo = nextBillNo('CG', 'purchases');
  let total = 0;
  // 供应商名称（用于改价留痕）
  let supName = '';
  if (supplier_id) { const s = db.prepare('SELECT name FROM suppliers WHERE id = ?').get(supplier_id); supName = s ? s.name : ''; }
  const insItem = db.prepare('INSERT INTO purchase_items (purchase_id, product_id, qty, price, subtotal) VALUES (?,?,?,?,?)');
  const updStock = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?');
  const getLastLot = db.prepare('SELECT unit_cost FROM inventory_lots WHERE product_id=? ORDER BY received_at DESC, id DESC LIMIT 1');
  const affectedProducts = new Set();
  const insLog = db.prepare('INSERT INTO stock_logs (product_id, change_qty, type, ref_id, balance, note, operator, created_at) VALUES (?,?,?,?,?,?,?,?)');
  const getProduct = db.prepare('SELECT * FROM products WHERE id = ?');

  const info = db.prepare('INSERT INTO purchases (bill_no, supplier_id, total_amount, deposit, note, operator, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(billNo, supplier_id || null, 0, 0, note || '', operator, nowLocal());
  const purchaseId = info.lastInsertRowid;

  for (const it of items) {
    const pid = parseInt(it.product_id);
    // 数量必须是正整数，且有上界：原来只判了「整数且 >0」，于是 9e15（接近浮点安全整数上限）
    // 也能合法入库，一次就把库存灌到 9,007,199,254,740,991，之后所有库存/货值报表都没法看
    const qty = intQty(it.qty);
    if (!pid || qty === null || qty === 0) throw new Error('采购明细有误：数量必须是大于 0 的整数');
    // 单价必须明确填写，且是不小于 0 的有限金额：空值一律拒绝（原来 null 会被当成 0，静默做成白送），
    // NaN / Infinity 会让进货额与库存金额直接失真
    const priceRaw = it.price;
    const price = (priceRaw === null || priceRaw === undefined || String(priceRaw).trim() === '') ? null : moneyNonNeg(priceRaw);
    if (price === null) throw new Error(`采购单价必须是不小于 0 的数字，且不超过 ${MAX_MONEY}`);
    const prod = getProduct.get(pid);
    if (!prod) throw new Error(`商品不存在(id=${pid})`);
    const subtotal = money(price * qty);
    if (subtotal === null) throw new Error(`单行金额过大（上限 ${MAX_MONEY}），请拆单录入`);
    total += subtotal;
    // 改价留痕：与「上一批次实际进价」对比（批次模型下商品进价不再被单批覆盖，
    // 故用最近一批次的 unit_cost 作为「上一次进价」记录批次间价格变动；首次建档不记）
    const lastLot = getLastLot.get(pid);
    const lastCost = lastLot ? r2(lastLot.unit_cost) : 0;
    if (lastCost > 0 && price > 0 && priceChanged(lastCost, price)) {
      logPrice({
        log_type: 'doc', product_id: pid, product_name: prod.name, doc_type: 'purchase', doc_id: purchaseId,
        bill_no: billNo, price_field: 'purchase_price', old_price: lastCost, new_price: price, qty,
        party_name: supName, operator, note: price > lastCost ? '进价上调' : '进价下调'
      });
    }
    const itemId = insItem.run(purchaseId, pid, qty, price, subtotal).lastInsertRowid;
    // 批次模型：每一行采购建一个独立批次（供应商/批号/单价/数量/剩余量），成本按 FIFO 计算。
    // 单价为 0（赠品/漏填）也照常建批次，unit_cost 记 0，由加权平均自然体现，绝不再用它覆盖商品进价。
    db.createLot({
      product_id: pid, supplier_id: supplier_id || null, purchase_id: purchaseId,
      purchase_item_id: itemId, batch_no: billNo, unit_cost: price, qty
    });
    updStock.run(qty, pid);
    affectedProducts.add(pid);
    const newStock = db.prepare('SELECT stock FROM products WHERE id = ?').get(pid).stock;
    insLog.run(pid, qty, 'purchase', purchaseId, newStock, `采购单 ${billNo}`, operator, nowLocal());
  }
  // 入库后把每个受影响商品的 purchase_price 重算为「剩余批次加权平均单价」，
  // 使 stock*purchase_price ≡ Σ(批次剩余×批次单价)=FIFO 在库货值，原报表无需改写即精确。
  for (const pid of affectedProducts) db.recomputeProductCost(pid);
  if (Math.abs(total) > MAX_MONEY) throw new Error(`单据金额超出上限 ${MAX_MONEY}，请拆单录入`);
  db.prepare('UPDATE purchases SET total_amount = ? WHERE id = ?').run(r2(total), purchaseId);
  // 定金不得超过本单货款：否则会生成「超付分摊」，应付变负数，账面无法解释（与销售侧同口径）
  const depAmtPur = moneyNonNeg(deposit == null ? 0 : deposit);
  if (depAmtPur === null) throw new Error('定金不能为负数，且必须是有效数字');
  db.prepare('UPDATE purchases SET deposit = ? WHERE id = ?').run(depAmtPur, purchaseId);
  if (depAmtPur > r2(total) + 0.001) throw new Error(`定金 ${fmtMoney(depAmtPur)} 超过本单货款 ${fmtMoney(total)}，请修正后再提交`);
  // 约定定金自动记为收付款（计入已付、从应付扣除）
  createDepositPayment('purchase', purchaseId, depAmtPur, 'supplier', supplier_id || null, operator);
  // 自动用该供应商既有预付款余额抵减本单
  const advApplied = autoApplyAdvance('purchase', purchaseId, 'supplier', supplier_id || null);
  return { purchaseId, advApplied };
});

app.post('/api/purchases', requireAuth, (req, res) => {
  try {
    const r = doPurchase(req.body || {}, req.session.username);
    const doc = db.prepare('SELECT * FROM purchases WHERE id = ?').get(r.purchaseId);
    // 补上未付金额：原来只有销售侧返回 outstanding，采购提交后前端提示不出「还欠多少」，
    // 而采购恰恰是最常见挂账的场景
    const paid = r2(db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payment_allocations WHERE doc_type='purchase' AND doc_id=?").get(doc.id).s);
    res.json({ ...doc, advance_applied: r.advApplied, paid_now: 0, paid, outstanding: r2((Number(doc.total_amount) || 0) - paid) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/purchases', requireAuth, (req, res) => {
  const { from, to, keyword } = req.query;
  let sql = `SELECT p.*, s.name AS supplier_name FROM purchases p LEFT JOIN suppliers s ON p.supplier_id = s.id WHERE 1=1`;
  const params = [];
  if (from) { sql += ' AND date(p.created_at) >= date(?)'; params.push(from); }
  if (to) { sql += ' AND date(p.created_at) <= date(?)'; params.push(to); }
  if (keyword) { sql += ' AND (p.bill_no LIKE ? OR s.name LIKE ?)'; const k = `%${keyword}%`; params.push(k, k); }
  return listPaged(sql, params, 'ORDER BY p.id DESC', req, res, 500);
});

app.get('/api/purchases/:id', requireAuth, (req, res) => {
  const head = db.prepare(`SELECT p.*, s.name AS supplier_name FROM purchases p LEFT JOIN suppliers s ON p.supplier_id = s.id WHERE p.id = ?`).get(req.params.id);
  if (!head) return res.status(404).json({ error: '采购单不存在' });
  const items = db.prepare(`SELECT pi.*, pr.name AS product_name, pr.sku, pr.unit FROM purchase_items pi LEFT JOIN products pr ON pi.product_id = pr.id WHERE pi.purchase_id = ?`).all(req.params.id);
  // 已付/未付：打印单据时要直接印在纸上，不能让前端再猜一遍
  const paid = r2(db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payment_allocations WHERE doc_type='purchase' AND doc_id=?").get(head.id).s);
  res.json({ ...head, items, paid, outstanding: r2((Number(head.total_amount) || 0) - paid) });
});

// ---------- 销售出库 ----------
const doSale = db.transaction((data, operator) => {
  const { customer_id, note, items, deposit } = data;
  // 是否为「出库同时收款完毕」（开单即结清，不挂应收）
  const paidInFull = data.paid_in_full === true || data.paid_in_full === 1 || data.paid_in_full === '1';
  const PAY_METHOD_SET = ['cash', 'bank', 'alipay', 'wechat', 'other'];
  const payMethod = PAY_METHOD_SET.includes(data.pay_method) ? data.pay_method : 'cash';
  if (!Array.isArray(items) || items.length === 0) throw new Error('请至少添加一条商品');
  if (items.length > 500) throw new Error('单张单据最多 500 行明细，请拆单录入');
  let custName = '', custLimit = 100000, existingReceivable = 0;
  if (customer_id) {
    const cust = db.prepare('SELECT id, name, COALESCE(credit_limit, 100000) AS credit_limit FROM customers WHERE id = ?').get(customer_id);
    if (!cust) throw new Error('客户不存在');
    custName = cust.name;
    custLimit = r2(cust.credit_limit);
    // 开单前先算该客户当前应收（不含本单）
    existingReceivable = customerReceivable(customer_id);
  }
  const billNo = nextBillNo('XS', 'sales');
  let total = 0, profit = 0;
  const insItem = db.prepare('INSERT INTO sale_items (sale_id, product_id, qty, price, cost, subtotal, profit) VALUES (?,?,?,?,?,?,?)');
  const updProduct = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?');
  const insLog = db.prepare('INSERT INTO stock_logs (product_id, change_qty, type, ref_id, balance, note, operator, created_at) VALUES (?,?,?,?,?,?,?,?)');
  const getProduct = db.prepare('SELECT * FROM products WHERE id = ?');
  const affectedProducts = new Set();

  const info = db.prepare('INSERT INTO sales (bill_no, customer_id, total_amount, deposit, total_profit, note, operator, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(billNo, customer_id || null, 0, 0, 0, note || '', operator, nowLocal());
  const saleId = info.lastInsertRowid;

  for (const it of items) {
    const pid = parseInt(it.product_id);
    // 数量必须是正整数且有上界：原来只判了「整数且 >0」，9e15 也能通过，
    // 会把库存一次性扣到 -9,007,199,254,740,991，库存永无翻身之日
    const qty = intQty(it.qty);
    if (!pid || qty === null || qty === 0) throw new Error('销售明细有误：数量必须是大于 0 的整数');
    // 单价必须明确填写，且是不小于 0 的有限金额（空值原来会被当成 0，静默做成白送）
    const priceRaw = it.price;
    const price = (priceRaw === null || priceRaw === undefined || String(priceRaw).trim() === '') ? null : moneyNonNeg(priceRaw);
    if (price === null) throw new Error(`销售单价必须是不小于 0 的数字，且不超过 ${MAX_MONEY}`);
    const prod = getProduct.get(pid);
    if (!prod) throw new Error(`商品不存在(id=${pid})`);
    if (prod.stock < qty) throw new Error(`「${prod.name}」库存不足（现有 ${prod.stock}）`);
    // 批次 FIFO 成本：从最老批次实际消耗，返回本行真实总成本（精确，未取整）。
    // 若批次可发量不足（数据漂移）会抛错并整体回滚（doSale 已包事务）。
    const costTotal = db.fifoConsume(pid, qty);
    const cost = r2(costTotal / qty);      // 本行单位成本（仅展示/落库用）
    const subtotal = money(price * qty);
    if (subtotal === null) throw new Error(`单行金额过大（上限 ${MAX_MONEY}），请拆单录入`);
    // 利润用「精确总收入 - 精确总出货成本」对平，避免单价四舍五入造成的毛利积水
    const lineProfit = r2(subtotal - costTotal);
    total += subtotal; profit += lineProfit;
    // 改价留痕：成交单价 ≠ 商品标准售价（让价 / 加价）
    if (r2(prod.sale_price) > 0 && priceChanged(prod.sale_price, price)) {
      logPrice({
        log_type: 'doc', product_id: pid, product_name: prod.name, doc_type: 'sale', doc_id: saleId,
        bill_no: billNo, price_field: 'sale_price', old_price: prod.sale_price, new_price: price, qty,
        party_name: custName || '散客', operator, note: r2(price) > r2(prod.sale_price) ? '高于标准售价' : '低于标准售价（让价）'
      });
    }
    insItem.run(saleId, pid, qty, price, cost, subtotal, lineProfit);
    updProduct.run(qty, pid);
    affectedProducts.add(pid);
    const newStock = db.prepare('SELECT stock FROM products WHERE id = ?').get(pid).stock;
    insLog.run(pid, -qty, 'sale', saleId, newStock, `销售单 ${billNo}`, operator, nowLocal());
  }
  // 出库后重算受影响商品的加权成本（FIFO 消耗已扣减批次），使 stock*purchase_price ≡ FIFO 在库货值
  for (const pid of affectedProducts) db.recomputeProductCost(pid);
  db.prepare('UPDATE sales SET total_amount = ?, total_profit = ? WHERE id = ?').run(r2(total), r2(profit), saleId);
  // 定金不得超过本单货款，否则会生成「超付分摊」，账目无法解释
  const depAmt = moneyNonNeg(deposit == null ? 0 : deposit);
  if (depAmt === null) throw new Error('定金不能为负数，且必须是有效数字');
  db.prepare('UPDATE sales SET deposit = ? WHERE id = ?').run(depAmt, saleId);
  if (Math.abs(total) > MAX_MONEY) throw new Error(`单据金额超出上限 ${MAX_MONEY}，请拆单录入`);
  if (depAmt > r2(total) + 0.001) throw new Error(`定金 ${fmtMoney(depAmt)} 超过本单货款 ${fmtMoney(total)}，请修正后再提交`);
  // 授信额度（赊货金额）校验：本次新增赊账 = 销售总额 - 约定定金（定金当场收讫，不计入赊账）
  // 若「当前欠款 + 本次新增赊账」超过授信额度，则禁止开单，避免客户欠款超赊货金额
  // 勾选「出库同时收款完毕」时不产生赊账，无需受授信额度限制
  if (customer_id && !paidInFull) {
    const newCredit = r2(Math.max(0, total - depAmt));
    // 预收款是客户已经交过的钱，会先抵扣本单赊账，因此计算占用额度时要先减掉
    const advBal = advanceBalanceOf('customer', customer_id);
    const projected = Math.max(0, r2(existingReceivable + newCredit - advBal));
    if (projected > custLimit + 0.001) {
      const avail = Math.max(0, r2(custLimit - existingReceivable + advBal));
      throw new Error(`「${custName}」授信额度不足，已禁止开单：当前欠款 ${fmtMoney(existingReceivable)}，预收款余额 ${fmtMoney(advBal)}，本次将新增赊账 ${fmtMoney(newCredit)}，超过授信额度 ${fmtMoney(custLimit)}（可用 ${fmtMoney(avail)}）`);
    }
  }
  // 抵扣前先记住客户原有预收款余额（用于回话与前端核对）
  const advanceBefore = customer_id ? advanceBalanceOf('customer', customer_id) : 0;
  // 约定定金自动记为收付款（计入已收、从应收扣除）
  createDepositPayment('sale', saleId, depAmt, 'customer', customer_id || null, operator);
  // 自动用该客户既有预收款余额抵减本单
  const advApplied = autoApplyAdvance('sale', saleId, 'customer', customer_id || null);
  // 出库同时收款完毕：补收剩余未收金额，一次性结清本单（计入收款流水，不再挂应收）
  let paidNow = 0;
  if (paidInFull) {
    const remain = r2(total - (paidOf('sale', saleId) || 0));
    if (remain > 0.001) {
      const note2 = advApplied > 0.001
        ? `出库同时收款（预存抵扣 ${fmtMoney(advApplied)} 后补收余款）`
        : '出库同时收款（一次性结清）';
      const info = db.prepare('INSERT INTO payments (direction, party_type, party_id, amount, method, note, operator, is_deposit, created_at) VALUES (?,?,?,?,?,?,?,0,?)')
        .run('receive', customer_id ? 'customer' : null, customer_id || null, remain, payMethod, note2, operator, nowLocal());
      db.prepare("INSERT INTO payment_allocations (payment_id, doc_type, doc_id, amount, source) VALUES (?,?,?,?,'cash')")
        .run(info.lastInsertRowid, 'sale', saleId, remain);
      paidNow = remain;
    }
  }
  const outstanding = r2(Math.max(0, total - (paidOf('sale', saleId) || 0)));
  return { saleId, advApplied, paidNow, advanceBefore, outstanding, settled: outstanding <= 0.001 };
});

app.post('/api/sales', requireAuth, (req, res) => {
  try {
    const r = doSale(req.body || {}, req.session.username);
    const doc = db.prepare('SELECT * FROM sales WHERE id = ?').get(r.saleId);
    res.json({
      ...doc,
      advance_before: r.advanceBefore || 0,
      advance_applied: r.advApplied || 0,
      paid_now: r.paidNow || 0,
      outstanding: r.outstanding || 0,
      settled: !!r.settled
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/sales', requireAuth, (req, res) => {
  const { from, to, keyword } = req.query;
  let sql = `SELECT s.*, c.name AS customer_name FROM sales s LEFT JOIN customers c ON s.customer_id = c.id WHERE 1=1`;
  const params = [];
  if (from) { sql += ' AND date(s.created_at) >= date(?)'; params.push(from); }
  if (to) { sql += ' AND date(s.created_at) <= date(?)'; params.push(to); }
  if (keyword) { sql += ' AND (s.bill_no LIKE ? OR c.name LIKE ?)'; const k = `%${keyword}%`; params.push(k, k); }
  return listPaged(sql, params, 'ORDER BY s.id DESC', req, res, 500);
});

app.get('/api/sales/:id', requireAuth, (req, res) => {
  const head = db.prepare(`SELECT s.*, c.name AS customer_name FROM sales s LEFT JOIN customers c ON s.customer_id = c.id WHERE s.id = ?`).get(req.params.id);
  if (!head) return res.status(404).json({ error: '销售单不存在' });
  const items = db.prepare(`SELECT si.*, pr.name AS product_name, pr.sku, pr.unit FROM sale_items si LEFT JOIN products pr ON si.product_id = pr.id WHERE si.sale_id = ?`).all(req.params.id);
  const paid = r2(db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payment_allocations WHERE doc_type='sale' AND doc_id=?").get(head.id).s);
  res.json({ ...head, items, paid, outstanding: r2((Number(head.total_amount) || 0) - paid) });
});

// ---------- 单据备注修改 / 作废 ----------
// 备注只是文字，不影响任何金额与库存，所以允许「管理员 + 该单开单人」修改
function docTables(docType) {
  const isPur = docType === 'purchase';
  return {
    isPur, tbl: isPur ? 'purchases' : 'sales', itemTbl: isPur ? 'purchase_items' : 'sale_items',
    idCol: isPur ? 'purchase_id' : 'sale_id', partyCol: isPur ? 'supplier_id' : 'customer_id'
  };
}

app.put('/api/:kind(purchases|sales)/:id/note', requireAuth, (req, res) => {
  const docType = req.params.kind === 'purchases' ? 'purchase' : 'sale';
  const { tbl } = docTables(docType);
  const doc = db.prepare(`SELECT id, bill_no, note, operator FROM ${tbl} WHERE id=?`).get(req.params.id);
  if (!doc) return res.status(404).json({ error: '单据不存在' });
  if (!isAdminSession(req) && doc.operator && doc.operator !== req.session.username) {
    return res.status(403).json({ error: '只能修改自己开的单据备注' });
  }
  const note = String((req.body && req.body.note) || '').slice(0, 500);
  db.prepare(`UPDATE ${tbl} SET note=? WHERE id=?`).run(note, doc.id);
  res.json({ ok: true, note });
});

// 作废：与「退单」不是一回事。
//   退单 = 真的发生了退货，单据保留、留下原因与审批人，仍可查；
//   作废 = 这张单压根不该存在（选错商品/数量、重复提交），处理方式是彻底撤销：
//          回滚库存 → 撤销该单全部分摊（钱退回该单位的预付款/预收款）→ 删除明细与单据本身。
// 仅管理员可操作，且只能作废「生效中」的单据；历史上确实退掉的货请走退单流程。
function voidDoc(docType, docId, reason, operator) {
  const { isPur, tbl, itemTbl, idCol, partyCol } = docTables(docType);
  const doc = db.prepare(`SELECT * FROM ${tbl} WHERE id=?`).get(docId);
  if (!doc) return { error: '单据不存在' };
  if (doc.status === 'returned') return { error: `单据 ${doc.bill_no} 已退单，无需作废` };
  if (doc.status === 'pending_return') return { error: `单据 ${doc.bill_no} 有退单申请待审批，请先驳回或通过审批` };
  const items = db.prepare(`SELECT * FROM ${itemTbl} WHERE ${idCol}=?`).all(docId);
  const paid = paidOf(docType, docId) || 0;
  const allocs = db.prepare('SELECT payment_id, amount FROM payment_allocations WHERE doc_type=? AND doc_id=?').all(docType, docId);
  const tx = db.transaction(() => {
    const affectedProducts = new Set();
    // 采购作废：删除本采购单建立的所有批次（这些货本不该入库，连同未售出的余量一并移除）
    if (isPur) db.prepare('DELETE FROM inventory_lots WHERE purchase_id = ?').run(docId);
    for (const it of items) {
      const qty = parseInt(it.qty) || 0;
      const prod = db.prepare('SELECT id, name, stock FROM products WHERE id=?').get(it.product_id);
      if (!prod) continue;
      // 作废采购单 = 把进来的货退掉；作废销售单 = 把发出去的货收回
      const newStock = isPur ? prod.stock - qty : prod.stock + qty;
      if (newStock < 0) throw new Error(
        `商品「${prod.name}」库存不足（现有 ${prod.stock}，作废需扣 ${qty}）。` +
        `该商品可能已部分售出，无法直接作废此采购单，请先做已售出部分的销售退单使库存回到入库时的数量；` +
        `若实物已不在库且无需退回（例如货已损耗），请用「库存调整」把差额补齐后再作废。`);
      db.prepare(`UPDATE products SET stock = stock ${isPur ? '-' : '+'} ? WHERE id=?`).run(qty, it.product_id);
      db.prepare(`INSERT INTO stock_logs (product_id, change_qty, type, ref_id, balance, note, operator, created_at)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run(it.product_id, isPur ? -qty : qty, isPur ? 'purchase_void' : 'sale_void', docId, newStock, `作废 ${doc.bill_no}`, operator, nowLocal());
      affectedProducts.add(it.product_id);
      // 销售作废：商品回库，按本单实际单位成本建「退回批次」，使成本可追溯、加权均价不被低估
      if (!isPur) db.createLot({ product_id: it.product_id, source: 'sale_return', unit_cost: it.cost || 0, qty, batch_no: doc.bill_no, note: '销售作废回库' });
    }
    // 撤销分摊：这笔钱并不消失，会退回该单位的预付款/预收款余额
    db.prepare('DELETE FROM payment_allocations WHERE doc_type=? AND doc_id=?').run(docType, docId);
    // 退回的钱若该单位还有别的欠款，先冲抵（本单马上要删除，必须排除，否则钱又被挂回这张单）
    applyAdvanceToOpenDocs(docType, isPur ? 'supplier' : 'customer', doc[partyCol], { exclude: [docId] });
    // 这次交易被彻底撤销，它产生的改价留痕也应一并撤掉（否则改价报表里会留下「不存在的让价/加价」）
    db.prepare('DELETE FROM price_logs WHERE doc_type=? AND doc_id=?').run(docType, docId);
    // 作废后重算受影响商品的加权成本（采购作废已删该单批次；销售作废已建退回批次）
    for (const pid of affectedProducts) db.recomputeProductCost(pid);
    // 留痕：整单快照塞进 doc_voids。快照过大时只保留前 50 行明细，保证存的始终是合法 JSON
    let snapshot = JSON.stringify({ doc, items, allocations: allocs, paid: r2(paid) });
    if (snapshot.length > 20000) {
      snapshot = JSON.stringify({ doc, truncated: true, itemCount: items.length, items: items.slice(0, 50), allocations: allocs, paid: r2(paid) });
    }
    db.prepare(`INSERT INTO doc_voids (doc_type, doc_id, bill_no, party_id, total_amount, void_reason, snapshot, operator, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      docType, docId, doc.bill_no || '', doc[partyCol] || null, r2(doc.total_amount || 0),
      String(reason || '').slice(0, 200), snapshot, operator || '', nowLocal()
    );
    db.prepare(`DELETE FROM ${itemTbl} WHERE ${idCol}=?`).run(docId);
    db.prepare(`DELETE FROM ${tbl} WHERE id=?`).run(docId);
  });
  tx();
  return { ok: true, bill_no: doc.bill_no, released: r2(paid), items: items.length };
}

app.post('/api/:kind(purchases|sales)/:id/void', requireAdmin, (req, res) => {
  const docType = req.params.kind === 'purchases' ? 'purchase' : 'sale';
  try {
    const r = voidDoc(docType, parseInt(req.params.id, 10), (req.body && req.body.reason) || '', req.session.username);
    if (r.error) return res.status(400).json({ error: r.error });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- 退单处理 ----------
// 退单会做三件事：① 回滚库存（销售退单=商品回库，采购退单=商品出库退给供应商）；
// ② 释放该单已收/已付金额——删除其所有收付款分摊，使对应资金回到该往来单位的预付款/预收款余额（不丢钱）；
// ③ 标记单据为 returned，不再计入应收/应付与销售/采购统计。
// 出于审计考虑，单据与收付款记录均保留，仅状态变化。
function returnDoc(docType, docId, reason, operator) {
  const isPur = docType === 'purchase';
  const tbl = isPur ? 'purchases' : 'sales';
  const itemTbl = isPur ? 'purchase_items' : 'sale_items';
  const idCol = isPur ? 'purchase_id' : 'sale_id';
  const doc = db.prepare(`SELECT * FROM ${tbl} WHERE id = ?`).get(docId);
  if (!doc) return { error: '单据不存在' };
  if (doc.status === 'returned') return { error: '该单据已退单，不能重复退单' };
  const items = db.prepare(`SELECT * FROM ${itemTbl} WHERE ${idCol} = ?`).all(docId);
  const getProd = db.prepare('SELECT id, name, stock FROM products WHERE id = ?');
  const updStock = db.prepare(`UPDATE products SET stock = stock ${isPur ? '-' : '+'} ? WHERE id = ?`);
  const insLog = db.prepare('INSERT INTO stock_logs (product_id, change_qty, type, ref_id, balance, note, operator, created_at) VALUES (?,?,?,?,?,?,?,?)');
  let advanceResult = { applied: 0, details: [], remaining: 0 };
  const tx = db.transaction(() => {
    const affectedProducts = new Set();
    for (const it of items) {
      const prod = getProd.get(it.product_id);
      if (!prod) continue;
      const qty = parseInt(it.qty) || 0;
      const newStock = isPur ? prod.stock - qty : prod.stock + qty;
      if (newStock < 0) throw new Error(
        `商品「${prod.name}」库存不足（现有 ${prod.stock}，本次需退回 ${qty}）。` +
        `该商品可能已部分售出，无法全额退此采购单，请先对已售出的部分做销售退单，或先做库存调整把差额补足。`);
      updStock.run(qty, it.product_id);
      insLog.run(it.product_id, isPur ? -qty : qty, isPur ? 'purchase_return' : 'sale_return', docId, newStock, `退单 ${doc.bill_no}`, operator, nowLocal());
      affectedProducts.add(it.product_id);
      if (isPur) {
        // 采购退给供应商：货物出库，按 FIFO 从最老批次扣减（成本随之减少）
        db.fifoConsume(it.product_id, qty);
      } else {
        // 销售退回：商品回库，按本单实际单位成本建「退回批次」，成本可追溯
        db.createLot({ product_id: it.product_id, source: 'sale_return', unit_cost: it.cost || 0, qty, batch_no: doc.bill_no, note: '销售退单回库' });
      }
    }
    // 释放资金：删除该单全部分摊，已收/已付金额转为该单位的预付款/预收款余额
    db.prepare('DELETE FROM payment_allocations WHERE doc_type = ? AND doc_id = ?').run(docType, docId);
    db.prepare(`UPDATE ${tbl} SET status = 'returned', return_reason = ?, returned_at = ?, returned_by = ? WHERE id = ?`)
      .run(reason || '', nowLocal(), operator || '', docId);
    // 退回来的钱不能只是躺在预存里：该单位若还有别的欠款（另一张未结清单），
    // 先把欠款冲掉，剩下的才作为预存余额留待以后使用。
    // 否则会出现「一边挂着应收、一边躺着预收款」的两头账，客户以为已经付过，系统却还在催款。
    // 此时本单已置为 returned，不会把自己算进待抵单据里；exclude 只是双保险。
    const adv = applyAdvanceToOpenDocs(docType, isPur ? 'supplier' : 'customer', doc[isPur ? 'supplier_id' : 'customer_id'], { exclude: [docId] });
    advanceResult = adv;
    // 退单后这笔交易不再计入销售/采购，它产生的改价留痕也一并撤掉，避免改价报表统计到不存在的让价
    db.prepare("DELETE FROM price_logs WHERE doc_type = ? AND doc_id = ?").run(docType, docId);
    // 退单后重算受影响商品的加权成本（采购退单已 FIFO 扣减批次；销售退单已建退回批次）
    for (const pid of affectedProducts) db.recomputeProductCost(pid);
  });
  tx();
  return { ok: true, advance_applied: advanceResult.applied, advance_details: advanceResult.details, advance_remaining: advanceResult.remaining };
}
// 退单审批流：
// - 普通用户点退单：仅将单据置为 pending_return（锁定），不回滚库存/资金，等待管理员审批
// - 管理员点退单：直接执行退单（立即 returned）
// - 管理员对 pending_return 单据审批通过：执行 returnDoc；驳回：恢复 active
// 状态机：active → pending_return →(approve) returned / (reject) active

// 发起退单申请（普通用户锁定 / 管理员即时退单）
function returnRequestHandler(docType, docId, req, res) {
  const tbl = docType === 'purchase' ? 'purchases' : 'sales';
  if (!canUserReturn(req)) {
    return res.status(403).json({ error: '管理员已关闭普通用户的退单权限，如需退单请联系管理员处理' });
  }
  const doc = db.prepare(`SELECT * FROM ${tbl} WHERE id = ?`).get(docId);
  if (!doc) return res.status(404).json({ error: '单据不存在' });
  if (doc.status === 'returned') return res.status(400).json({ error: '该单据已退单，不能重复退单' });
  if (doc.status === 'pending_return') return res.status(400).json({ error: '该单据退单申请已提交，正在等待管理员审批' });
  const reason = (req.body && req.body.reason) || '';
  if (isAdminSession(req)) {
    // 管理员：直接完成退单
    try {
      const r = returnDoc(docType, docId, reason, req.session.username);
      if (r.error) return res.status(400).json({ error: r.error });
      db.prepare(`UPDATE ${tbl} SET return_approved_by = ?, return_approved_at = ? WHERE id = ?`)
        .run(req.session.username, nowLocal(), docId);
      res.json({ ok: true, executed: true, advance_applied: r.advance_applied || 0, advance_details: r.advance_details || [] });
    } catch (e) { res.status(400).json({ error: e.message }); }
  } else {
    // 普通用户：仅锁定（提交退单申请），不动库存与资金
    db.prepare(`UPDATE ${tbl} SET status = 'pending_return', return_reason = ?, return_requested_by = ?, return_requested_at = ? WHERE id = ?`)
      .run(reason, req.session.username, nowLocal(), docId);
    res.json({ ok: true, executed: false, pending: true });
  }
}

// 管理员审批通过：真正执行退单
function returnApproveHandler(docType, docId, req, res) {
  const tbl = docType === 'purchase' ? 'purchases' : 'sales';
  const doc = db.prepare(`SELECT * FROM ${tbl} WHERE id = ?`).get(docId);
  if (!doc) return res.status(404).json({ error: '单据不存在' });
  if (doc.status !== 'pending_return') return res.status(400).json({ error: '该单据未处于退单待审状态' });
  try {
    const r = returnDoc(docType, docId, doc.return_reason || '', req.session.username);
    if (r.error) return res.status(400).json({ error: r.error });
    db.prepare(`UPDATE ${tbl} SET return_approved_by = ?, return_approved_at = ? WHERE id = ?`)
      .run(req.session.username, nowLocal(), docId);
    res.json({ ok: true, advance_applied: r.advance_applied || 0, advance_details: r.advance_details || [] });
  } catch (e) { res.status(400).json({ error: e.message }); }
}

// 管理员驳回：恢复 active
function returnRejectHandler(docType, docId, req, res) {
  const tbl = docType === 'purchase' ? 'purchases' : 'sales';
  const doc = db.prepare(`SELECT * FROM ${tbl} WHERE id = ?`).get(docId);
  if (!doc) return res.status(404).json({ error: '单据不存在' });
  if (doc.status !== 'pending_return') return res.status(400).json({ error: '该单据未处于退单待审状态' });
  const reason = (req.body && req.body.reason) || '';
  db.prepare(`UPDATE ${tbl}
    SET status = 'active', return_reason = '', return_requested_by = '', return_requested_at = '',
        return_rejected_by = ?, return_rejected_at = ?, return_rejected_reason = ? WHERE id = ?`)
    .run(req.session.username, nowLocal(), reason, docId);
  res.json({ ok: true });
}

app.post('/api/purchases/:id/return', requireAuth, (req, res) => returnRequestHandler('purchase', parseInt(req.params.id), req, res));
app.post('/api/sales/:id/return', requireAuth, (req, res) => returnRequestHandler('sale', parseInt(req.params.id), req, res));
app.post('/api/purchases/:id/return/approve', requireAdmin, (req, res) => returnApproveHandler('purchase', parseInt(req.params.id), req, res));
app.post('/api/purchases/:id/return/reject', requireAdmin, (req, res) => returnRejectHandler('purchase', parseInt(req.params.id), req, res));
app.post('/api/sales/:id/return/approve', requireAdmin, (req, res) => returnApproveHandler('sale', parseInt(req.params.id), req, res));
app.post('/api/sales/:id/return/reject', requireAdmin, (req, res) => returnRejectHandler('sale', parseInt(req.params.id), req, res));

// ---------- 库存 ----------
// 库存条件查询：页面与导出共用同一套解析，避免「看到的」和「导出的」不是同一批货。
// 参数：sku / name（模糊）、category（精确）、max_min（下限严格小于 N）、
//       status=low|normal|all，另兼容老的 low=1。
function inventoryQuery(q) {
  q = q || {};
  const w = [], args = [];
  const sku = String(q.sku || '').trim();
  const name = String(q.name || '').trim();
  const cat = String(q.category || '').trim();
  if (sku) { w.push('sku LIKE ?'); args.push(`%${sku}%`); }
  if (name) { w.push('name LIKE ?'); args.push(`%${name}%`); }
  if (cat) { w.push('category = ?'); args.push(cat); }
  // 「下限小于多少」按严格小于理解：填 10 表示下限低于 10 的商品
  const maxMin = String(q.max_min == null ? '' : q.max_min).trim();
  if (maxMin !== '') {
    const v = Number(maxMin);
    if (Number.isFinite(v)) { w.push('min_stock < ?'); args.push(v); }
  }
  let status = String(q.status || '').toLowerCase();
  if (q.low === '1' || q.low === 'true') status = 'low';
  if (status === 'low') w.push('stock <= min_stock');
  else if (status === 'normal') w.push('stock > min_stock');
  const where = w.length ? ` WHERE ${w.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM products${where} ORDER BY stock <= min_stock, stock ASC, id DESC`).all(...args);
}

// 把筛选条件翻译成中文，写进导出文件的标题行
function inventoryFilterText(q) {
  q = q || {};
  const bits = [];
  if (String(q.sku || '').trim()) bits.push(`编码含「${String(q.sku).trim()}」`);
  if (String(q.name || '').trim()) bits.push(`名称含「${String(q.name).trim()}」`);
  if (String(q.category || '').trim()) bits.push(`分类「${String(q.category).trim()}」`);
  if (String(q.max_min == null ? '' : q.max_min).trim() !== '') bits.push(`下限小于 ${String(q.max_min).trim()}`);
  let status = String(q.status || '').toLowerCase();
  if (q.low === '1' || q.low === 'true') status = 'low';
  if (status === 'low') bits.push('仅库存预警');
  else if (status === 'normal') bits.push('仅库存正常');
  return bits.join('　');
}

app.get('/api/inventory', requireAuth, (req, res) => {
  res.json(inventoryQuery(req.query));
});

app.get('/api/inventory/alerts', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM products WHERE stock <= min_stock ORDER BY stock ASC').all();
  res.json(rows);
});

// 库存导出：mode=stock 是「盘点表」（刻意不含价格，可以放心发给仓库手填）；
// mode=full 是完整库存清单（含成本金额，给老板/会计看）。两者与页面共用 inventoryQuery。
app.get('/api/inventory/export', requireAuth, (req, res) => {
  const mode = String(req.query.mode || 'full').toLowerCase() === 'stock' ? 'stock' : 'full';
  const rows = inventoryQuery(req.query);
  if (!rows.length) return res.status(400).json({ error: '当前筛选条件下没有商品，无法导出' });

  const isStock = mode === 'stock';
  const head = isStock
    ? ['SKU', '商品名称', '分类', '单位', '账面库存', '实盘数量', '差异', '备注']
    : ['SKU', '商品名称', '分类', '单位', '库存', '下限', '进货价', '销售价', '库存成本金额', '库存售价金额', '状态', '备注'];
  const body = rows.map((p) => {
    const stock = Number(p.stock) || 0;
    const cost = Number(p.purchase_price) || 0;
    if (isStock) {
      // 后三列留空，打印出来手写；不要预填 0，否则会被当成「已盘且无差异」
      return [p.sku || '', p.name || '', p.category || '', p.unit || '', stock, '', '', ''];
    }
    return [
      p.sku || '', p.name || '', p.category || '', p.unit || '',
      stock, Number(p.min_stock) || 0,
      r2(cost), r2(p.sale_price), r2(stock * cost), r2(stock * (Number(p.sale_price) || 0)),
      stock <= (Number(p.min_stock) || 0) ? '预警' : '正常',
      p.note || ''
    ];
  });

  const sumQty = rows.reduce((s, p) => s + (Number(p.stock) || 0), 0);
  const sumCost = rows.reduce((s, p) => s + (Number(p.stock) || 0) * (Number(p.purchase_price) || 0), 0);
  const tail = isStock
    ? [['合计', `${rows.length} 种商品`, '', '', sumQty, '', '', '']]
    : [['合计', `${rows.length} 种商品`, '', '', sumQty, '', '', '', r2(sumCost), r2(rows.reduce((s, p) => s + (Number(p.stock) || 0) * (Number(p.sale_price) || 0), 0)), '', '']];

  const title = isStock ? '库存盘点表' : '库存清单';
  const ftxt = inventoryFilterText(req.query);
  const sheets = [{
    name: title,
    rows: [
      [`${title}${ftxt ? `（${ftxt}）` : ''}`],
      [`导出时间：${nowLocal()}　｜　共 ${rows.length} 种商品${isStock ? '　｜　请按实际盘点数填写「实盘数量」，差异 = 实盘 − 账面' : `　｜　成本金额合计 ${r2(sumCost)}`}`],
      [],
      head,
      ...body,
      [],
      ...tail
    ]
  }];

  let buf;
  try { buf = buildWorkbook(sheets); }
  catch (e) { return res.status(500).json({ error: '生成 Excel 失败：' + e.message }); }
  const stamp = db.prepare("SELECT strftime('%Y%m%d','now','localtime') AS d").get().d;
  const fname = `${title}${ftxt ? '_筛选' : ''}_${stamp}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="inventory_${mode}_${stamp}.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
});

// 待办汇总：退单待审 + 金额调整待审 + 库存告警，供仪表盘顶部提醒
app.get('/api/todo-summary', requireAuth, (req, res) => {
  const returns = db.prepare(`
    SELECT * FROM (
      SELECT 'purchase' AS doc_type, p.id, p.bill_no, p.total_amount,
        COALESCE(p.return_reason,'') AS reason,
        COALESCE(p.return_requested_by,'') AS requested_by,
        COALESCE(NULLIF(p.return_requested_at,''), p.created_at) AS requested_at,
        (SELECT name FROM suppliers WHERE id = p.supplier_id) AS party
      FROM purchases p WHERE p.status = 'pending_return'
      UNION ALL
      SELECT 'sale', s.id, s.bill_no, s.total_amount,
        COALESCE(s.return_reason,''),
        COALESCE(s.return_requested_by,''),
        COALESCE(NULLIF(s.return_requested_at,''), s.created_at),
        (SELECT name FROM customers WHERE id = s.customer_id)
      FROM sales s WHERE s.status = 'pending_return'
    ) ORDER BY requested_at ASC`).all().map(r => ({ ...r, total_amount: r2(r.total_amount) }));
  const adj = db.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(new_amount - old_amount),0) AS diff FROM payment_adjustments WHERE status='pending'").get();
  const low = db.prepare('SELECT COUNT(*) AS c FROM products WHERE stock <= min_stock').get().c;
  res.json({
    returns,
    returnCount: returns.length,
    adjustCount: adj.c,
    adjustDiff: r2(adj.diff),
    lowStockCount: low,
    total: returns.length + adj.c + low
  });
});

// 库存预警导出：只导出前端勾选的商品（ids 为空时拒绝，避免误把全部导出去）
app.post('/api/inventory/alerts/export', requireAuth, (req, res) => {
  const raw = (req.body || {}).ids;
  const ids = [...new Set((Array.isArray(raw) ? raw : [])
    .map((v) => parseInt(v))
    .filter((n) => Number.isInteger(n) && n > 0))].slice(0, 500);
  if (!ids.length) return res.status(400).json({ error: '请先勾选要导出的商品' });

  const rows = db.prepare(
    `SELECT * FROM products WHERE id IN (${ids.map(() => '?').join(',')})
     ORDER BY (stock - min_stock) ASC, id ASC`
  ).all(...ids);
  if (!rows.length) return res.status(404).json({ error: '所选商品已不存在，请刷新后重试' });

  const sheets = [{
    name: '库存预警',
    rows: [
      ['商品名称', 'SKU', '分类', '单位', '当前库存', '库存下限', '缺口数量', '进货价', '售价', '库存金额', '备注'],
      ...rows.map((p) => {
        const stock = Number(p.stock) || 0;
        const min = Number(p.min_stock) || 0;
        const cost = Number(p.purchase_price) || 0;
        return [
          p.name || '', p.sku || '', p.category || '', p.unit || '',
          stock, min, Math.max(0, min - stock),
          r2(cost), r2(p.sale_price), r2(stock * cost),
          p.note || ''
        ];
      })
    ]
  }];

  let buf;
  try {
    buf = buildWorkbook(sheets);
  } catch (e) {
    return res.status(500).json({ error: '生成 Excel 失败：' + e.message });
  }
  const stamp = db.prepare("SELECT strftime('%Y%m%d','now','localtime') AS d").get().d;
  const fname = `库存预警_${stamp}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="low_stock_${stamp}.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
});

// 盘点 / 调整库存（delta 可正可负）
app.post('/api/inventory/adjust', requireAuth, (req, res) => {
  const { product_id, delta, reason } = req.body || {};
  const pid = parseInt(product_id);
  // 调整量必须是「非零整数」：原来用 parseInt('5abc') 会得到 5，字符串尾巴被悄悄吃掉，
  // 而 9e15 这种值又会把库存一次顶到浮点上限，之后任何库存报表都失去意义
  const d = Number(delta);
  if (!pid || !Number.isFinite(d) || !Number.isInteger(d) || d === 0) {
    return res.status(400).json({ error: '请填写正确的调整数量（非零整数）' });
  }
  if (Math.abs(d) > MAX_QTY) return res.status(400).json({ error: `单次调整数量不能超过 ${MAX_QTY}` });
  const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(pid);
  if (!prod) return res.status(404).json({ error: '商品不存在' });
  const newStock = prod.stock + d;
  if (newStock < 0) return res.status(400).json({ error: '调整后库存不能为负' });
  if (newStock > MAX_QTY) return res.status(400).json({ error: `调整后库存不能超过 ${MAX_QTY}` });
  const tx = db.transaction(() => {
    if (d > 0) {
      // 盘盈：按当前剩余批次的加权平均单价建一个调整批次（无批次则单价记 0）
      const cur = db.prepare('SELECT COALESCE(SUM(remaining_qty*unit_cost),0)/COALESCE(SUM(remaining_qty),1) AS a, COALESCE(SUM(remaining_qty),0) AS q FROM inventory_lots WHERE product_id=?').get(pid);
      const unit = cur.q > 0 ? r2(cur.a) : 0;
      db.createLot({ product_id: pid, source: 'adjust', unit_cost: unit, qty: d, batch_no: 'ADJ', note: reason || '库存调整(盘盈)' });
    } else if (d < 0) {
      // 盘亏：按 FIFO 从最老批次扣减（成本随之减少）；批次不足说明数据漂移，fifoConsume 会抛错并整体回滚
      db.fifoConsume(pid, -d);
    }
    db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(newStock, pid);
    db.prepare('INSERT INTO stock_logs (product_id, change_qty, type, ref_id, balance, note, operator, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(pid, d, 'adjust', null, newStock, reason || '库存调整', req.session.username, nowLocal());
    db.recomputeProductCost(pid);
  });
  tx();
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(pid));
});

// 库存流水
app.get('/api/stock-logs', requireAuth, (req, res) => {
  const { product_id } = req.query;
  let sql = `SELECT l.*, p.name AS product_name, p.sku FROM stock_logs l LEFT JOIN products p ON l.product_id = p.id WHERE 1=1`;
  const params = [];
  if (product_id) { sql += ' AND l.product_id = ?'; params.push(product_id); }
  sql += ' ORDER BY l.id DESC LIMIT 500';
  res.json(db.prepare(sql).all(...params));
});

// ---------- 收付款记账（新版：一付多票 / 一票多付 / 预付款 / 显式定金） ----------

// 取某单据已分摊（已付/已收）金额
function paidOf(docType, docId) {
  const t = docType === 'purchase' ? 'purchases' : 'sales';
  if (!db.prepare(`SELECT id FROM ${t} WHERE id = ?`).get(docId)) return null;
  return r2(db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM payment_allocations WHERE doc_type=? AND doc_id=?').get(docType, docId).s);
}

// 往来单位名称（单行用）
function partyName(partyType, partyId) {
  if (partyType === 'supplier') { const r = db.prepare('SELECT name FROM suppliers WHERE id=?').get(partyId); return r ? r.name : ''; }
  if (partyType === 'customer') { const r = db.prepare('SELECT name FROM customers WHERE id=?').get(partyId); return r ? r.name : ''; }
  return '';
}

// 批量版：列表里每行调一次 partyName 就是 N+1（几百行就几百次同一个「按 id 查名字」）。
// 往来单位通常只有几十个，一次全读进 Map 远比反复查划算。
function partyNameMap() {
  const map = new Map();
  for (const s of db.prepare('SELECT id, name FROM suppliers').all()) map.set('supplier:' + s.id, s.name);
  for (const c of db.prepare('SELECT id, name FROM customers').all()) map.set('customer:' + c.id, c.name);
  return map;
}
function partyNameOf(map, partyType, partyId) {
  if (partyType !== 'supplier' && partyType !== 'customer') return '';
  return map.get(partyType + ':' + partyId) || '';
}

// 批量取「若干笔收付款各自分摊到了哪些单据上」。
// 原来是每笔 payment 单独查一次分摊，一页 50 笔就是 50 次查询（N+1）：
// 每多一笔都会多一次 SQL 往返，翻到几百笔时列表会明显变慢。
// 这里改成一次性 IN 查出来再按 payment_id 分组，无论多少笔都只查常数次。
// SQLite 的变量个数有上限（老版本是 999），所以按块拆，别一股脑塞进去。
const ALLOC_CHUNK_SIZE = 400;                 // 单次 IN 查询的变量个数（远低于 SQLite 上限，留足余量）
function allocMapForPayIds(payIds) {
  const out = new Map();
  const ids = (payIds || []).filter(id => Number.isFinite(Number(id)));
  if (!ids.length) return out;
  for (let i = 0; i < ids.length; i += ALLOC_CHUNK_SIZE) {
    const block = ids.slice(i, i + ALLOC_CHUNK_SIZE);
    const rows = db.prepare(`SELECT a.payment_id, a.doc_type, a.doc_id, a.amount,
        CASE WHEN a.doc_type='purchase' THEN (SELECT bill_no FROM purchases WHERE id=a.doc_id)
             ELSE (SELECT bill_no FROM sales WHERE id=a.doc_id) END AS doc_no
      FROM payment_allocations a WHERE a.payment_id IN (${block.map(() => '?').join(',')})
      ORDER BY a.payment_id, a.id`).all(...block);
    for (const a of rows) {
      const { payment_id, ...rest } = a;
      if (!out.has(payment_id)) out.set(payment_id, []);
      out.get(payment_id).push(rest);
    }
  }
  return out;
}

// 取某客户当前应收（未结清欠款）：销售总额 - 已收（含定金与预收款分摊）
function customerReceivable(customerId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(s.total_amount - (SELECT COALESCE(SUM(amount),0) FROM payment_allocations WHERE doc_type='sale' AND doc_id=s.id)),0) AS receivable
    FROM sales s WHERE s.customer_id = ? AND (s.status IS NULL OR s.status != 'returned')`).get(customerId);
  return r2(row.receivable);
}

// 某往来单位尚未被任何单据用掉的预存余额（供应商=预付款，客户=预收款）
// 这笔钱是「已经付/收过的钱」，只是还没对应到单据上，所以它可以用来抵扣新开的单据
//
// 分成两个函数，是因为「账面余额」和「可用额度」不是一回事：
//   advanceRawOf     → 真实余额，可能是负数（已分摊出去的钱多于实际收付的钱）
//   advanceBalanceOf → 可用于抵扣的额度，负数一律按 0 处理
// 如果直接把负数当可用额度参与抵扣，等于凭空造出一笔钱去冲抵单据；
// 但如果把它抹成 0 之后就再也不看，真实存在的资金缺口就彻底查不出来了。
// 所以负余额要走 advanceRawOf 暴露到体检与财务页，而不是 silently 消失。
function advanceRawOf(partyType, partyId) {
  if (!partyId) return 0;
  const dir = partyType === 'supplier' ? 'pay' : 'receive';
  const rows = db.prepare(`SELECT p.amount, COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE payment_id=p.id),0) AS alloc
    FROM payments p WHERE p.party_type=? AND p.party_id=? AND p.direction=? AND p.amount > 0`).all(partyType, partyId, dir);
  let bal = 0;
  for (const a of rows) bal = r2(bal + (a.amount - a.alloc));
  return r2(bal);
}
function advanceBalanceOf(partyType, partyId) {
  const bal = advanceRawOf(partyType, partyId);
  return bal > 0.001 ? bal : 0;
}

// 把某单位「已经收到/付过、但还没挂到任何单据上」的预存余额，按单据时间先后冲抵该单位的未结清单据。
// 两个必须调用的场景：
//   ① 退单：退款释回预存后，若该单位还有别的欠款，先把欠款冲掉，剩下的才留在预存里；
//   ② 新记收付款：录入前先消费既有预存，避免「一边挂着欠款、一边躺着预存」的两头账。
// 只新增分摊记录、不改任何金额，因此该单位的总应收/应付与预存合计都不变，只是把钱指到具体单据上。
// 调用方必须自己开事务（returnDoc / POST /api/payments / 启动修复都已有事务）。
function applyAdvanceToOpenDocs(docType, partyType, partyId, opts) {
  const options = opts || {};
  const exclude = new Set((options.exclude || []).map(Number));
  const maxApply = options.limit == null ? Infinity : r2(options.limit);
  const out = { applied: 0, details: [], remaining: 0 };
  if (!partyId || !(maxApply > 0.001)) return out;

  const dir = docType === 'purchase' ? 'pay' : 'receive';
  const tbl = docType === 'purchase' ? 'purchases' : 'sales';
  const partyCol = docType === 'purchase' ? 'supplier_id' : 'customer_id';

  // 可用预存：按收款/付款记录先后（先收的钱先抵）
  const advances = db.prepare(`SELECT p.id, p.amount,
      COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE payment_id=p.id),0) AS alloc
    FROM payments p WHERE p.party_type=? AND p.party_id=? AND p.direction=? AND p.amount > 0 ORDER BY p.id ASC`)
    .all(partyType, partyId, dir);
  const usable = [];
  let money = 0;
  for (const a of advances) {
    const bal = r2(a.amount - a.alloc);
    if (bal > 0.001) { usable.push({ id: a.id, bal }); money = r2(money + bal); }
  }
  if (money <= 0.001) return out;
  money = Math.min(money, maxApply);

  // 未结清单据：只认生效中的单（退单待审/已退单都锁定，不参与抵扣），按单据先后
  const docs = db.prepare(`
    SELECT d.id, d.bill_no,
      (d.total_amount - COALESCE((SELECT SUM(amount) FROM payment_allocations
        WHERE doc_type=? AND doc_id=d.id),0)) AS outstanding
    FROM ${tbl} d
    WHERE d.${partyCol}=? AND (d.status IS NULL OR d.status='active')
    ORDER BY d.id ASC`).all(docType, partyId);
  const insAlloc = db.prepare("INSERT INTO payment_allocations (payment_id, doc_type, doc_id, amount, source) VALUES (?,?,?,?,'advance')");
  for (const d of docs) {
    if (money <= 0.001) break;
    if (exclude.has(Number(d.id))) continue;
    const owe = r2(d.outstanding);
    if (!(owe > 0.001)) continue;                    // 已结清或历史超付，跳过
    const use = r2(Math.min(money, owe));
    if (use <= 0.001) continue;
    let left = use;
    for (const u of usable) {
      if (left <= 0.001) break;
      if (u.bal <= 0.001) continue;
      const put = r2(Math.min(u.bal, left));
      insAlloc.run(u.id, docType, d.id, put);
      u.bal = r2(u.bal - put);
      left = r2(left - put);
    }
    money = r2(money - use);
    out.applied = r2(out.applied + use);
    out.details.push({ doc_type: docType, doc_id: d.id, bill_no: d.bill_no || '', amount: use });
  }
  out.remaining = money > 0.001 ? money : 0;
  return out;
}

// 批量版（列表页避免 N+1 查询）
function advanceMapOf(partyType) {
  const dir = partyType === 'supplier' ? 'pay' : 'receive';
  const rows = db.prepare(`SELECT p.party_id AS pid,
      p.amount - COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE payment_id=p.id),0) AS bal
    FROM payments p WHERE p.party_type=? AND p.party_id IS NOT NULL AND p.direction=? AND p.amount > 0`)
    .all(partyType, dir);
  const m = new Map();
  for (const r of rows) {
    const b = r2(r.bal);
    if (b > 0.001) m.set(r.pid, r2((m.get(r.pid) || 0) + b));
  }
  return m;
}

// 建单时把「约定定金」自动记为收付款（分摊到该单），从而计入已付、从应付/应收中扣除
function createDepositPayment(docType, docId, deposit, partyType, partyId, operator) {
  // 兜底再校验一次：定金必须是有限的正数，任何入口都不许把 Infinity 写进金额列
  const amt = moneyNonNeg(deposit);
  if (amt === null || amt <= 0) return;
  const direction = docType === 'purchase' ? 'pay' : 'receive';
  const info = db.prepare('INSERT INTO payments (direction, party_type, party_id, amount, method, note, operator, is_deposit, created_at) VALUES (?,?,?,?,?,?,?,1,?)')
    .run(direction, partyType || null, partyId || null, amt, 'other', '订单定金', operator, nowLocal());
  db.prepare("INSERT INTO payment_allocations (payment_id, doc_type, doc_id, amount, source) VALUES (?,?,?,?,'cash')").run(info.lastInsertRowid, docType, docId, amt);
}

// 新建单据后，自动用该单位既有预存（预付款/预收款）余额抵扣本单，返回实际抵扣金额
function autoApplyAdvance(docType, docId, partyType, partyId) {
  if (!partyId) return 0;
  const wantDir = docType === 'purchase' ? 'pay' : 'receive';
  const advances = db.prepare(`SELECT p.id, p.amount, COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE payment_id=p.id),0) AS alloc
    FROM payments p WHERE p.party_type=? AND p.party_id=? AND p.direction=? AND p.amount > 0 ORDER BY p.id ASC`)
    .all(partyType, partyId, wantDir);
  let avail = 0; const usable = [];
  for (const a of advances) { const bal = r2(a.amount - a.alloc); if (bal > 0.001) { avail = r2(avail + bal); usable.push({ id: a.id, bal }); } }
  if (avail <= 0.001) return 0;
  const total = docType === 'purchase'
    ? db.prepare('SELECT total_amount FROM purchases WHERE id=?').get(docId).total_amount
    : db.prepare('SELECT total_amount FROM sales WHERE id=?').get(docId).total_amount;
  const already = paidOf(docType, docId);
  const remain = r2(total - already);
  if (!(remain > 0.001)) return 0;                 // 防御：单据已结清则不再抵减
  const applyAmt = Math.min(avail, remain);
  if (applyAmt <= 0.001) return 0;
  let r = applyAmt;
  const insAlloc = db.prepare("INSERT INTO payment_allocations (payment_id, doc_type, doc_id, amount, source) VALUES (?,?,?,?,'advance')");
  for (const u of usable) {
    if (r <= 0.001) break;
    const use = Math.min(u.bal, r);
    insAlloc.run(u.id, docType, docId, r2(use));
    r = r2(r - use);
  }
  return r2(applyAmt);
}

// 记一笔收付款（可分摊到多张单据；未分摊部分自动成为该单位的预付款/预收款）
app.post('/api/payments', requireAuth, (req, res) => {
  const body = req.body || {};
  const { direction, party_type, party_id, amount, method, note, allocations } = body;
  if (direction !== 'pay' && direction !== 'receive') return res.status(400).json({ error: '收付方向错误' });
  // 金额必须是「有限的正数」：1e999 会被解析成 Infinity，普通 >0 校验拦不住它
  const amt = money(amount);
  if (amt === null || amt <= 0) return res.status(400).json({ error: `金额必须大于 0 且不超过 ${MAX_MONEY}` });
  // 往来单位类型由收付方向唯一决定（付款→供应商，收款→客户）。
  // 这里必须按方向去对应的表校验 party_id：否则传「收款 + party_type=供应商 + 某个供应商 id」时，
  // 校验会在 suppliers 表通过，而写库时按方向归一成 customer，把供应商的 id 当成客户 id 记到别人头上。
  const ptByDir = direction === 'pay' ? 'supplier' : 'customer';
  if (party_type && party_type !== ptByDir) {
    return res.status(400).json({ error: direction === 'pay' ? '付款的往来单位只能是供应商' : '收款的往来单位只能是客户' });
  }
  const partyId = party_id ? parseInt(party_id) : null;
  if (partyId) {
    const t = ptByDir === 'supplier' ? 'suppliers' : 'customers';
    if (!db.prepare(`SELECT id FROM ${t} WHERE id=?`).get(partyId)) return res.status(400).json({ error: '往来单位不存在' });
  }
  // 解析分摊：同一单据可能被拆成多行传入（重复行），必须先按单据合并累加，
  // 否则每行单独校验都能通过，累加后就会把单据「付超/收超」
  const allocs = Array.isArray(allocations) ? allocations : [];
  if (allocs.length > 200) return res.status(400).json({ error: '单次最多关联 200 张单据' });
  // 钱的流向必须与单据类型一致：付给供应商的钱只能抵采购单，收客户的钱只能抵销售单。
  // 少了这条校验，「一笔 500 元收款」可以被摊到采购单上：采购应付凭空少 500，
  // 同时这笔钱又被算进某个客户的预收款余额——两边同时虚增，谁也对不上账。
  const expectDocType = direction === 'pay' ? 'purchase' : 'sale';
  const merged = new Map();
  for (const a of allocs) {
    if (!a) continue;
    const aAmt = money(a.amount);
    if (aAmt === null || aAmt <= 0) continue;
    if (a.doc_type !== expectDocType) {
      return res.status(400).json({
        error: direction === 'pay'
          ? '付款只能分摊到采购单，不能分摊到销售单'
          : '收款只能分摊到销售单，不能分摊到采购单'
      });
    }
    const dt = expectDocType;
    const did = parseInt(a.doc_id);
    if (!did) return res.status(400).json({ error: '分摊单据无效' });
    const key = `${dt}:${did}`;
    merged.set(key, r2((merged.get(key) || 0) + aAmt));
  }
  let sumAlloc = 0;
  const validated = [];
  for (const [key, aamt] of merged) {
    const [dt, idStr] = key.split(':');
    const did = parseInt(idStr);
    const doc = dt === 'purchase' ? db.prepare('SELECT * FROM purchases WHERE id=?').get(did)
                                  : db.prepare('SELECT * FROM sales WHERE id=?').get(did);
    if (!doc) return res.status(400).json({ error: `关联单据不存在（${dt} #${did}）` });
    // 已退单 / 退单待审的单据处于锁定状态，禁止再收款/付款（避免审批前资金被改动）
    if (doc.status === 'returned') return res.status(400).json({ error: `单据 ${doc.bill_no} 已退单，不能${dt === 'purchase' ? '付款' : '收款'}` });
    if (doc.status === 'pending_return') return res.status(400).json({ error: `单据 ${doc.bill_no} 退单待审中，已锁定，不能${dt === 'purchase' ? '付款' : '收款'}` });
    const ownerId = dt === 'purchase' ? doc.supplier_id : doc.customer_id;
    if (partyId && ownerId && ownerId !== partyId) return res.status(400).json({ error: '分摊单据与往来单位不匹配' });
    const already = paidOf(dt, did);
    const remain = r2(doc.total_amount - already);
    if (remain <= 0.001) return res.status(400).json({ error: `单据 ${doc.bill_no} 已结清，不能再分摊` });
    if (aamt > remain + 0.001) return res.status(400).json({ error: `单据 ${doc.bill_no} 分摊金额超过未付/未收余额（剩余 ${remain}）` });
    sumAlloc = r2(sumAlloc + aamt);
    validated.push({ doc_type: dt, doc_id: did, amount: aamt });
  }
  if (sumAlloc > amt + 0.001) return res.status(400).json({ error: '分摊合计不能超过本次收付款金额' });

  // 兜底：若未传往来单位但已分摊单据，则从分摊单据反推归属
  // （否则预付款会因缺 party_id 而在下次交易时无法被自动抵扣）
  let finalPartyType = party_type || null;
  let finalPartyId = partyId;
  if (!finalPartyId && validated.length) {
    const owners = new Set();
    for (const v of validated) {
      const o = v.doc_type === 'purchase'
        ? (db.prepare('SELECT supplier_id AS o FROM purchases WHERE id=?').get(v.doc_id) || {}).o
        : (db.prepare('SELECT customer_id AS o FROM sales WHERE id=?').get(v.doc_id) || {}).o;
      if (o) owners.add((v.doc_type === 'purchase' ? 'supplier' : 'customer') + ':' + o);
    }
    if (owners.size === 1) {
      const pair = [...owners][0].split(':');
      finalPartyType = pair[0]; finalPartyId = parseInt(pair[1]);
    }
  }

  const tx = db.transaction(() => {
    const dt = direction === 'pay' ? 'purchase' : 'sale';
    // 往来单位类型一律由收付方向决定，避免前端传错 party_type 时把供应商的预付款抵到客户单据上
    const pt = direction === 'pay' ? 'supplier' : 'customer';
    // 第 0 步：先把该单位「已经收过/付过、还躺在预存里」的钱花掉，按单据先后冲抵未结清单据。
    // 少了这一步就会出现两头账：客户预收款挂着一笔，另一张单却还欠着，本次又重复收一遍现金。
    // 退单释回的钱也走这里（退单时已先冲过一次，这里兜底处理后续又产生的新欠款）。
    const advUsed = finalPartyId ? applyAdvanceToOpenDocs(dt, pt, finalPartyId, {}) : { applied: 0, details: [], remaining: 0 };
    const info = db.prepare('INSERT INTO payments (direction, party_type, party_id, amount, method, note, operator, is_deposit, created_at) VALUES (?,?,?,?,?,?,?,0,?)')
      .run(direction, finalPartyId ? pt : (finalPartyType || null), finalPartyId, amt, method || 'cash', note || '', req.session.username, nowLocal());
    const pid = info.lastInsertRowid;
    const insAlloc = db.prepare("INSERT INTO payment_allocations (payment_id, doc_type, doc_id, amount, source) VALUES (?,?,?,?,'cash')");
    // 第 1 步：本次显式指定的分摊。预存可能刚已抵掉一部分，所以按「此刻真实未结额」再裁一次；
    // 超出部分不硬塞进单据（会付超/收超），退回第 2 步继续分摊或转预存。
    let sumAllocActual = 0, clamped = 0;
    for (const v of validated) {
      const row = v.doc_type === 'purchase'
        ? db.prepare('SELECT total_amount FROM purchases WHERE id=?').get(v.doc_id)
        : db.prepare('SELECT total_amount FROM sales WHERE id=?').get(v.doc_id);
      const left = Math.max(0, r2((row ? row.total_amount : 0) - paidOf(v.doc_type, v.doc_id)));
      const use = r2(Math.min(v.amount, left));
      if (use > 0.001) { insAlloc.run(pid, v.doc_type, v.doc_id, use); sumAllocActual = r2(sumAllocActual + use); }
      if (use < v.amount - 0.001) clamped = r2(clamped + (v.amount - use));
    }
    // 第 2 步：金额超出已选分摊部分：自动抵扣该单位其他未结清单据；仍有剩余则转预存（预付款/预收款）
    let remain = r2(amt - sumAllocActual);
    const auto = [];
    if (remain > 0.001 && finalPartyId) {
      const partyCol = direction === 'pay' ? 'supplier_id' : 'customer_id';
      const tbl = direction === 'pay' ? 'purchases' : 'sales';
      const exclude = validated.map(v => v.doc_id);
      const docs = db.prepare(`
        SELECT d.id, d.bill_no, d.total_amount,
          (d.total_amount - COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE doc_type='${dt}' AND doc_id=d.id),0)) AS outstanding
        FROM ${tbl} d
        WHERE d.${partyCol}=? AND (d.status IS NULL OR d.status='active')
          AND (d.total_amount - COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE doc_type='${dt}' AND doc_id=d.id),0)) > 0.001
        ${exclude.length ? `AND d.id NOT IN (${exclude.map(() => '?').join(',')})` : ''}
        ORDER BY d.id ASC`).all(finalPartyId, ...exclude);
      for (const d of docs) {
        if (remain <= 0.001) break;
        const out = r2(d.outstanding);
        if (!(out > 0.001)) continue;               // 防御：已结清/超额单据不再分摊
        const use = r2(Math.min(remain, out));
        if (use <= 0.001) continue;
        insAlloc.run(pid, dt, d.id, use);
        auto.push({ doc_type: dt, doc_id: d.id, bill_no: d.bill_no, amount: use });
        remain = r2(remain - use);
      }
    }
    return { pid, auto, restAsAdvance: remain, advUsed: advUsed.applied, advDetails: advUsed.details, clamped };
  });
  try {
    const r = tx();
    const pay = db.prepare('SELECT * FROM payments WHERE id=?').get(r.pid);
    res.json({
      ...pay, auto_allocated: r.auto, rest_as_advance: r.restAsAdvance,
      advance_used: r.advUsed, advance_used_details: r.advDetails, clamped: r.clamped
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 未关联往来单位的收付款（多为无单据的纯预付款，无法自动抵扣，需要人工指定归属）
app.get('/api/payments/orphans', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT p.id, p.direction, p.party_type, p.amount, p.method, p.note, p.created_at,
      COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE payment_id=p.id),0) AS alloc
    FROM payments p WHERE p.party_id IS NULL ORDER BY p.id DESC`).all()
    .map(p => ({ id: p.id, direction: p.direction, party_type: p.party_type, amount: r2(p.amount), method: p.method,
      note: p.note, created_at: p.created_at, alloc: r2(p.alloc), balance: r2(p.amount - p.alloc) }));
  // 只返回仍有未分摊余额（真正需要归属的预存），已全额分摊的无需处理
  res.json(rows.filter(r => r.balance > 0.001));
});

// 为某笔收付款指定往来单位（付款→供应商，收款→客户）
// 仅管理员：把一笔钱从甲单位改判到乙单位，等于在两个往来账之间凭空搬钱，必须有管理员权限
app.post('/api/payments/:id/assign-party', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const p = db.prepare('SELECT * FROM payments WHERE id=?').get(id);
  if (!p) return res.status(404).json({ error: '收付款记录不存在' });
  const pt = (req.body && req.body.party_type) === 'customer' ? 'customer' : 'supplier';
  const pid = parseInt(req.body && req.body.party_id);
  if (!pid) return res.status(400).json({ error: '请选择往来单位' });
  if (p.direction === 'pay' && pt !== 'supplier') return res.status(400).json({ error: '付款只能关联供应商' });
  if (p.direction === 'receive' && pt !== 'customer') return res.status(400).json({ error: '收款只能关联客户' });
  const tbl = pt === 'supplier' ? 'suppliers' : 'customers';
  if (!db.prepare(`SELECT id FROM ${tbl} WHERE id=?`).get(pid)) return res.status(400).json({ error: '往来单位不存在' });
  // 关键校验：这笔钱如果已经分摊到单据上，那些单据必须都属于新选的单位。
  // 否则「客户 A 的收款」被改成客户 B 之后，钱在 A 的账上消失、在 B 的账上凭空出现，
  // 而分摊仍挂在 A 的单据上——两边账同时对不上，且删记录时会把 A 的单据打回未结。
  const allocs = db.prepare('SELECT doc_type, doc_id FROM payment_allocations WHERE payment_id=?').all(id);
  if (allocs.length) {
    // 已分摊的单据类型必须与收付方向一致（付→采购单 / 收→销售单）。
    // 只比对 party_id 是不够的：供应商 #3 和客户 #3 的 id 恰好相同时，
    // 「供应商的钱」会被合法地改判给「客户」，钱在两边账上同时出现/消失。
    const expectDt = p.direction === 'pay' ? 'purchase' : 'sale';
    const aliens = [];
    for (const a of allocs) {
      const owner = a.doc_type === 'purchase'
        ? db.prepare('SELECT supplier_id AS o, bill_no FROM purchases WHERE id=?').get(a.doc_id)
        : db.prepare('SELECT customer_id AS o, bill_no FROM sales WHERE id=?').get(a.doc_id);
      if (!owner || owner.o !== pid || a.doc_type !== expectDt) aliens.push(owner ? (owner.bill_no || `#${a.doc_id}`) : `#${a.doc_id}`);
    }
    if (aliens.length) {
      const shown = aliens.slice(0, 3).join('、') + (aliens.length > 3 ? ` 等 ${aliens.length} 张` : '');
      return res.status(400).json({
        error: `这笔${p.direction === 'pay' ? '付款' : '收款'}已分摊到 ${shown}，这些单据不属于所选单位，不能直接改归属。请先删除该笔记录后重新录入正确的单位。`
      });
    }
  }
  db.transaction(() => {
    db.prepare('UPDATE payments SET party_type=?, party_id=? WHERE id=?').run(pt, pid, id);
    // 改归属后，这笔钱对该单位就是「已经收过/付过的预存」：若该单位还有未结清单据，
    // 必须立刻按先后顺序冲抵，否则又会造出「一边挂着欠款、一边躺着预存」的两头账。
    applyAdvanceToOpenDocs(p.direction === 'pay' ? 'purchase' : 'sale', pt, pid, {});
  })();
  res.json({ ok: true });
});

// ---------- 收付款金额调整（普通用户提交 → 管理员审批后生效） ----------
function allocSumOfPayment(paymentId) {
  return r2(db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM payment_allocations WHERE payment_id=?').get(paymentId).s);
}

// 真正应用金额调整：改 payments.amount；若新金额小于已分摊合计，从最新的分摊往前截断，
// 被截掉的部分不再算作已付/已收（相当于这笔钱本就没收到），对应单据重新变为未结清。
function applyPaymentAmount(paymentId, newAmount) {
  const p = db.prepare('SELECT * FROM payments WHERE id=?').get(paymentId);
  if (!p) return { error: '收付款记录不存在' };
  const amt = r2(newAmount);
  if (!(amt > 0)) return { error: '新金额必须大于 0' };
  let trimmed = 0;
  const tx = db.transaction(() => {
    db.prepare('UPDATE payments SET amount=? WHERE id=?').run(amt, paymentId);
    const allocated = allocSumOfPayment(paymentId);
    if (allocated > amt + 0.001) {
      let excess = r2(allocated - amt);
      const rows = db.prepare('SELECT id, amount FROM payment_allocations WHERE payment_id=? ORDER BY id DESC').all(paymentId);
      for (const r of rows) {
        if (excess <= 0.001) break;
        const a = r2(r.amount);
        if (a <= excess + 0.001) {
          db.prepare('DELETE FROM payment_allocations WHERE id=?').run(r.id);
          excess = r2(excess - a);
          trimmed = r2(trimmed + a);
        } else {
          db.prepare('UPDATE payment_allocations SET amount=? WHERE id=?').run(r2(a - excess), r.id);
          trimmed = r2(trimmed + excess);
          excess = 0;
        }
      }
    }
    // 调高金额后多出来的钱同样不能干躺在预存里：该单位若还有其它未结清单据，先按先后顺序冲抵
    if (r2(amt - allocSumOfPayment(paymentId)) > 0.001 && p.party_id) {
      applyAdvanceToOpenDocs(p.direction === 'pay' ? 'purchase' : 'sale',
        p.direction === 'pay' ? 'supplier' : 'customer', p.party_id, {});
    }
  });
  tx();
  return { ok: true, old_amount: r2(p.amount), amount: amt, trimmed, as_advance: r2(amt - allocSumOfPayment(paymentId)) };
}

// 申请调整金额：管理员直接生效；普通用户生成待审申请，等管理员审批
// 退单待审 / 已退单的单据处于锁定状态：审批通过要把分摊释放回预存，驳回要原样恢复。
// 若锁定期内把分摊到它身上的这笔钱「调小」甚至「删掉」，退单流程就再也还原不回去，
// 钱在系统里彻底消失，且调金额的入口自己又没有任何提示，属于最难追查的一类账目错误。
function lockedDocsOfPayment(paymentId) {
  const allocs = db.prepare('SELECT doc_type, doc_id FROM payment_allocations WHERE payment_id=?').all(paymentId);
  const hit = [];
  for (const a of allocs) {
    const d = a.doc_type === 'purchase'
      ? db.prepare('SELECT bill_no, status FROM purchases WHERE id=?').get(a.doc_id)
      : db.prepare('SELECT bill_no, status FROM sales WHERE id=?').get(a.doc_id);
    if (d && (d.status === 'pending_return' || d.status === 'returned')) {
      hit.push({ bill_no: d.bill_no || `#${a.doc_id}`, status: d.status });
    }
  }
  return hit;
}
function lockedDocsError(locked, action) {
  const names = locked.slice(0, 3).map(x => x.bill_no).join('、') + (locked.length > 3 ? ` 等 ${locked.length} 张` : '');
  const label = locked[0].status === 'pending_return' ? '退单待审中（已锁定）' : '已退单';
  return `这笔收付款已分摊到${label}的单据 ${names}，单据锁定中，不能${action}。请先完成退单审批再处理资金。`;
}

app.post('/api/payments/:id/adjust', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  if (!canUserAdjustAmount(req)) {
    return res.status(403).json({ error: '管理员已关闭普通用户的金额调整权限，如需修改请联系管理员处理' });
  }
  const p = db.prepare('SELECT * FROM payments WHERE id=?').get(id);
  if (!p) return res.status(404).json({ error: '收付款记录不存在' });
  if (p.is_deposit) return res.status(400).json({ error: '定金记录由订单约定自动生成，如需修改请调整单据定金' });
  const lockedDocs = lockedDocsOfPayment(id);
  if (lockedDocs.length) return res.status(400).json({ error: lockedDocsError(lockedDocs, '调整金额') });
  const body = req.body || {};
  // 新金额必须是「有限的正数」：1e999（Infinity）能绕过 >0 校验，写库后无法再被正常读取与导出
  const amt = money(body.amount);
  if (amt === null || amt <= 0) return res.status(400).json({ error: `新金额必须大于 0 且不超过 ${MAX_MONEY}` });
  if (Math.abs(amt - r2(p.amount)) < 0.005) return res.status(400).json({ error: '新金额与当前金额相同，无需调整' });
  const reason = String(body.reason || '').slice(0, 200);
  const dup = db.prepare("SELECT id FROM payment_adjustments WHERE payment_id=? AND status='pending'").get(id);
  if (dup) return res.status(400).json({ error: '该笔收付款已有待审的金额调整申请，请等待管理员处理' });

  const operator = req.session.username;
  if (isAdminSession(req)) {
    const r = applyPaymentAmount(id, amt);
    if (r.error) return res.status(400).json({ error: r.error });
    db.prepare(`INSERT INTO payment_adjustments (payment_id, old_amount, new_amount, reason, status, requested_by, requested_at, approved_by, approved_at)
      VALUES (?,?,?,?,'approved',?,?,?,?)`).run(id, r.old_amount, r.amount, reason, operator, nowLocal(), operator, nowLocal());
    return res.json({ ok: true, executed: true, ...r });
  }
  db.prepare(`INSERT INTO payment_adjustments (payment_id, old_amount, new_amount, reason, status, requested_by, requested_at)
    VALUES (?,?,?,?,'pending',?,?)`).run(id, r2(p.amount), amt, reason, operator, nowLocal());
  res.json({ ok: true, executed: false, pending: true });
});

// 金额调整申请列表（管理员看全部待审；普通用户只看自己的申请）
app.get('/api/payments/adjustments', requireAuth, (req, res) => {
  const admin = isAdminSession(req);
  const status = String(req.query.status || '').trim();
  const conds = [], args = [];
  if (status === 'pending' || status === 'approved' || status === 'rejected') { conds.push('a.status=?'); args.push(status); }
  if (!admin) { conds.push('a.requested_by=?'); args.push(req.session.username); }
  const sql = `SELECT a.*, p.direction, p.party_type, p.party_id, p.amount AS current_amount, p.note AS pay_note,
      p.created_at AS pay_at, p.is_deposit,
      COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE payment_id=p.id),0) AS alloc
    FROM payment_adjustments a JOIN payments p ON p.id=a.payment_id
    ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
    ORDER BY a.id DESC LIMIT 200`;
  const rows = db.prepare(sql).all(...args).map(a => ({
    ...a,
    party_name: partyName(a.party_type, a.party_id),
    old_amount: r2(a.old_amount), new_amount: r2(a.new_amount),
    current_amount: r2(a.current_amount), alloc: r2(a.alloc)
  }));
  res.json(rows);
});

app.post('/api/payments/adjustments/:id/approve', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const a = db.prepare("SELECT * FROM payment_adjustments WHERE id=? AND status='pending'").get(id);
  if (!a) return res.status(404).json({ error: '待审申请不存在或已处理' });
  const r = applyPaymentAmount(a.payment_id, a.new_amount);
  if (r.error) return res.status(400).json({ error: r.error });
  db.prepare("UPDATE payment_adjustments SET status='approved', approved_by=?, approved_at=? WHERE id=?")
    .run(req.session.username, nowLocal(), id);
  res.json({ ok: true, ...r });
});

app.post('/api/payments/adjustments/:id/reject', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const a = db.prepare("SELECT * FROM payment_adjustments WHERE id=? AND status='pending'").get(id);
  if (!a) return res.status(404).json({ error: '待审申请不存在或已处理' });
  const reason = String((req.body || {}).reason || '').slice(0, 200);
  db.prepare("UPDATE payment_adjustments SET status='rejected', approved_by=?, approved_at=?, reject_reason=? WHERE id=?")
    .run(req.session.username, nowLocal(), reason, id);
  res.json({ ok: true });
});

// 用预付款/预收款抵扣某单据（消费既有 advance 余额）
app.post('/api/payments/apply-advance', requireAuth, (req, res) => {
  const { doc_type, doc_id, amount } = req.body || {};
  const dt = doc_type === 'purchase' ? 'purchase' : 'sale';
  const did = parseInt(doc_id);
  const amt = money(amount);
  if (amt === null || amt <= 0) return res.status(400).json({ error: `金额必须大于 0 且不超过 ${MAX_MONEY}` });
  const doc = dt === 'purchase' ? db.prepare('SELECT * FROM purchases WHERE id=?').get(did) : db.prepare('SELECT * FROM sales WHERE id=?').get(did);
  if (!doc) return res.status(404).json({ error: '单据不存在' });
  if (doc.status === 'returned') return res.status(400).json({ error: '该单据已退单，不能再抵扣预付款/预收款' });
  if (doc.status === 'pending_return') return res.status(400).json({ error: '该单据退单待审中，已锁定，不能抵扣预付款/预收款' });
  const partyType = dt === 'purchase' ? 'supplier' : 'customer';
  const partyId = dt === 'purchase' ? doc.supplier_id : doc.customer_id;
  if (!partyId) return res.status(400).json({ error: '该单据未关联往来单位，无法抵扣预付款' });
  // 关键校验：抵扣额不能超过该单据的未付/未收金额，否则会把单据「付超」导致应付/应收变成负数
  const docTotal = r2(doc.total_amount);
  const docOutstanding = r2(docTotal - paidOf(dt, did));
  if (docOutstanding <= 0.001) {
    return res.status(400).json({ error: `该单据已结清（总额 ${docTotal}，已${dt === 'purchase' ? '付' : '收'} ${r2(docTotal - docOutstanding)}），无需再抵扣` });
  }
  const wantDir = dt === 'purchase' ? 'pay' : 'receive';
  const advances = db.prepare(`SELECT p.id, p.amount, COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE payment_id=p.id),0) AS alloc
    FROM payments p WHERE p.party_type=? AND p.party_id=? AND p.direction=? AND p.amount > 0 ORDER BY p.id ASC`)
    .all(partyType, partyId, wantDir);
  let avail = 0; const usable = [];
  for (const a of advances) { const bal = r2(a.amount - a.alloc); if (bal > 0.001) { avail = r2(avail + bal); usable.push({ id: a.id, bal }); } }
  // 实际抵扣额 = min(申请额, 可用预存, 单据未结)，超出部分不退不回，直接按上限抵扣
  const applyAmt = r2(Math.min(amt, avail, docOutstanding));
  if (applyAmt <= 0.001) return res.status(400).json({ error: `可用${dt === 'purchase' ? '预付款' : '预收款'}不足（剩余 ${avail}）` });
  const tx = db.transaction(() => {
    let remain = applyAmt;
    const insAlloc = db.prepare("INSERT INTO payment_allocations (payment_id, doc_type, doc_id, amount, source) VALUES (?,?,?,?,'advance')");
    for (const u of usable) {
      if (remain <= 0.001) break;
      const use = Math.min(u.bal, remain);
      insAlloc.run(u.id, dt, did, r2(use));
      remain = r2(remain - use);
    }
  });
  try {
    tx();
    res.json({ ok: true, applied: applyAmt, requested: amt, capped: applyAmt < amt - 0.001, doc_outstanding: docOutstanding });
  }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// 手动触发：把该单位的预存余额按单据先后冲抵未结清单据（不新增任何收付款记录）
app.post('/api/advance/apply', requireAuth, (req, res) => {
  const body = req.body || {};
  const pt = body.party_type === 'supplier' ? 'supplier' : 'customer';
  const pid = parseInt(body.party_id);
  if (!pid) return res.status(400).json({ error: '请选择往来单位' });
  const dt = pt === 'supplier' ? 'purchase' : 'sale';
  const tx = db.transaction(() => applyAdvanceToOpenDocs(dt, pt, pid, {}));
  try {
    const r = tx();
    res.json({ ok: true, applied: r.applied, details: r.details, remaining: r.remaining });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 查询某往来单位的可用预存（预付款/预收款）余额
app.get('/api/advance-balance', requireAuth, (req, res) => {
  const { party_type, party_id } = req.query;
  const pid = parseInt(party_id);
  const pt = party_type === 'supplier' ? 'supplier' : 'customer';
  if (!pid) return res.json({ balance: 0 });
  const wantDir = pt === 'supplier' ? 'pay' : 'receive';
  const advances = db.prepare(`SELECT p.amount, COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE payment_id=p.id),0) AS alloc
    FROM payments p WHERE p.party_type=? AND p.party_id=? AND p.direction=? AND p.amount > 0`).all(pt, pid, wantDir);
  let bal = 0;
  for (const a of advances) bal = r2(bal + (a.amount - a.alloc));
  res.json({ balance: bal > 0 ? bal : 0 });
});

// 某往来单位的收付流水账（收付款明细 + 预付款/预收款余额 + 当前应付/应收）
// 收付款流水账（单个往来单位）。页面与导出共用，避免两套口径。
function partyLedgerPayData(party_type, party_id) {
  const pid = parseInt(party_id);
  const pt = party_type === 'supplier' ? 'supplier' : 'customer';
  if (!pid) return { err: 400, msg: '缺少往来单位' };
  const wantDir = pt === 'supplier' ? 'pay' : 'receive';
  const tbl = pt === 'supplier' ? 'purchases' : 'sales';
  const partyCol = pt === 'supplier' ? 'supplier_id' : 'customer_id';
  const docType = pt === 'supplier' ? 'purchase' : 'sale';

  // 当前应付/应收（未结清合计）
  // 注意：子查询必须用别名限定列，否则 doc_id=id 会被 SQLite 解析成 payment_allocations.id（内层列）
  // 只排除「已退单」：退单待审的单据资金与库存都还没动，仍是真实的应付/应收义务
  const docs = db.prepare(`SELECT d.id, d.total_amount,
      (d.total_amount - COALESCE((SELECT SUM(a.amount) FROM payment_allocations a WHERE a.doc_type=? AND a.doc_id=d.id),0)) AS outstanding
    FROM ${tbl} d WHERE d.${partyCol}=? AND (d.status IS NULL OR d.status != 'returned')`).all(docType, pid);
  let payable = 0;
  for (const d of docs) { const o = r2(d.outstanding); if (o > 0.001) payable = r2(payable + o); }

  // 预付款/预收款余额
  const advRows = db.prepare(`SELECT p.amount, COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE payment_id=p.id),0) AS alloc
    FROM payments p WHERE p.party_type=? AND p.party_id=? AND p.direction=? AND p.amount>0`).all(pt, pid, wantDir);
  let advance = 0;
  for (const a of advRows) advance = r2(advance + (a.amount - a.alloc));
  if (advance < 0) advance = 0;

  // 收付款流水（含分摊单据）
  const rows = db.prepare(`SELECT * FROM payments WHERE party_type=? AND party_id=? ORDER BY id DESC`).all(pt, pid);
  const allocStmt = db.prepare(`SELECT a.doc_type, a.doc_id, a.amount,
      CASE WHEN a.doc_type='purchase' THEN (SELECT bill_no FROM purchases WHERE id=a.doc_id) ELSE (SELECT bill_no FROM sales WHERE id=a.doc_id) END AS doc_no
    FROM payment_allocations a WHERE a.payment_id=?`);
  const transactions = rows.map(p => {
    const al = allocStmt.all(p.id);
    return { ...p, allocations: al, alloc_total: r2(al.reduce((s, x) => s + x.amount, 0)) };
  });

  // 汇总：累计收/付、已分摊、转预存
  let totalIn = 0, totalOut = 0, allocated = 0, toAdvance = 0;
  for (const t of transactions) {
    if (t.direction === 'receive') totalIn = r2(totalIn + t.amount); else totalOut = r2(totalOut + t.amount);
    allocated = r2(allocated + t.alloc_total);
    const rest = r2(t.amount - t.alloc_total);
    if (rest > 0.001) toAdvance = r2(toAdvance + rest);
  }

  return {
    party: { id: pid, name: partyName(pt, pid), type: pt },
    payable: r2(payable),
    advance_balance: r2(advance),
    direction: wantDir,
    summary: { total_in: totalIn, total_out: totalOut, allocated, to_advance: toAdvance },
    transactions
  };
}

app.get('/api/party-ledger', requireAuth, (req, res) => {
  const { party_type, party_id } = req.query;
  const d = partyLedgerPayData(party_type, party_id);
  if (d.err) return res.status(d.err).json({ error: d.msg });
  res.json(d);
});

// 收付流水账导出：每笔钱冲了哪张单、还剩多少转预存，一次说清，便于对账
app.get('/api/party-ledger/export', requireAuth, (req, res) => {
  const { party_type, party_id } = req.query;
  const d = partyLedgerPayData(party_type, party_id);
  if (d.err) return res.status(d.err).json({ error: d.msg });
  if (!d.transactions.length) return res.status(400).json({ error: '该单位还没有收付款记录，无法导出' });

  const isSup = d.party.type === 'supplier';
  const METHODS = { cash: '现金', bank: '银行转账', alipay: '支付宝', wechat: '微信', other: '其他' };
  const body = d.transactions.map((t) => {
    const alloc = (t.allocations || []).length
      ? t.allocations.map(a => `${a.doc_no || (a.doc_type + a.doc_id)} ${r2(a.amount)}`).join('、')
      : '预付款/预收款（未分摊）';
    const rest = r2(t.amount - t.alloc_total);
    return [
      t.created_at || '',
      t.is_deposit ? '定金' : (t.direction === 'pay' ? '付款' : '收款'),
      r2(t.amount),
      alloc,
      rest > 0.001 ? r2(rest) : 0,
      METHODS[t.method] || t.method || '',
      t.note || '',
      t.operator || ''
    ];
  });

  const sum = d.direction === 'pay'
    ? [['合计', '', r2(d.summary.total_out), `已分摊 ${d.summary.allocated}`, r2(d.summary.to_advance), '', `当前应付未结清 ${d.payable}；预存余额 ${d.advance_balance}`, '']]
    : [['合计', '', r2(d.summary.total_in), `已分摊 ${d.summary.allocated}`, r2(d.summary.to_advance), '', `当前应收未收 ${d.payable}；预存余额 ${d.advance_balance}`, '']];

  const sheets = [{
    name: '收付流水账',
    rows: [
      [`${d.party.name} · ${isSup ? '采购付款' : '销售收款'}流水账`],
      [`共 ${d.transactions.length} 笔　｜　${isSup ? '累计付款' : '累计收款'} ${d.direction === 'pay' ? d.summary.total_out : d.summary.total_in}　｜　导出时间：${nowLocal()}`],
      [],
      ['时间', '类型', '金额', '分摊单据', '本笔转预存', '方式', '备注', '操作人'],
      ...body,
      [],
      ...sum
    ]
  }];

  let buf;
  try { buf = buildWorkbook(sheets); }
  catch (e) { return res.status(500).json({ error: '生成 Excel 失败：' + e.message }); }
  const stamp = db.prepare("SELECT strftime('%Y%m%d','now','localtime') AS d").get().d;
  const fname = `${d.party.name}_收付流水账_${stamp}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="pay_ledger_${stamp}.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
});

app.get('/api/payments', requireAuth, (req, res) => {
  const { direction, method, from, to, keyword } = req.query;
  let where = ' WHERE 1=1';
  const params = [];
  if (direction) { where += ' AND p.direction = ?'; params.push(direction); }
  if (method) { where += ' AND p.method = ?'; params.push(method); }
  if (from) { where += ' AND date(p.created_at) >= date(?)'; params.push(from); }
  if (to) { where += ' AND date(p.created_at) <= date(?)'; params.push(to); }
  if (keyword) {
    const k = `%${keyword}%`;
    where += ` AND (p.note LIKE ? OR EXISTS(SELECT 1 FROM payment_allocations a JOIN purchases d ON a.doc_id=d.id AND a.doc_type='purchase' WHERE a.payment_id=p.id AND d.bill_no LIKE ?) OR EXISTS(SELECT 1 FROM payment_allocations a JOIN sales d ON a.doc_id=d.id AND a.doc_type='sale' WHERE a.payment_id=p.id AND d.bill_no LIKE ?))`;
    params.push(k, k, k);
  }
  // 分页：带 page 参数时返回 { total, items, has_more }（供「加载更多/翻页」），
  // 不带 page 时保持原来的数组返回（兼容老调用），条数上限从 500 放宽到 2000
  const page = parseInt(req.query.page, 10);
  const pageSize = Math.min(2000, Math.max(1, parseInt(req.query.page_size, 10) || 50));
  let total = null;
  let rows;
  if (page > 0) {
    total = db.prepare(`SELECT COUNT(*) AS c FROM payments p${where}`).get(...params).c;
    rows = db.prepare(`SELECT p.* FROM payments p${where} ORDER BY p.id DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize);
  } else {
    const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit, 10) || 500));
    rows = db.prepare(`SELECT p.* FROM payments p${where} ORDER BY p.id DESC LIMIT ?`).all(...params, limit);
  }
  const allocMap = allocMapForPayIds(rows.map(p => p.id));
  const nameMap = partyNameMap();
  const items = rows.map(p => ({ ...p, party_name: partyNameOf(nameMap, p.party_type, p.party_id), allocations: allocMap.get(p.id) || [] }));
  if (page > 0) return res.json({ total, page, page_size: pageSize, has_more: page * pageSize < total, items });
  res.json(items);
});

// 删除一笔收付款记录（仅管理员）
// 场景：金额/方向录错、重复录入。删除时会一并撤销它的分摊，相关单据的未结金额自动复原。
app.delete('/api/payments/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = db.prepare('SELECT * FROM payments WHERE id=?').get(id);
  if (!p) return res.status(404).json({ error: '收付款记录不存在' });
  const pend = db.prepare("SELECT COUNT(*) AS c FROM payment_adjustments WHERE payment_id=? AND status='pending'").get(id).c;
  if (pend > 0) return res.status(400).json({ error: '该笔记录还有待审批的金额调整申请，请先审批或驳回后再删除' });
  const lockedDocs = lockedDocsOfPayment(id);
  if (lockedDocs.length) return res.status(400).json({ error: lockedDocsError(lockedDocs, '删除') });
  const allocs = db.prepare('SELECT doc_type, doc_id, amount FROM payment_allocations WHERE payment_id=?').all(id);
  // 删除前必须先存档。这是唯一一个「动钱却无审计」的入口：
  // payment_adjustments 的外键是 ON DELETE CASCADE，删掉这条 payment 会把它全部的调账审批历史
  // （谁申请改成多少、谁批的、什么时候批的）一并删光。级联删完就再也查不到了，
  // 所以要在事务里、删除之前把三样东西整体序列化：记录本体 + 分摊去向 + 审批历史。
  const adjHistory = db.prepare('SELECT * FROM payment_adjustments WHERE payment_id=?').all(id);
  const reason = String((req.body && req.body.reason) || '').trim().slice(0, 200);
  const docOf = (a) => (a.doc_type === 'purchase'
    ? db.prepare('SELECT bill_no FROM purchases WHERE id=?').get(a.doc_id)
    : db.prepare('SELECT bill_no FROM sales WHERE id=?').get(a.doc_id));
  let snapshot = '';
  try {
    snapshot = JSON.stringify({
      payment: { ...p, amount: r2(p.amount) },
      allocations: allocs.map(a => ({ ...a, amount: r2(a.amount), bill_no: (docOf(a) || {}).bill_no || '' })),
      adjustments: adjHistory.map(h => ({ ...h, old_amount: r2(h.old_amount), new_amount: r2(h.new_amount) }))
    });
  } catch (e) { snapshot = ''; }
  try {
    db.transaction(() => {
      db.prepare(`INSERT INTO payment_deletions
        (payment_id, direction, party_type, party_id, party_name, amount, method, note, source_operator, pay_created_at, delete_reason, snapshot, deleted_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          id, p.direction, p.party_type, p.party_id, partyName(p.party_type, p.party_id), r2(p.amount),
          p.method || '', p.note || '', p.operator || '', p.created_at || '', reason, snapshot, req.session.username || ''
        );
      db.prepare('DELETE FROM payment_allocations WHERE payment_id=?').run(id);
      db.prepare('DELETE FROM payments WHERE id=?').run(id);   // 金额调整申请由外键级联删除（已先存档）
    })();
  } catch (e) { return res.status(400).json({ error: '删除失败：' + e.message }); }
  res.json({
    ok: true, amount: r2(p.amount), direction: p.direction,
    released: allocs.map(a => ({ ...a, amount: r2(a.amount) })),
    archived: true, audit_adjustments: adjHistory.length
  });
});

// 已删除收付款的留痕台账（仅管理员）：动了钱就要能查到，删了也得查得到
app.get('/api/payment-deletions', requireAdmin, (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const rows = db.prepare('SELECT * FROM payment_deletions ORDER BY id DESC LIMIT ?').all(limit)
    .map(r => {
      let snap = null;
      try { snap = r.snapshot ? JSON.parse(r.snapshot) : null; } catch (e) { snap = null; }
      return {
        id: r.id, payment_id: r.payment_id, direction: r.direction,
        party_name: r.party_name || '（未指定单位）', amount: r2(r.amount),
        source_operator: r.source_operator, pay_created_at: r.pay_created_at,
        delete_reason: r.delete_reason, deleted_by: r.deleted_by, deleted_at: r.created_at,
        // 被释放的分摊（这些单据已被打回欠款）与随之消失的审批历史，都从快照还原
        released: (snap && snap.allocations) ? snap.allocations : [],
        adj_history_count: (snap && snap.adjustments) ? snap.adjustments.length : 0,
        adj_history: (snap && snap.adjustments) ? snap.adjustments : []
      };
    });
  res.json({ total: db.prepare('SELECT COUNT(*) AS c FROM payment_deletions').get().c, list: rows });
});

// 库存商品金额统计：成本口径（采购价）、售价口径（货值），以及按分类汇总
function inventoryValue() {
  const t = db.prepare(`SELECT COALESCE(SUM(stock),0) AS qty,
      COALESCE(SUM(stock * purchase_price),0) AS cost_value,
      COALESCE(SUM(stock * sale_price),0) AS retail_value,
      COUNT(*) AS sku_count
    FROM products`).get();
  const byCategory = db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(category),''),'未分类') AS category,
      COALESCE(SUM(stock),0) AS qty,
      COALESCE(SUM(stock * purchase_price),0) AS cost_value,
      COALESCE(SUM(stock * sale_price),0) AS retail_value
    FROM products
    GROUP BY COALESCE(NULLIF(TRIM(category),''),'未分类')
    ORDER BY cost_value DESC`).all()
    .map(c => ({ category: c.category, qty: c.qty, costValue: r2(c.cost_value), retailValue: r2(c.retail_value) }));
  return {
    qty: t.qty,
    skuCount: t.sku_count,
    costValue: r2(t.cost_value),
    retailValue: r2(t.retail_value),
    grossMargin: r2(t.retail_value - t.cost_value),
    byCategory
  };
}

// 财务汇总的计算体：抽成独立函数，供 /api/finance/summary（页面渲染）
// 与 /api/finance/export（按同一套筛选条件导出 Excel）共用。
// 为什么不各写一套：筛选条件（p_/s_ 前缀 × 单位/商品/日期/退单/状态）解析起来有十几行，
// 复制一份日后必然出现「页面显示的」和「导出的」不是同一批数据，而这种差异极难被发现。
function financeSummaryData(q, req) {
  // 筛选参数（明细列表用；汇总卡片始终按全量统计）
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const monthStart = `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const monthEnd = `${y}-${String(m + 1).padStart(2, '0')}-${String(new Date(y, m + 1, 0).getDate()).padStart(2, '0')}`;
  // 采购(p_*)与销售(s_*)各自独立一套筛选参数，互不挂钩；
  // 退单筛选 p_return/s_return = all(全部) | normal(正常/未退单) | returned(已退单) | pending(退单待审)
  // 付款状态筛选 p_status/s_status = all(全部) | unpaid(未付款) | partial(部分付款) | settled(已结清)
  const retOf = (v) => (v === 'normal' || v === 'returned' || v === 'pending') ? v : 'all';
  const statusOf = (v) => (v === 'unpaid' || v === 'partial' || v === 'settled') ? v : 'all';
  const mkFilter = (pre, partyKey) => ({
    partyId: q[pre + partyKey] ? parseInt(q[pre + partyKey]) : null,
    product: (q[pre + 'product'] || '').trim(),
    from: (q[pre + 'from'] || monthStart).slice(0, 10),
    to: (q[pre + 'to'] || monthEnd).slice(0, 10),
    ret: retOf(q[pre + 'return']),
    status: statusOf(q[pre + 'status'])
  });
  const pFilter = mkFilter('p_', 'supplier');
  const sFilter = mkFilter('s_', 'customer');

  // 每张单据额外带回「交易数量」：总件数、明细项数、可读明细（含各自单位）、单品时的单位
  const qtyCols = (tbl, fk) => `
      (SELECT COALESCE(SUM(i.qty),0) FROM ${tbl} i WHERE i.${fk}=%A.id) AS qty_total,
      (SELECT COUNT(*) FROM ${tbl} i WHERE i.${fk}=%A.id) AS item_count,
      (SELECT GROUP_CONCAT(pr.name || ' × ' || i.qty || COALESCE(pr.unit,''), '、')
         FROM ${tbl} i JOIN products pr ON i.product_id=pr.id WHERE i.${fk}=%A.id) AS qty_detail,
      (SELECT pr.unit FROM ${tbl} i JOIN products pr ON i.product_id=pr.id WHERE i.${fk}=%A.id LIMIT 1) AS qty_unit,
      (SELECT COALESCE(SUM(a.amount),0) FROM payment_allocations a
         WHERE a.doc_type='%DT' AND a.doc_id=%A.id AND a.source='advance') AS paid_advance`;
  const purchases = db.prepare(`SELECT p.id, p.bill_no, p.total_amount, p.deposit, p.supplier_id AS party_id, s.name AS partner, p.status, p.return_reason, p.returned_at, p.return_approved_by, p.created_at,
      (SELECT GROUP_CONCAT(pr.name, '、') FROM purchase_items pi JOIN products pr ON pi.product_id=pr.id WHERE pi.purchase_id=p.id) AS products,${qtyCols('purchase_items', 'purchase_id').replace(/%A/g, 'p').replace(/%DT/g, 'purchase')}
    FROM purchases p LEFT JOIN suppliers s ON p.supplier_id=s.id ORDER BY p.created_at DESC, p.id DESC`).all();
  const sales = db.prepare(`SELECT s.id, s.bill_no, s.total_amount, s.deposit, s.customer_id AS party_id, c.name AS partner, s.status, s.return_reason, s.returned_at, s.return_approved_by, s.created_at,
      (SELECT GROUP_CONCAT(pr.name, '、') FROM sale_items si JOIN products pr ON si.product_id=pr.id WHERE si.sale_id=s.id) AS products,${qtyCols('sale_items', 'sale_id').replace(/%A/g, 's').replace(/%DT/g, 'sale')}
    FROM sales s LEFT JOIN customers c ON s.customer_id=c.id ORDER BY s.created_at DESC, s.id DESC`).all();
  const paidStmt = db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM payment_allocations WHERE doc_type=? AND doc_id=?`);

  const matchFilter = (r, f) => {
    if (f.partyId && r.party_id !== f.partyId) return false;
    if (f.product && !(r.products || '').includes(f.product)) return false;
    const d = (r.created_at || '').slice(0, 10);
    if (f.from && d && d < f.from) return false;
    if (f.to && d && d > f.to) return false;
    // 退单状态筛选
    if (f.ret === 'normal' && r.docStatus !== 'active') return false;
    if (f.ret === 'returned' && r.docStatus !== 'returned') return false;
    if (f.ret === 'pending' && r.docStatus !== 'pending_return') return false;
    // 付款状态筛选（未付款 / 部分付款 / 已结清）
    // 普通单用 r.status（settled/partial/unpaid）；退单待审单用 r.payStatus（审批驳回会恢复原状，债权仍按真实收付归类）
    if (f.status && f.status !== 'all') {
      const settle = r.payStatus || r.status;
      if (settle !== f.status) return false;
    }
    return true;
  };

  // 付款构成 → 状态文案的判定依据（未付款 / 抵扣付完 / 现金付完 / 抵扣部分+欠款 / 现金部分+欠款 / 抵扣+现金付完 / 抵扣+现金+欠款）
  // adv = 用预存抵扣的部分，cash = 当次实际收到的现金/转账（含定金），paid = adv + cash
  const payKindOf = (outstanding, paid, adv) => {
    if (paid <= 0.001) return 'unpaid';
    const settled = outstanding <= 0.001;
    const cash = r2(Math.max(0, paid - adv));
    if (adv > 0.001 && cash > 0.001) return settled ? 'mixed_settled' : 'mixed_partial';
    if (adv > 0.001) return settled ? 'adv_settled' : 'adv_partial';
    return settled ? 'cash_settled' : 'cash_partial';
  };

  const calc = (rows, dir, f) => {
    const mapped = rows.map(r => {
      const t = r2(r.total_amount), dep = r2(r.deposit || 0), p = r2(paidStmt.get(dir, r.id).s);
      const advPaid = r2(r.paid_advance || 0);
      const base = { id: r.id, bill_no: r.bill_no, partner: r.partner, party_id: r.party_id, total: t, deposit: dep, paid: p, outstanding: r2(t - p), products: r.products || '', created_at: r.created_at || '',
        paid_advance: advPaid, paid_cash: r2(Math.max(0, p - advPaid)), pay_kind: payKindOf(r2(t - p), p, advPaid),
        qty_total: r.qty_total || 0, item_count: r.item_count || 0, qty_detail: r.qty_detail || '', qty_unit: r.qty_unit || '' };
      if (r.status === 'returned') return { ...base, status: 'returned', returned: true, docStatus: 'returned', return_reason: r.return_reason || '', returned_at: r.returned_at || '', return_approved_by: r.return_approved_by || '' };
      if (r.status === 'pending_return') {
        // 退单待审仍算债权/债务（审批驳回后单据就恢复原状），只是额外打个待审标记；
        // 这里同时算出它真实的收付状态，供汇总卡片按「已结清/部分/未收」归类，保证各项数字自洽
        const out = r2(t - p);
        const payStatus = out <= 0.001 ? 'settled' : (p > 0.001 ? 'partial' : 'unpaid');
        return { ...base, status: 'pending_return', payStatus, returned: false, docStatus: 'pending_return', return_reason: r.return_reason || '', return_requested_by: r.return_requested_by || '', return_requested_at: r.return_requested_at || '' };
      }
      const out = r2(t - p);
      const status = out <= 0.001 ? 'settled' : (p > 0.001 ? 'partial' : 'unpaid');
      let deposit_status = '-';
      if (dep > 0.001) deposit_status = (p >= dep - 0.001) ? '已付' : '未付';
      return { ...base, status, deposit_status, returned: false, docStatus: 'active' };
    });
    // 汇总卡片：始终按全量统计
    // 注意：退单待审（pending_return）必须算进来。它既不删分摊也不回滚库存，
    // 审批被驳回就原样恢复，所以债权债务仍然存在；漏掉它会让财务页的应收/应付
    // 与客户列表、往来账、应收应付报表差出「待审那几张单的金额」。
    let total = 0, paid = 0, depositTotal = 0, depositPaid = 0, count = 0, settled = 0, partial = 0, unpaid = 0, returned = 0, pending = 0;
    for (const r of mapped) {
      if (r.returned) { returned++; continue; }
      count++; total += r.total; paid += r.paid;
      const st = r.payStatus || r.status;
      if (st === 'settled') settled++; else if (st === 'partial') partial++; else unpaid++;
      if (r.docStatus === 'pending_return') pending++;
      if (r.deposit > 0.001) { depositTotal += r.deposit; if (r.paid >= r.deposit - 0.001) depositPaid++; }
    }
    // 明细列表：按筛选条件过滤
    const list = mapped.filter(r => matchFilter(r, f));
    const ls = { count: 0, settled: 0, partial: 0, unpaid: 0, returned: 0, pending: 0 };
    for (const r of list) {
      if (r.returned) { ls.returned++; continue; }
      ls.count++;
      const st = r.payStatus || r.status;
      if (st === 'settled') ls.settled++; else if (st === 'partial') ls.partial++; else ls.unpaid++;
      if (r.docStatus === 'pending_return') ls.pending++;
    }
    return { total: r2(total), paid: r2(paid), outstanding: r2(total - paid), depositTotal: r2(depositTotal), depositPaid, count, settled, partial, unpaid, returned, pending, list, listStats: ls };
  };
  const purchase = calc(purchases, 'purchase', pFilter);
  const sale = calc(sales, 'sale', sFilter);

  // 预付款/预收款余额（某单位 payments 总额 - 已分摊）
  // 口径必须与 advanceBalanceOf 完全一致：客户只看收款、供应商只看付款，
  // 否则历史上一笔方向与单位类型不符的记录会把两边的钱混在一起算。
  const advRows = db.prepare(`SELECT p.party_type, p.party_id, p.amount, COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE payment_id=p.id),0) AS alloc
    FROM payments p WHERE p.party_type IS NOT NULL AND p.party_id IS NOT NULL
      AND ((p.party_type='customer' AND p.direction='receive') OR (p.party_type='supplier' AND p.direction='pay'))`).all();
  const advMap = {};
  for (const a of advRows) {
    const bal = r2(a.amount - a.alloc);
    if (bal > 0.001) {
      const key = a.party_type + '_' + a.party_id;
      if (!advMap[key]) advMap[key] = { party_type: a.party_type, party_id: a.party_id, balance: 0 };
      advMap[key].balance = r2(advMap[key].balance + bal);
    }
  }
  const advances = Object.values(advMap).map(a => ({ ...a, name: partyName(a.party_type, a.party_id) }));
  const suppliersAdv = advances.filter(a => a.party_type === 'supplier').map(a => ({ id: a.party_id, name: a.name, balance: a.balance }));
  const customersAdv = advances.filter(a => a.party_type === 'customer').map(a => ({ id: a.party_id, name: a.name, balance: a.balance }));

  // 无归属收付款：party_id 为空的钱不属于任何往来单位，既进不了上面的预存合计，
  // 也永远不会被自动抵扣——它就是财务页「实际收到的钱」与「各单位预存合计」对不上的那部分差额。
  // 单独统计出来交给前端显式提示，而不是让用户自己发现两个数字差了一截。
  // 用一次 LEFT JOIN 聚合代替「每行一个子查询」，避免付款笔数一多就线性变慢
  const orphanRows = db.prepare(`SELECT p.id, p.amount, COALESCE(SUM(a.amount),0) AS alloc
    FROM payments p LEFT JOIN payment_allocations a ON a.payment_id = p.id
    WHERE p.party_id IS NULL GROUP BY p.id`).all();
  let orphanBalance = 0, orphanCount = 0;
  for (const o of orphanRows) {
    const b = r2(o.amount - o.alloc);
    if (b > 0.001) { orphanBalance = r2(orphanBalance + b); orphanCount++; }
  }

  // 收付款流水：默认取最近 400 笔，前端可点「加载更多」把上限调大（最多 2000）
  const payLimit = Math.min(2000, Math.max(50, parseInt(q.pay_limit, 10) || 400));
  const payTotal = db.prepare('SELECT COUNT(*) AS c FROM payments').get().c;
  const payments = db.prepare(`SELECT p.* FROM payments p ORDER BY p.created_at DESC, p.id DESC LIMIT ?`).all(payLimit);
  // 待审的金额调整：标到对应流水行上，避免同一笔被重复申请/看不清状态
  const pendAdj = db.prepare("SELECT payment_id, id AS adj_id, new_amount, requested_by, requested_at FROM payment_adjustments WHERE status='pending'").all();
  const pendMap = {};
  for (const a of pendAdj) pendMap[a.payment_id] = { adj_id: a.adj_id, new_amount: r2(a.new_amount), requested_by: a.requested_by, requested_at: a.requested_at };
  const payAllocMap = allocMapForPayIds(payments.map(p => p.id));
  const payNameMap = partyNameMap();
  const payOut = payments.map(p => ({ ...p, amount: r2(p.amount), party_name: partyNameOf(payNameMap, p.party_type, p.party_id), allocations: payAllocMap.get(p.id) || [], pending_adjust: pendMap[p.id] || null }));
  // 金额调整申请：管理员看全部待审，普通用户只看自己提交的
  const adjSql = `SELECT a.*, p.direction, p.party_type, p.party_id, p.amount AS current_amount, p.note AS pay_note, p.created_at AS pay_at,
      COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE payment_id=p.id),0) AS alloc
    FROM payment_adjustments a JOIN payments p ON p.id=a.payment_id`;
  const adjAdmin = isAdminSession(req);
  const adjRows = adjAdmin
    ? db.prepare(`${adjSql} WHERE a.status='pending' ORDER BY a.id DESC LIMIT 100`).all()
    : db.prepare(`${adjSql} WHERE a.status='pending' AND a.requested_by=? ORDER BY a.id DESC LIMIT 100`).all(req.session.username);
  const adjustments = adjRows.map(a => ({
    ...a, party_name: partyName(a.party_type, a.party_id),
    old_amount: r2(a.old_amount), new_amount: r2(a.new_amount), current_amount: r2(a.current_amount), alloc: r2(a.alloc)
  }));

  const advanceTotal = r2(suppliersAdv.reduce((s, x) => s + x.balance, 0) + customersAdv.reduce((s, x) => s + x.balance, 0));
  const suppliers = db.prepare(`SELECT id, name FROM suppliers ORDER BY name`).all();
  const customers = db.prepare(`SELECT id, name FROM customers ORDER BY name`).all();
  return {
    purchase, sale,
    advances: { suppliers: suppliersAdv, customers: customersAdv, total: advanceTotal },
    // 挂在账外、不属于任何单位的钱。有余额时前端会提示去指定归属
    orphans: { count: orphanCount, balance: orphanBalance },
    net: r2(sale.outstanding - purchase.outstanding),
    stockValue: inventoryValue(),
    payments: payOut,
    payments_total: payTotal,
    payments_limit: payLimit,
    adjustments: adjustments,
    adjustments_pending: adjustments.length,
    suppliers, customers
  };
}

app.get('/api/finance/summary', requireAuth, (req, res) => {
  res.json(financeSummaryData(req.query || {}, req));
});

// ---------- 采购应付 / 销售应收明细导出 ----------
// 关键：与页面共用 financeSummaryData，导出的一定是「当前筛选后正在看的那一批」，
// 而不是另写一套 SQL 重新查一遍——两套查询迟早会不一致。
const FIN_EXPORT_MAX_ROWS = 20000;
app.get('/api/finance/export', requireAuth, (req, res) => {
  const q = req.query || {};
  const isPur = q.kind !== 'sale';
  const d = financeSummaryData(q, req);
  const bucket = isPur ? d.purchase : d.sale;
  const list = bucket.list || [];
  if (!list.length) return res.status(400).json({ error: '当前筛选条件下没有单据，无法导出' });

  // 与交易清单导出同一口径：超限只截断明细，合计仍按全量算，并在表头写明，
  // 避免几万行的同步 ZIP 把主线程占满数秒，也避免被误当成完整数据。
  const truncated = list.length > FIN_EXPORT_MAX_ROWS;
  const outList = truncated ? list.slice(0, FIN_EXPORT_MAX_ROWS) : list;

  const pre = isPur ? 'p_' : 's_';
  const partyId = parseInt(q[pre + (isPur ? 'supplier' : 'customer')], 10) || 0;
  const partyList = isPur ? d.suppliers : d.customers;
  const partyText = partyId ? ((partyList.find((x) => x.id === partyId) || {}).name || ('#' + partyId)) : '全部';
  const statusText = { all: '全部', unpaid: '未付款', partial: '部分付款', settled: '已结清' };
  const retText = { all: '全部', normal: '正常(未退单)', returned: '已退单', pending: '退单待审' };
  // 付款构成 → 状态文案，与前端页面标签口径完全一致
  const PAY_KIND_TEXT = {
    unpaid: '未付款', adv_settled: '抵扣付完', cash_settled: '现金付完',
    adv_partial: '抵扣部分+欠款', cash_partial: '现金部分+欠款',
    mixed_settled: '抵扣+现金付完', mixed_partial: '抵扣+现金+欠款'
  };
  const rowStatus = (r) => (r.docStatus === 'returned' ? '已退单'
    : r.docStatus === 'pending_return' ? '退单待审'
      : (PAY_KIND_TEXT[r.pay_kind] || '未付款'));

  const who = isPur ? '供应商' : '客户';
  const colPaid = isPur ? '已付' : '已收';
  const colDue = isPur ? '未付' : '未收';
  const brand = getSettings().branding;
  const rows = [
    [`${brand.shopName || ''} · ${isPur ? '采购应付明细' : '销售应收明细'}`],
    [`筛选：${who} ${partyText} ｜ 商品 ${(q[pre + 'product'] || '').trim() || '全部'} ｜ 状态 ${statusText[q[pre + 'status']] || '全部'}`
      + ` ｜ 退单 ${retText[q[pre + 'return']] || '全部'}`
      + ` ｜ 日期 ${(q[pre + 'from'] || '').slice(0, 10) || '不限'} ~ ${(q[pre + 'to'] || '').slice(0, 10) || '不限'}`
      + ` ｜ 共 ${bucket.listStats.count} 笔`
      + (truncated ? ` ｜ ⚠ 单次最多导出 ${FIN_EXPORT_MAX_ROWS} 笔，本表仅含最近 ${FIN_EXPORT_MAX_ROWS} 笔；下方合计仍为全量` : '')],
    [],
    ['单号', '交易时间', who, '商品明细', '数量', '总金额', '定金(约定)', '定金状态', colPaid, colDue, '状态', '备注']
  ];
  for (const r of outList) {
    const isRet = r.docStatus === 'returned';
    rows.push([
      r.bill_no,
      (r.created_at || '').slice(0, 19),
      r.partner || (isPur ? '直采' : '散客'),
      r.qty_detail || r.products || '',
      r.qty_total || 0,
      r.total,
      r.deposit > 0.001 ? r.deposit : '',
      r.deposit > 0.001 ? (r.deposit_status || '') : '',
      isRet ? '' : r.paid,          // 已退单行与页面一致：金额留空，不计入合计
      isRet ? '' : r.outstanding,
      rowStatus(r),
      isRet ? ('退单原因：' + (r.return_reason || '—')) : ''
    ]);
  }
  // 合计按「筛选后的全量」算（不是截断后的明细），与页面表尾口径一致
  let cnt = 0, sumTotal = 0, sumPaid = 0, sumOut = 0, retCnt = 0;
  for (const r of list) {
    if (r.docStatus === 'returned') { retCnt++; continue; }
    cnt++; sumTotal += r.total; sumPaid += r.paid; sumOut += r.outstanding;
  }
  rows.push([]);
  rows.push([`合计（${cnt} 笔，不含已退单）`, '', '', '', '', r2(sumTotal), '', '', r2(sumPaid), r2(sumOut), '', '']);
  if (retCnt) rows.push([`另有已退单 ${retCnt} 笔，不计入合计`, '', '', '', '', '', '', '', '', '', '', '']);

  let buf;
  try { buf = buildWorkbook([{ name: isPur ? '采购应付' : '销售应收', rows }]); }
  catch (e) { return res.status(500).json({ error: '生成 Excel 失败：' + e.message }); }

  const stamp = db.prepare("SELECT strftime('%Y%m%d','now','localtime') AS d").get().d;
  const fname = `${isPur ? '采购应付明细' : '销售应收明细'}_${stamp}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="finance_${isPur ? 'payable' : 'receivable'}_${stamp}.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
});

// ---------- 报表 ----------
app.get('/api/reports/overview', requireAuth, (req, res) => {
  const today = db.prepare(`SELECT COALESCE(SUM(total_amount),0) AS s, COALESCE(SUM(total_profit),0) AS p FROM sales WHERE date(created_at)=date('now','localtime') AND (status IS NULL OR status != 'returned')`).get();
  const month = db.prepare(`SELECT COALESCE(SUM(total_amount),0) AS s, COALESCE(SUM(total_profit),0) AS p FROM sales WHERE strftime('%Y-%m', created_at)=strftime('%Y-%m','now','localtime') AND (status IS NULL OR status != 'returned')`).get();
  const purchaseMonth = db.prepare(`SELECT COALESCE(SUM(total_amount),0) AS c FROM purchases WHERE strftime('%Y-%m', created_at)=strftime('%Y-%m','now','localtime') AND (status IS NULL OR status != 'returned')`).get();
  const lowCount = db.prepare('SELECT COUNT(*) AS c FROM products WHERE stock <= min_stock').get().c;
  const productCount = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
  const stockValue = db.prepare('SELECT COALESCE(SUM(stock * purchase_price),0) AS v FROM products').get().v;
  res.json({
    todaySales: r2(today.s), todayProfit: r2(today.p),
    monthSales: r2(month.s), monthProfit: r2(month.p),
    monthPurchase: r2(purchaseMonth.c),
    lowStockCount: lowCount, productCount, stockValue: r2(stockValue)
  });
});

app.get('/api/reports/sales-trend', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT date(created_at) AS day, COALESCE(SUM(total_amount),0) AS amount, COALESCE(SUM(total_profit),0) AS profit
    FROM sales WHERE created_at >= date('now','localtime','-13 days') AND (status IS NULL OR status != 'returned') GROUP BY day ORDER BY day`).all();
  res.json(rows);
});

app.get('/api/reports/top-products', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT pr.name, pr.sku, SUM(si.qty) AS qty, SUM(si.subtotal) AS amount, SUM(si.profit) AS profit
    FROM sale_items si LEFT JOIN products pr ON si.product_id = pr.id
    JOIN sales s ON si.sale_id = s.id AND (s.status IS NULL OR s.status != 'returned')
    GROUP BY si.product_id ORDER BY amount DESC LIMIT 10`).all();
  res.json(rows);
});

// 应收/应付汇总：总应收、总应付，以及按供应商/客户汇总
function computeArAp() {
  const suppliers = db.prepare(`
    SELECT s.id, s.name,
      COALESCE(SUM(p.total_amount),0) AS total,
      COALESCE(SUM(p.total_amount - (SELECT COALESCE(SUM(amount),0) FROM payment_allocations WHERE doc_type='purchase' AND doc_id=p.id)),0) AS payable
    FROM suppliers s
    LEFT JOIN purchases p ON p.supplier_id = s.id AND (p.status IS NULL OR p.status != 'returned')
    GROUP BY s.id, s.name
    HAVING payable > 0.001 OR total > 0.001
    ORDER BY payable DESC`).all();
  const customers = db.prepare(`
    SELECT c.id, c.name, COALESCE(c.credit_limit, 100000) AS credit_limit,
      COALESCE(SUM(s.total_amount),0) AS total,
      COALESCE(SUM(s.total_amount - (SELECT COALESCE(SUM(amount),0) FROM payment_allocations WHERE doc_type='sale' AND doc_id=s.id)),0) AS receivable
    FROM customers c
    LEFT JOIN sales s ON s.customer_id = c.id AND (s.status IS NULL OR s.status != 'returned')
    GROUP BY c.id, c.name
    HAVING receivable > 0.001 OR total > 0.001
    ORDER BY receivable DESC`).all();

  // 「直采」：采购单未指定供应商（supplier_id 为空），没有对应往来单位，单独汇总成一行
  const direct = db.prepare(`
    SELECT COALESCE(SUM(p.total_amount),0) AS total,
      COALESCE(SUM(p.total_amount - COALESCE((SELECT SUM(amount) FROM payment_allocations pa WHERE pa.doc_type='purchase' AND pa.doc_id=p.id),0)),0) AS payable
    FROM purchases p WHERE p.supplier_id IS NULL AND (p.status IS NULL OR p.status != 'returned')`).get();
  // 「散客」：销售单未指定客户（customer_id 为空），没有对应往来单位，单独汇总成一行
  const retail = db.prepare(`
    SELECT COALESCE(SUM(s.total_amount),0) AS total,
      COALESCE(SUM(s.total_amount - COALESCE((SELECT SUM(amount) FROM payment_allocations pa WHERE pa.doc_type='sale' AND pa.doc_id=s.id),0)),0) AS receivable
    FROM sales s WHERE s.customer_id IS NULL AND (s.status IS NULL OR s.status != 'returned')`).get();

  const sum = (arr, k) => arr.reduce((s, x) => s + r2(x[k] || 0), 0);
  const sup = suppliers.map(s => ({ id: s.id, name: s.name, total: r2(s.total), paid: r2(s.total - s.payable), payable: r2(s.payable) }));
  // 直采单独成行（id=0 表示「未指定供应商」，点击可下钻查看明细）
  if (r2(direct.total) > 0.001 || r2(direct.payable) > 0.001) {
    sup.push({ id: 0, name: '直采（未指定供应商）', total: r2(direct.total), paid: r2(direct.total - direct.payable), payable: r2(direct.payable), unlinked: true });
  }
  const advCus = advanceMapOf('customer');
  const cus = customers.map(c => {
    const receivable = r2(c.receivable);
    const credit = r2(c.credit_limit);
    const advance = advCus.get(c.id) || 0;
    // 预收款先冲抵欠款，剩余部分才占用授信额度
    const used = Math.max(0, r2(receivable - advance));
    return {
      id: c.id, name: c.name, total: r2(c.total), received: r2(c.total - receivable), receivable,
      advance, credit_limit: credit, credit_used: used, available: r2(credit - used),
      over_limit: used > credit + 0.001
    };
  });
  // 散客单独成行（id=0 表示「未指定客户」，点击可下钻查看明细）
  if (r2(retail.total) > 0.001 || r2(retail.receivable) > 0.001) {
    cus.push({ id: 0, name: '散客（未指定客户）', total: r2(retail.total), received: r2(retail.total - retail.receivable), receivable: r2(retail.receivable), credit_limit: null, over_limit: false, unlinked: true });
  }
  const purchaseTotal = r2(sum(sup, 'total')), purchasePaid = r2(sum(sup, 'paid')), purchaseOutstanding = r2(sum(sup, 'payable'));
  const saleTotal = r2(sum(cus, 'total')), saleReceived = r2(sum(cus, 'received')), saleOutstanding = r2(sum(cus, 'receivable'));
  return {
    totalPayable: purchaseOutstanding,
    totalReceivable: saleOutstanding,
    purchase: { total: purchaseTotal, paid: purchasePaid, outstanding: purchaseOutstanding },
    sale: { total: saleTotal, received: saleReceived, outstanding: saleOutstanding },
    suppliers: sup,
    customers: cus,
    net: r2(saleOutstanding - purchaseOutstanding),
    stockValue: inventoryValue()
  };
}

app.get('/api/reports/ar-ap', requireAuth, (req, res) => res.json(computeArAp()));

// 单供应商应付明细
app.get('/api/reports/supplier/:id/purchases', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const supplier = db.prepare('SELECT id, name FROM suppliers WHERE id=?').get(id);
  if (!supplier) return res.status(404).json({ error: '供应商不存在' });
  const rows = db.prepare(`
    SELECT p.id, p.bill_no, p.total_amount AS total, p.deposit,
      (SELECT COALESCE(SUM(amount),0) FROM payment_allocations WHERE doc_type='purchase' AND doc_id=p.id) AS paid,
      p.created_at
    FROM purchases p WHERE p.supplier_id=? AND (p.status IS NULL OR p.status != 'returned') ORDER BY p.created_at DESC`).all(id);
  const payStmt = db.prepare(`SELECT pa.amount, p.created_at, p.method, p.note, p.id AS payment_id, p.is_deposit
    FROM payment_allocations pa JOIN payments p ON pa.payment_id=p.id
    WHERE pa.doc_type='purchase' AND pa.doc_id=? ORDER BY p.created_at ASC, p.id ASC`);
  const list = rows.map(r => {
    const payments = payStmt.all(r.id).map(x => ({ amount: r2(x.amount), date: x.created_at, method: x.method, note: x.note, is_deposit: x.is_deposit, payment_id: x.payment_id }));
    return { bill_no: r.bill_no, total: r2(r.total), deposit: r2(r.deposit || 0), paid: r2(r.paid), outstanding: r2(r.total - r.paid), created_at: r.created_at, payments, pay_count: payments.length };
  });
  const total = r2(list.reduce((s, x) => s + x.total, 0)), paid = r2(list.reduce((s, x) => s + x.paid, 0));
  res.json({ supplier, list, totals: { total, paid, outstanding: r2(total - paid) } });
});

// 单客户应收明细
app.get('/api/reports/customer/:id/sales', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const customer = db.prepare('SELECT id, name FROM customers WHERE id=?').get(id);
  if (!customer) return res.status(404).json({ error: '客户不存在' });
  const rows = db.prepare(`
    SELECT s.id, s.bill_no, s.total_amount AS total, s.total_profit AS profit, s.deposit,
      (SELECT COALESCE(SUM(amount),0) FROM payment_allocations WHERE doc_type='sale' AND doc_id=s.id) AS received,
      s.created_at
    FROM sales s WHERE s.customer_id=? AND (s.status IS NULL OR s.status != 'returned') ORDER BY s.created_at DESC`).all(id);
  const payStmt = db.prepare(`SELECT pa.amount, p.created_at, p.method, p.note, p.id AS payment_id, p.is_deposit
    FROM payment_allocations pa JOIN payments p ON pa.payment_id=p.id
    WHERE pa.doc_type='sale' AND pa.doc_id=? ORDER BY p.created_at ASC, p.id ASC`);
  const list = rows.map(r => {
    const payments = payStmt.all(r.id).map(x => ({ amount: r2(x.amount), date: x.created_at, method: x.method, note: x.note, is_deposit: x.is_deposit, payment_id: x.payment_id }));
    return { bill_no: r.bill_no, total: r2(r.total), profit: r2(r.profit || 0), deposit: r2(r.deposit || 0), received: r2(r.received), outstanding: r2(r.total - r.received), created_at: r.created_at, payments, pay_count: payments.length };
  });
  const total = r2(list.reduce((s, x) => s + x.total, 0)), received = r2(list.reduce((s, x) => s + x.received, 0)), profit = r2(list.reduce((s, x) => s + x.profit, 0));
  res.json({ customer, list, totals: { total, received, outstanding: r2(total - received), profit } });
});

// 往来单位流水账：单据（采购/销售）与收付款按时间合并，倒序返回
// type: supplier | customer
// 往来单位流水账（单家）。JSON 接口与导出共用这一份计算，避免「看到的」和「导出的」不一致。
//
// 关于日期段：from/to 只过滤**明细条目**，余额类字段（未结清 / 预存）始终按全量口径算。
// 这不是偷懒——「单据合计 − 已付 = 未结清」这个等式只在全量时成立；若把三者都按区间裁开，
// 表尾就会出现「7 月单据 1 万、已付 3 千、未结清 0」这种自相矛盾的组合（因为 7 月之前的欠款没算进去）。
function partyLedgerData(typeParam, idParam, q = {}) {
  const type = typeParam === 'customer' ? 'customer' : 'supplier';
  const id = parseInt(idParam);
  const isSup = type === 'supplier';
  const isUnlinked = id === 0;   // id=0 表示「未指定供应商/客户」的汇总（直采 / 散客）

  let from = String(q.from || '').trim().slice(0, 10);
  let to = String(q.to || '').trim().slice(0, 10);
  if (from && to && from > to) { const t = from; from = to; to = t; }   // 起止颠倒自动交换
  const filtered = !!(from || to);
  const inRange = (at) => {
    const d = String(at || '').slice(0, 10);
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  };

  let party;
  if (isUnlinked) {
    party = { id: 0, name: isSup ? '直采（未指定供应商）' : '散客（未指定客户）' };
  } else {
    party = db.prepare(`SELECT id, name FROM ${isSup ? 'suppliers' : 'customers'} WHERE id=?`).get(id);
    if (!party) return { err: 404, msg: isSup ? '供应商不存在' : '客户不存在' };
  }

  // 单据流水：正数（增加应付/应收）。已退单的不计入（其资金已释放为预存，余额已归零）
  // id=0 时按「供应商/客户为空」筛选直采/散客单据
  const docsAll = isSup
    ? db.prepare(`SELECT id, bill_no AS no, total_amount AS amount, deposit, created_at AS at, note
        FROM purchases WHERE ${isUnlinked ? 'supplier_id IS NULL' : 'supplier_id=?'} AND (status IS NULL OR status != 'returned')`).all(...(isUnlinked ? [] : [id]))
    : db.prepare(`SELECT id, bill_no AS no, total_amount AS amount, total_profit AS profit, deposit, created_at AS at, note
        FROM sales WHERE ${isUnlinked ? 'customer_id IS NULL' : 'customer_id=?'} AND (status IS NULL OR status != 'returned')`).all(...(isUnlinked ? [] : [id]));
  const docs = filtered ? docsAll.filter(d => inRange(d.at)) : docsAll;

  // 收付款流水：负数（冲减应付/应收）
  // 优先按往来单位取；未指定单位的（party_id 为空）用其分摊到的单据反推归属，
  // 否则这些付款会因为没选单位而在流水账里彻底消失。
  const docType = isSup ? 'purchase' : 'sale';
  // 归属映射必须用「全量单据」建：若只用区间内的单据，那么一笔 6 月付款冲 5 月单据时，
  // 5 月单据不在区间里，这笔付款就会被判成「跨单位」而整笔消失。
  const docMap = new Map(docsAll.map(d => [d.id, d.no]));
  const payRows = db.prepare(`SELECT id, amount, method, note, is_deposit, created_at AS at, party_type, party_id
    FROM payments
    WHERE direction=? AND ((party_type=? AND party_id=?) OR party_id IS NULL)
    ORDER BY created_at ASC, id ASC`)
    .all(isSup ? 'pay' : 'receive', type, id);
  const allocStmt = db.prepare('SELECT doc_type, doc_id, amount FROM payment_allocations WHERE payment_id=?');

  const paysAll = [];
  for (const p of payRows) {
    const all = allocStmt.all(p.id);
    const mine = all.filter(a => a.doc_type === docType && docMap.has(a.doc_id))
      .map(a => ({ bill_no: docMap.get(a.doc_id), doc_id: a.doc_id, amount: r2(a.amount) }));
    if (p.party_id != null) {
      paysAll.push({ ...p, allocs: mine });
    } else if (all.length > 0 && mine.length === all.length) {
      // 该笔收付款全部分摊在本单位的单据上，可确认属于本单位
      paysAll.push({ ...p, allocs: mine, inferred: true });
    }
    // 跨单位分摊的（无法确定归属）不计入任何一方，避免重复统计
  }
  const pays = filtered ? paysAll.filter(p => inRange(p.at)) : paysAll;

  const entries = [];
  for (const d of docs) {
    entries.push({
      kind: 'doc',
      at: d.at || '',
      no: d.no,
      amount: r2(d.amount),
      deposit: r2(d.deposit || 0),
      profit: isSup ? null : r2(d.profit || 0),
      note: d.note || ''
    });
  }
  for (const p of pays) {
    const allocs = p.allocs || [];
    entries.push({
      kind: isSup ? 'pay' : 'receive',
      at: p.at || '',
      no: '',
      amount: r2(p.amount),
      method: p.method || 'cash',
      note: p.note || '',
      is_deposit: !!p.is_deposit,
      allocs,
      to_advance: r2(p.amount - allocs.reduce((s, x) => s + x.amount, 0))
    });
  }
  // 时间倒序；同一秒内收付款排在单据之前（同一秒通常是建单后立即记的定金）
  entries.sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? 1 : -1;
    const rank = (e) => (e.kind === 'doc' ? 1 : 0);
    return rank(a) - rank(b);
  });

  const docTotal = r2(docs.reduce((s, d) => s + d.amount, 0));
  const paidTotal = r2(pays.reduce((s, p) => s + p.amount, 0));
  const depositTotal = r2(docs.reduce((s, d) => s + (d.deposit || 0), 0));
  const allDocTotal = r2(docsAll.reduce((s, d) => s + d.amount, 0));
  const allPaidTotal = r2(paysAll.reduce((s, p) => s + p.amount, 0));
  // 已分摊到本单位单据上的金额（与 ar-ap 的"已付/已收"同一口径）
  const allocatedTotal = isSup
    ? r2(db.prepare(`SELECT COALESCE(SUM(a.amount),0) AS s FROM payment_allocations a
        JOIN purchases p ON a.doc_type='purchase' AND a.doc_id=p.id WHERE ${isUnlinked ? 'p.supplier_id IS NULL' : 'p.supplier_id=?'}`)
        .get(...(isUnlinked ? [] : [id])).s)
    : r2(db.prepare(`SELECT COALESCE(SUM(a.amount),0) AS s FROM payment_allocations a
        JOIN sales s2 ON a.doc_type='sale' AND a.doc_id=s2.id WHERE ${isUnlinked ? 's2.customer_id IS NULL' : 's2.customer_id=?'}`)
        .get(...(isUnlinked ? [] : [id])).s);
  return {
    type,
    party,
    range: { from, to, filtered },
    totals: {
      docTotal,                                   // 期间内采购/销售金额（未筛选=累计）
      paidTotal,                                  // 期间内已付/已收（含预存）
      allocatedTotal,                             // 已分摊到单据的金额（全量）
      // 余额口径固定用全量，避免筛选后表尾出现自相矛盾的等式
      outstanding: r2(allDocTotal - allocatedTotal), // 未结清（与总应收/总应付一致）
      advance: r2(allPaidTotal - allocatedTotal),    // 预付款/预收款余额（已付但未分摊）
      balance: r2(docTotal - paidTotal),             // 期间净发生额（未筛选=历史净额）
      allDocTotal,
      allPaidTotal,
      depositTotal
    },
    entries
  };
}

app.get('/api/reports/party/:type/:id/ledger', requireAuth, (req, res) => {
  const d = partyLedgerData(req.params.type, req.params.id, req.query || {});
  if (d.err) return res.status(d.err).json({ error: d.msg });
  res.json(d);
});

// 单家往来流水账导出：与页面同一个日期段、同一份计算
app.get('/api/reports/party/:type/:id/ledger/export', requireAuth, (req, res) => {
  const d = partyLedgerData(req.params.type, req.params.id, req.query || {});
  if (d.err) return res.status(d.err).json({ error: d.msg });
  if (!d.entries.length) return res.status(400).json({ error: '该期间没有往来记录，无法导出' });

  const isSup = d.type === 'supplier';
  const t = d.totals;
  const METHODS = { cash: '现金', bank: '银行转账', alipay: '支付宝', wechat: '微信', other: '其他' };
  const rows = [[
    '时间', '类型', '单号 / 事项', isSup ? '应付增加' : '应收增加',
    isSup ? '已付' : '已收', '说明', '操作人'
  ]];
  for (const e of d.entries) {
    if (e.kind === 'doc') {
      const bits = [];
      if (e.deposit > 0.001) bits.push(`约定定金 ${e.deposit}`);
      if (!isSup && e.profit != null) bits.push(`利润 ${e.profit}`);
      if (e.note) bits.push(e.note);
      rows.push([e.at, isSup ? '采购入库' : '销售出库', e.no, r2(e.amount), '', bits.join(' · '), '']);
    } else {
      const bits = [];
      bits.push(METHODS[e.method] || e.method || '现金');
      if (e.is_deposit) bits.unshift('定金');
      if ((e.allocs || []).length) bits.push('冲抵 ' + e.allocs.map(a => `${a.bill_no || ''} ${r2(a.amount)}`).join('、'));
      if (e.to_advance > 0.001) bits.push(`转预存 ${r2(e.to_advance)}`);
      if (e.note) bits.push(e.note);
      const label = e.is_deposit ? (isSup ? '付定金' : '收定金') : (isSup ? '付款' : '收款');
      rows.push([e.at, label, '', '', r2(e.amount), bits.join(' · '), '']);
    }
  }
  rows.push([]);
  if (d.range.filtered) {
    rows.push(['本期间合计', '', `单据 ${t.docTotal}`, t.docTotal, t.paidTotal,
      `未结清余额 ${t.outstanding}（全量口径，含本期间之外的往来）`, '']);
  } else {
    rows.push(['合计', '', `单据 ${t.docTotal}`, t.docTotal, t.paidTotal,
      `单据合计 − 已付 = 未结清 ${t.outstanding}${t.advance > 0.001 ? `；另有预存 ${t.advance}` : ''}`, '']);
  }

  const period = d.range.filtered
    ? `${d.range.from || '不限'} ~ ${d.range.to || '不限'}`
    : '全部';
  const sheets = [{
    name: '往来流水账',
    rows: [
      [`${d.party.name} · ${isSup ? '采购应付' : '销售应收'}往来流水账`],
      [`期间：${period}　｜　共 ${d.entries.length} 笔　｜　导出时间：${nowLocal()}`],
      [],
      ...rows
    ]
  }];

  let buf;
  try { buf = buildWorkbook(sheets); }
  catch (e) { return res.status(500).json({ error: '生成 Excel 失败：' + e.message }); }
  const stamp = db.prepare("SELECT strftime('%Y%m%d','now','localtime') AS d").get().d;
  const fname = `${d.party.name}_往来流水账_${stamp}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="ledger_${stamp}.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
});

// 本期经营数据（默认当月；支持 from/to=YYYY-MM-DD 日期段，或旧参数 period=YYYY-MM 整月）
app.get('/api/reports/period', requireAuth, (req, res) => {
  const nowMonth = db.prepare(`SELECT strftime('%Y-%m','now','localtime') AS p`).get().p;
  let from = String(req.query.from || '').trim();
  let to = String(req.query.to || '').trim();
  const period = String(req.query.period || '').trim();
  // 兼容旧参数：period=YYYY-MM → 该月首末日
  if (!from && !to && period) {
    from = period + '-01';
    to = db.prepare(`SELECT date(?, '+1 month', '-1 day') AS d`).get(from).d;
  }
  // 默认当月：本月 1 日 ~ 今天
  if (!from) from = nowMonth + '-01';
  if (!to) to = db.prepare(`SELECT date('now','localtime') AS d`).get().d;
  if (from > to) { const tmp = from; from = to; to = tmp; } // 容错：起止颠倒自动交换
  const label = `${from} ~ ${to}`;

  const sales = db.prepare(`SELECT COALESCE(SUM(total_amount),0) AS amt, COALESCE(SUM(total_profit),0) AS profit FROM sales WHERE created_at >= ? AND created_at < date(?, '+1 day') AND (status IS NULL OR status != 'returned')`).get(from, to);
  const purchases = db.prepare(`SELECT COALESCE(SUM(total_amount),0) AS amt FROM purchases WHERE created_at >= ? AND created_at < date(?, '+1 day') AND (status IS NULL OR status != 'returned')`).get(from, to);
  const salesList = db.prepare(`
    SELECT s.bill_no, s.total_amount AS total, s.total_profit AS profit, s.deposit, c.name AS party, s.created_at,
      (SELECT COALESCE(SUM(amount),0) FROM payment_allocations WHERE doc_type='sale' AND doc_id=s.id) AS received
    FROM sales s LEFT JOIN customers c ON s.customer_id=c.id WHERE s.created_at >= ? AND s.created_at < date(?, '+1 day') AND (s.status IS NULL OR s.status != 'returned') ORDER BY s.created_at DESC`).all(from, to);
  const purchList = db.prepare(`
    SELECT p.bill_no, p.total_amount AS total, p.deposit, s.name AS party, p.created_at,
      (SELECT COALESCE(SUM(amount),0) FROM payment_allocations WHERE doc_type='purchase' AND doc_id=p.id) AS paid
    FROM purchases p LEFT JOIN suppliers s ON p.supplier_id=s.id WHERE p.created_at >= ? AND p.created_at < date(?, '+1 day') AND (p.status IS NULL OR p.status != 'returned') ORDER BY p.created_at DESC`).all(from, to);
  const salesAmount = r2(sales.amt), salesProfit = r2(sales.profit), purchaseAmount = r2(purchases.amt);
  res.json({
    period: label, label, from, to,
    salesAmount, salesProfit, purchaseAmount,
    saleCount: salesList.length, purchaseCount: purchList.length,
    estimatedProfit: r2(salesAmount - purchaseAmount),  // 预计利润：销售额 - 进货额（经营贡献估算）
    sales: salesList.map(r => ({ bill_no: r.bill_no, party: r.party || '散客', total: r2(r.total), profit: r2(r.profit || 0), deposit: r2(r.deposit || 0), received: r2(r.received), outstanding: r2(r.total - r.received), created_at: r.created_at })),
    purchases: purchList.map(r => ({ bill_no: r.bill_no, party: r.party || '直采', total: r2(r.total), deposit: r2(r.deposit || 0), paid: r2(r.paid), outstanding: r2(r.total - r.paid), created_at: r.created_at }))
  });
});

// 报表导出：按当前所选日期段生成 Excel（.xlsx，多工作表）
// ==================== 退单报表 / 改价报表 ====================
// 统一的日期段解析：from/to 缺失时默认「本月 1 日 ~ 今天」，写反自动交换
function resolveRange(req) {
  let from = String(req.query.from || '').trim().slice(0, 10);
  let to = String(req.query.to || '').trim().slice(0, 10);
  if (!from) from = db.prepare(`SELECT date('now','localtime','start of month') AS d`).get().d;
  if (!to) to = db.prepare(`SELECT date('now','localtime') AS d`).get().d;
  if (from > to) { const t = from; from = to; to = t; }
  return { from, to };
}

// 采购/销售退单报表：已退单 + 退单待审（锁定中）
app.get('/api/reports/returns', requireAuth, (req, res) => {
  const { from, to } = resolveRange(req);
  const status = ['all', 'returned', 'pending'].includes(String(req.query.status || '')) ? String(req.query.status) : 'all';
  const kw = String(req.query.keyword || '').trim();

  const loadSide = (isPur) => {
    const [table, partyTable, fk, itemTable, itemFk, docType, fallback] = isPur
      ? ['purchases', 'suppliers', 'supplier_id', 'purchase_items', 'purchase_id', 'purchase', '直采（未指定供应商）']
      : ['sales', 'customers', 'customer_id', 'sale_items', 'sale_id', 'sale', '散客（未指定客户）'];
    const rows = db.prepare(`
      SELECT t.id, t.bill_no, t.total_amount, t.deposit, t.operator, t.created_at, t.status,
        COALESCE(t.return_reason,'') AS return_reason,
        COALESCE(t.returned_at,'') AS returned_at,
        COALESCE(t.returned_by,'') AS returned_by,
        COALESCE(t.return_requested_by,'') AS return_requested_by,
        COALESCE(t.return_requested_at,'') AS return_requested_at,
        COALESCE(t.return_approved_by,'') AS return_approved_by,
        COALESCE(t.return_rejected_by,'') AS return_rejected_by,
        COALESCE(p.name, ?) AS party,
        (SELECT GROUP_CONCAT(pr.name || ' ×' || ii.qty, '、')
           FROM ${itemTable} ii JOIN products pr ON pr.id = ii.product_id WHERE ii.${itemFk} = t.id) AS products,
        (SELECT COALESCE(SUM(amount),0) FROM payment_allocations WHERE doc_type = ? AND doc_id = t.id) AS settled
      FROM ${table} t LEFT JOIN ${partyTable} p ON p.id = t.${fk}
      WHERE t.status IN ('returned','pending_return')
      ORDER BY COALESCE(NULLIF(t.returned_at,''), NULLIF(t.return_requested_at,''), t.created_at) DESC
    `).all(fallback, docType);

    const list = rows.map(r => {
      const at = (r.returned_at || r.return_requested_at || r.created_at || '');
      return {
        id: r.id, bill_no: r.bill_no, party: r.party, products: r.products || '',
        total: r2(r.total_amount), deposit: r2(r.deposit), settled: r2(r.settled),
        status: r.status, statusText: r.status === 'returned' ? '已退单' : '退单待审',
        reason: r.return_reason || '',
        requested_by: r.return_requested_by || r.returned_by || '',
        requested_at: r.return_requested_at || r.returned_at || r.created_at || '',
        approved_by: r.return_approved_by || (r.status === 'returned' ? r.returned_by : '') || '',
        returned_at: r.returned_at || '',
        at: at.slice(0, 10), atFull: at.replace('T', ' '),
        operator: r.operator || ''
      };
    }).filter(r => {
      if (r.at && (r.at < from || r.at > to)) return false;
      if (status === 'returned' && r.status !== 'returned') return false;
      if (status === 'pending' && r.status !== 'pending_return') return false;
      if (kw) {
        const hay = `${r.bill_no} ${r.party} ${r.products}`.toLowerCase();
        if (!hay.includes(kw.toLowerCase())) return false;
      }
      return true;
    });

    const returnedList = list.filter(r => r.status === 'returned');
    const pendingList = list.filter(r => r.status === 'pending_return');
    return {
      list,
      count: list.length,
      amount: r2(list.reduce((s, r) => s + r.total, 0)),
      returnedCount: returnedList.length,
      returnedAmount: r2(returnedList.reduce((s, r) => s + r.total, 0)),
      pendingCount: pendingList.length,
      pendingAmount: r2(pendingList.reduce((s, r) => s + r.total, 0))
    };
  };

  const purchase = loadSide(true);
  const sale = loadSide(false);
  res.json({
    from, to, period: `${from} ~ ${to}`, status, keyword: kw,
    purchase, sale,
    totals: {
      count: purchase.count + sale.count,
      amount: r2(purchase.amount + sale.amount),
      returnedCount: purchase.returnedCount + sale.returnedCount,
      returnedAmount: r2(purchase.returnedAmount + sale.returnedAmount),
      pendingCount: purchase.pendingCount + sale.pendingCount,
      pendingAmount: r2(purchase.pendingAmount + sale.pendingAmount)
    }
  });
});

// 改价报表：单据改价 / 商品调价 / 采购进价变动 / 收付款金额调整
app.get('/api/reports/price-changes', requireAuth, (req, res) => {
  const { from, to } = resolveRange(req);
  const type = ['all', 'doc', 'product', 'purchase'].includes(String(req.query.type || '')) ? String(req.query.type) : 'all';
  const kw = String(req.query.keyword || '').trim().toLowerCase();
  const inRange = (d) => { const x = (d || '').slice(0, 10); return !x || (x >= from && x <= to); };

  const list = [];

  // 1) 已留痕的改价：单据改价(doc) + 商品调价(product)
  if (type === 'all' || type === 'doc' || type === 'product') {
    const want = type === 'all' ? ['doc', 'product'] : [type];
    const rows = db.prepare(`SELECT * FROM price_logs WHERE log_type IN (${want.map(() => '?').join(',')})
      ORDER BY created_at DESC, id DESC LIMIT 3000`).all(...want);
    for (const r of rows) {
      if (!inRange(r.created_at)) continue;
      const oldP = r2(r.old_price), newP = r2(r.new_price), qty = Number(r.qty) || 0;
      list.push({
        id: 'L' + r.id,
        type: r.log_type,
        typeText: r.log_type === 'product' ? '商品调价' : (r.doc_type === 'purchase' ? '采购改价' : '销售改价'),
        at: (r.created_at || '').slice(0, 10),
        atFull: (r.created_at || '').replace('T', ' '),
        product_name: r.product_name || '',
        price_field: r.price_field,
        fieldText: r.price_field === 'purchase_price' ? '进货价' : '销售价',
        old_price: oldP, new_price: newP, diff: r2(newP - oldP),
        qty, amount: r2(r.diff_amount || 0),
        source: r.bill_no || (r.log_type === 'product' ? '商品管理' : ''),
        doc_type: r.doc_type || '', doc_id: r.doc_id || null,
        party: r.party_name || '', operator: r.operator || '', note: r.note || ''
      });
    }
  }

  // 2) 采购进价变动（历史全覆盖：按同一商品的采购序列，与前一次进价对比）
  if (type === 'all' || type === 'purchase') {
    const rows = db.prepare(`
      SELECT * FROM (
        SELECT pi.qty, pi.price, p.bill_no, p.created_at, p.operator, pr.name AS product_name,
          COALESCE(s.name, '直采（未指定供应商）') AS party,
          LAG(pi.price) OVER (PARTITION BY pi.product_id ORDER BY p.created_at, p.id) AS prev_price
        FROM purchase_items pi
        JOIN purchases p ON p.id = pi.purchase_id
        JOIN products pr ON pr.id = pi.product_id
        LEFT JOIN suppliers s ON s.id = p.supplier_id
        WHERE (p.status IS NULL OR p.status != 'returned')
      ) t
      WHERE prev_price IS NOT NULL AND ABS(price - prev_price) > 0.005
      ORDER BY created_at DESC`).all();
    for (const r of rows) {
      if (!inRange(r.created_at)) continue;
      const oldP = r2(r.prev_price), newP = r2(r.price), qty = Number(r.qty) || 0;
      list.push({
        id: 'P' + (r.bill_no || '') + (r.product_name || '') + oldP,
        type: 'purchase',
        typeText: '进价变动',
        at: (r.created_at || '').slice(0, 10),
        atFull: (r.created_at || '').replace('T', ' '),
        product_name: r.product_name || '',
        price_field: 'purchase_price', fieldText: '进货价',
        old_price: oldP, new_price: newP, diff: r2(newP - oldP),
        qty, amount: r2((newP - oldP) * qty),
        source: r.bill_no || '', doc_type: 'purchase', doc_id: null,
        party: r.party || '', operator: r.operator || '',
        note: newP > oldP ? '进价上调' : '进价下调'
      });
    }
  }

  const filtered = list.filter(r => {
    if (!kw) return true;
    return `${r.product_name} ${r.party} ${r.source} ${r.operator} ${r.note}`.toLowerCase().includes(kw);
  }).sort((a, b) => String(b.atFull).localeCompare(String(a.atFull)));

  const amountRows = filtered.filter(r => r.qty > 0);
  const upRows = filtered.filter(r => r.diff > 0);
  const downRows = filtered.filter(r => r.diff < 0);
  const summary = {
    count: filtered.length,
    upCount: upRows.length,
    downCount: downRows.length,
    upAmount: r2(amountRows.filter(r => r.amount > 0).reduce((s, r) => s + r.amount, 0)),
    downAmount: r2(amountRows.filter(r => r.amount < 0).reduce((s, r) => s + r.amount, 0)),
    netAmount: r2(amountRows.reduce((s, r) => s + r.amount, 0))
  };

  // 3) 收付款金额调整记录（调账，不是单价）
  const adjustments = db.prepare(`
    SELECT a.id, a.payment_id, a.old_amount, a.new_amount, a.reason, a.status,
      a.requested_by, a.requested_at, a.approved_by, a.approved_at, a.reject_reason,
      p.direction, p.party_type, p.party_id, p.is_deposit
    FROM payment_adjustments a JOIN payments p ON p.id = a.payment_id
    ORDER BY a.id DESC LIMIT 1000`).all().filter(a => inRange(a.requested_at) || inRange(a.approved_at)).map(a => {
      const pname = a.party_id
        ? (a.party_type === 'supplier'
          ? (db.prepare('SELECT name FROM suppliers WHERE id=?').get(a.party_id) || {}).name
          : (db.prepare('SELECT name FROM customers WHERE id=?').get(a.party_id) || {}).name)
        : '';
      return {
        id: a.id, payment_id: a.payment_id,
        at: (a.approved_at || a.requested_at || '').replace('T', ' '),
        directionText: a.direction === 'pay' ? '付款' : '收款',
        party: pname || (a.party_type === 'supplier' ? '直采（未指定供应商）' : '散客（未指定客户）'),
        old_amount: r2(a.old_amount), new_amount: r2(a.new_amount), diff: r2(a.new_amount - a.old_amount),
        status: a.status, statusText: a.status === 'pending' ? '待审' : (a.status === 'approved' ? '已通过' : '已驳回'),
        reason: a.reason || '', requested_by: a.requested_by || '', requested_at: (a.requested_at || '').replace('T', ' '),
        approved_by: a.approved_by || '', approved_at: (a.approved_at || '').replace('T', ' '),
        reject_reason: a.reject_reason || ''
      };
    });

  res.json({ from, to, period: `${from} ~ ${to}`, type, keyword: kw, summary, list: filtered, adjustments });
});

app.get('/api/reports/export', requireAuth, (req, res) => {
  const nowMonth = db.prepare(`SELECT strftime('%Y-%m','now','localtime') AS p`).get().p;
  let from = String(req.query.from || '').trim();
  let to = String(req.query.to || '').trim();
  const period = String(req.query.period || '').trim();
  if (!from && !to && period) {
    from = period + '-01';
    to = db.prepare(`SELECT date(?, '+1 month', '-1 day') AS d`).get(from).d;
  }
  if (!from) from = nowMonth + '-01';
  if (!to) to = db.prepare(`SELECT date('now','localtime') AS d`).get().d;
  if (from > to) { const tmp = from; from = to; to = tmp; }

  const ar = computeArAp();
  const money = (v) => r2(v || 0);
  const METHODS = { cash: '现金', bank: '银行转账', alipay: '支付宝', wechat: '微信', other: '其他' };

  const sales = db.prepare(`SELECT s.bill_no, c.name AS party, s.total_amount AS total, s.total_profit AS profit, s.deposit, s.created_at,
      COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE doc_type='sale' AND doc_id=s.id),0) AS received,
      (SELECT GROUP_CONCAT(pr.name,'、') FROM sale_items si JOIN products pr ON si.product_id=pr.id WHERE si.sale_id=s.id) AS products
    FROM sales s LEFT JOIN customers c ON s.customer_id=c.id
    WHERE s.created_at >= ? AND s.created_at < date(?, '+1 day') AND (s.status IS NULL OR s.status != 'returned')
    ORDER BY s.created_at DESC`).all(from, to);

  const purch = db.prepare(`SELECT p.bill_no, s.name AS party, p.total_amount AS total, p.deposit, p.created_at,
      COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE doc_type='purchase' AND doc_id=p.id),0) AS paid,
      (SELECT GROUP_CONCAT(pr.name,'、') FROM purchase_items pi JOIN products pr ON pi.product_id=pr.id WHERE pi.purchase_id=p.id) AS products
    FROM purchases p LEFT JOIN suppliers s ON p.supplier_id=s.id
    WHERE p.created_at >= ? AND p.created_at < date(?, '+1 day') AND (p.status IS NULL OR p.status != 'returned')
    ORDER BY p.created_at DESC`).all(from, to);

  const pays = db.prepare(`SELECT pay.created_at, pay.direction, pay.is_deposit, pay.amount, pay.method, pay.note, pay.operator,
      pay.party_type, pay.party_id,
      COALESCE((SELECT SUM(amount) FROM payment_allocations a WHERE a.payment_id=pay.id),0) AS alloc,
      (SELECT GROUP_CONCAT(doc_no, '、') FROM (
        SELECT CASE WHEN a.doc_type='purchase' THEN (SELECT bill_no FROM purchases WHERE id=a.doc_id)
                    ELSE (SELECT bill_no FROM sales WHERE id=a.doc_id) END AS doc_no
        FROM payment_allocations a WHERE a.payment_id=pay.id)) AS docs
    FROM payments pay
    WHERE pay.created_at >= ? AND pay.created_at < date(?, '+1 day')
    ORDER BY pay.created_at DESC`).all(from, to);
  // 单次导出给个硬上限：Excel 单表塞几十万行既打不开也拖垮内存，超限时宁可明确告诉用户缩短期
  const PAY_EXPORT_MAX = 50000;
  const paysTruncated = pays.length > PAY_EXPORT_MAX;
  if (paysTruncated) pays.length = PAY_EXPORT_MAX;

  const salesTotal = r2(sales.reduce((s, r) => s + r2(r.total), 0));
  const salesProfit = r2(sales.reduce((s, r) => s + r2(r.profit), 0));
  const purchTotal = r2(purch.reduce((s, r) => s + r2(r.total), 0));
  const sv = ar.stockValue || {};
  const PERIOD = `本期 ${from} ~ ${to}`;

  // 退单明细（采购 + 销售，含退单待审），按「退单/申请时间」落在期间内筛选
  // 时间口径：已审批完成的取 returned_at，仅到「待审」的才退回 return_requested_at。
  // 必须与 /api/reports/returns 用同一个顺序，否则跨月审批的退单在两处会落进不同月份。
  const retSql = (isPur) => isPur
    ? `SELECT '采购退单' AS side, t.bill_no,
         COALESCE(s.name,'直采（未指定供应商）') AS party, t.total_amount AS total, t.status,
         COALESCE(t.return_reason,'') AS reason,
         COALESCE(t.return_requested_by, t.returned_by, '') AS req_by,
         COALESCE(NULLIF(t.returned_at,''), NULLIF(t.return_requested_at,''), t.created_at) AS at,
         COALESCE(t.return_approved_by,'') AS appr_by,
         COALESCE(t.returned_at,'') AS ret_at,
         (SELECT GROUP_CONCAT(pr.name || ' ×' || pi.qty, '、') FROM purchase_items pi JOIN products pr ON pr.id=pi.product_id WHERE pi.purchase_id=t.id) AS products
       FROM purchases t LEFT JOIN suppliers s ON s.id=t.supplier_id
       WHERE t.status IN ('returned','pending_return')`
    : `SELECT '销售退单' AS side, t.bill_no,
         COALESCE(c.name,'散客（未指定客户）') AS party, t.total_amount AS total, t.status,
         COALESCE(t.return_reason,'') AS reason,
         COALESCE(t.return_requested_by, t.returned_by, '') AS req_by,
         COALESCE(NULLIF(t.returned_at,''), NULLIF(t.return_requested_at,''), t.created_at) AS at,
         COALESCE(t.return_approved_by,'') AS appr_by,
         COALESCE(t.returned_at,'') AS ret_at,
         (SELECT GROUP_CONCAT(pr.name || ' ×' || si.qty, '、') FROM sale_items si JOIN products pr ON pr.id=si.product_id WHERE si.sale_id=t.id) AS products
       FROM sales t LEFT JOIN customers c ON c.id=t.customer_id
       WHERE t.status IN ('returned','pending_return')`;
  const returnRows = db.prepare(retSql(true)).all().concat(db.prepare(retSql(false)).all())
    .map(r => ({ ...r, day: String(r.at || '').slice(0, 10) }))
    .filter(r => !r.day || (r.day >= from && r.day <= to))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));

  // 改价记录（商品调价 / 单据改价）
  // 期间筛选必须下推到 SQL：原来是「先取最近 5000 条再在内存里按日期过滤」，
  // 一旦某段时间内的改价超过 5000 条，早期的记录就被静默截掉，导出看起来是从某天开始的假象。
  const priceRows = db.prepare(`SELECT * FROM price_logs
    WHERE substr(COALESCE(created_at,''),1,10) >= ? AND substr(COALESCE(created_at,''),1,10) <= ?
    ORDER BY created_at DESC, id DESC`).all(from, to);

  const sheets = [
    {
      name: '报表概览',
      rows: [
        // 这一屏里「全量」和「本期」两套口径是混排的：应收/应付/库存是「截至此刻的余额快照」，
        // 一旦被当成期间数据，就会和下面的本期销售/采购相加得出错误结论。所以每行都标注口径。
        ['项目', '数值', '口径'],
        ['报表期间', `${from} ~ ${to}`, '—'],
        ['总应收（未收）', money(ar.totalReceivable), '全量：截至导出时刻的余额'],
        ['总应付（未付）', money(ar.totalPayable), '全量：截至导出时刻的余额'],
        ['净头寸（应收-应付）', money(ar.net), '全量：截至导出时刻的余额'],
        ['本期销售金额', salesTotal, PERIOD],
        ['本期销售利润（已实现）', salesProfit, PERIOD],
        ['本期采购金额', purchTotal, PERIOD],
        ['预计利润（销售额-进货额）', r2(salesTotal - purchTotal), PERIOD],
        ['库存商品总金额（成本）', money(sv.costValue), '全量：导出时刻的库存快照'],
        ['库存商品货值（售价）', money(sv.retailValue), '全量：导出时刻的库存快照'],
        ['库存总件数', Number(sv.qty) || 0, '全量：导出时刻的库存快照'],
        ['本期退单笔数', returnRows.length, PERIOD + '（按完成退单的时间）'],
        ['本期退单金额', r2(returnRows.reduce((s, r) => s + r2(r.total), 0)), PERIOD + '（按完成退单的时间）'],
        ['本期改价记录笔数', priceRows.length, PERIOD + '（按改价时间）'],
        ...(paysTruncated ? [['⚠ 收付款流水被截断', `本期间共超过 ${PAY_EXPORT_MAX} 笔，仅导出最近 ${PAY_EXPORT_MAX} 笔`, '建议缩短期后分批导出']] : []),
        ['导出时间', nowLocal(), '—']
      ]
    },
    {
      // 应收/应付是全量余额，不随上面的期间变化；sheet 名直接写清楚，避免被当成本期数
      name: '应收明细（按客户·全量）',
      rows: [
        ['客户', '总销售', '已收', '应收未收', '授信额度', '状态'],
        ...ar.customers.map(c => [
          c.name, c.total, c.received, c.receivable,
          c.credit_limit == null ? '—' : c.credit_limit,
          c.credit_limit == null ? '—' : (c.over_limit ? '超授信' : '正常')
        ]),
        ['合计', ar.sale.total, ar.sale.received, ar.sale.outstanding, '', '']
      ]
    },
    {
      name: '应付明细（按供应商·全量）',
      rows: [
        ['供应商', '总采购', '已付', '应付未付'],
        ...ar.suppliers.map(s => [s.name, s.total, s.paid, s.payable]),
        ['合计', ar.purchase.total, ar.purchase.paid, ar.purchase.outstanding]
      ]
    },
    {
      name: '本期采购明细',
      rows: [
        ['采购单号', '供应商', '商品名称', '总金额', '定金(约定)', '已付', '未付', '时间'],
        ...purch.map(p => [p.bill_no, p.party || '直采', p.products || '', r2(p.total), r2(p.deposit), r2(p.paid), r2(p.total - p.paid), p.created_at]),
        ['合计', '', '', purchTotal, '', '', '', '']
      ]
    },
    {
      name: '本期销售明细',
      rows: [
        ['销售单号', '客户', '商品名称', '总金额', '利润', '已收', '未收', '时间'],
        ...sales.map(s => [s.bill_no, s.party || '散客', s.products || '', r2(s.total), r2(s.profit), r2(s.received), r2(s.total - s.received), s.created_at]),
        ['合计', '', '', salesTotal, salesProfit, '', '', '']
      ]
    },
    {
      name: '库存商品（按分类·全量快照）',
      rows: [
        ['分类', '库存数量', '成本金额', '售价货值'],
        ...(sv.byCategory || []).map(c => [c.category, c.qty, money(c.costValue), money(c.retailValue)]),
        ['合计', Number(sv.qty) || 0, money(sv.costValue), money(sv.retailValue)]
      ]
    },
    {
      name: '收付款流水',
      rows: [
        ['时间', '类型', '往来单位', '分摊单据', '金额', '其中分摊', '转预存', '方式', '备注', '操作人'],
        ...pays.map(p => [
          p.created_at,
          p.is_deposit ? '定金' : (p.direction === 'pay' ? '采购付款' : '销售收款'),
          partyName(p.party_type, p.party_id),
          p.docs || '',
          r2(p.amount), r2(p.alloc), r2(p.amount - p.alloc),
          METHODS[p.method] || p.method || '', p.note || '', p.operator || ''
        ])
      ]
    },
    {
      name: '退单明细',
      rows: [
        ['类型', '单号', '往来单位', '商品', '单据金额', '状态', '退单原因', '申请人', '申请/退单时间', '审批人', '完成时间'],
        ...returnRows.map(r => [
          r.side, r.bill_no, r.party, r.products || '', r2(r.total),
          r.status === 'returned' ? '已退单' : '退单待审',
          r.reason || '', r.req_by || '', String(r.at || '').replace('T', ' '),
          r.appr_by || '', String(r.ret_at || '').replace('T', ' ')
        ]),
        ['合计', `${returnRows.length} 笔`, '', '', r2(returnRows.reduce((s, r) => s + r2(r.total), 0)), '', '', '', '', '', '']
      ]
    },
    {
      name: '改价记录',
      rows: [
        ['类型', '商品', '价格项', '原价', '新价', '单价差', '数量', '影响金额', '单号/来源', '往来单位', '操作人', '备注', '时间'],
        ...priceRows.map(r => {
          const oldP = r2(r.old_price), newP = r2(r.new_price);
          return [
            r.log_type === 'product' ? '商品调价' : (r.doc_type === 'purchase' ? '采购改价' : '销售改价'),
            r.product_name || '', r.price_field === 'purchase_price' ? '进货价' : '销售价',
            oldP, newP, r2(newP - oldP), Number(r.qty) || 0, r2(r.diff_amount),
            r.bill_no || (r.log_type === 'product' ? '商品管理' : ''), r.party_name || '',
            r.operator || '', r.note || '', String(r.created_at || '').replace('T', ' ')
          ];
        })
      ]
    }
  ];

  let buf;
  try {
    buf = buildWorkbook(sheets);
  } catch (e) {
    return res.status(500).json({ error: '生成 Excel 失败：' + e.message });
  }
  const fname = `经营报表_${from}_${to}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="report_${from}_${to}.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
});

// ---------- 数据体检 ----------
// 常驻自检：把「钱与货对不上」的典型症状一次查清楚。
// 之前的几次错账都是靠人工翻代码 + 写临时脚本才挖出来的，有了这个接口，随时能自查。
app.get('/api/health/check', requireAdmin, (req, res) => {
  const issues = [];
  const add = (level, code, title, detail, items, extra) => {
    if (items && items.length) issues.push({ level, code, title, detail, count: items.length, items: items.slice(0, 30), extra: extra || null });
  };

  // 1) 孤儿分摊：指向的单据已被删除（只可能来自手工改库或历史异常）
  add('error', 'orphan_alloc', '分摊指向的单据已不存在', '这些金额既不算已付也不算预存，会让往来账凭空少钱。',
    db.prepare(`SELECT a.id, a.payment_id, a.doc_type, a.doc_id, a.amount FROM payment_allocations a
      WHERE (a.doc_type='purchase' AND NOT EXISTS(SELECT 1 FROM purchases WHERE id=a.doc_id))
         OR (a.doc_type='sale' AND NOT EXISTS(SELECT 1 FROM sales WHERE id=a.doc_id))`).all()
      .map(r => ({ ...r, amount: r2(r.amount) })));

  // 2) 分摊合计超过单据总额（付超/收超）
  add('error', 'over_alloc', '单据被「付超 / 收超」', '分摊合计大于单据总额，会让应付/应收出现负数。',
    db.prepare(`SELECT * FROM (
        SELECT 'purchase' AS doc_type, a.doc_id, p.bill_no, p.total_amount, SUM(a.amount) AS alloc
          FROM payment_allocations a JOIN purchases p ON p.id=a.doc_id WHERE a.doc_type='purchase' GROUP BY a.doc_id
        UNION ALL
        SELECT 'sale' AS doc_type, a.doc_id, s.bill_no, s.total_amount, SUM(a.amount) AS alloc
          FROM payment_allocations a JOIN sales s ON s.id=a.doc_id WHERE a.doc_type='sale' GROUP BY a.doc_id
      ) WHERE alloc > total_amount + 0.01`).all()
      .map(r => ({ ...r, total_amount: r2(r.total_amount), alloc: r2(r.alloc) })));

  // 3) 已退单 / 退单待审的单据上仍挂着分摊
  //    已退单必须清零（钱要退回预存）；待审只是锁定，分摊保留是正常的，这里只报已退单
  add('error', 'returned_alloc', '已退单的单据上仍有分摊', '钱被钉在已经作废的单据上：往来账看不见、报表却扣掉，两边会对不上。',
    db.prepare(`SELECT a.id, a.payment_id, a.doc_type, a.doc_id, a.amount, d.bill_no
      FROM payment_allocations a
      JOIN (SELECT 'purchase' AS dt, id, status, bill_no FROM purchases
            UNION ALL SELECT 'sale' AS dt, id, status, bill_no FROM sales) d
        ON d.dt=a.doc_type AND d.id=a.doc_id
      WHERE d.status='returned'`).all().map(r => ({ ...r, amount: r2(r.amount) })));

  // 4) 负库存（销售出库/退单/作废都可能把库存压到 0 以下）
  add('error', 'negative_stock', '商品库存为负', '库存为负说明出库多于入库，成本与利润都会失真。',
    db.prepare('SELECT id, sku, name, stock FROM products WHERE stock < 0').all());

  // 5) 单据总额与明细合计不符
  add('error', 'bad_total', '单据总额与明细合计不符', '通常是历史数据或手工改库造成，报表与明细会对不上。',
    db.prepare(`SELECT 'purchase' AS doc_type, p.id, p.bill_no, p.total_amount AS total,
        COALESCE((SELECT SUM(subtotal) FROM purchase_items WHERE purchase_id=p.id),0) AS items_total
      FROM purchases p
      WHERE ABS(p.total_amount - COALESCE((SELECT SUM(subtotal) FROM purchase_items WHERE purchase_id=p.id),0)) > 0.01
      UNION ALL
      SELECT 'sale', s.id, s.bill_no, s.total_amount,
        COALESCE((SELECT SUM(subtotal) FROM sale_items WHERE sale_id=s.id),0)
      FROM sales s
      WHERE ABS(s.total_amount - COALESCE((SELECT SUM(subtotal) FROM sale_items WHERE sale_id=s.id),0)) > 0.01`).all()
      .map(r => ({ ...r, total: r2(r.total), items_total: r2(r.items_total) })));

  // 6) 收付款金额异常（<= 0）与分摊为 0/负
  add('error', 'bad_payment', '收付款金额不大于 0', '这类记录会让预存余额算错。',
    db.prepare('SELECT id, direction, party_type, party_id, amount, note FROM payments WHERE amount <= 0').all());
  add('error', 'bad_alloc', '分摊金额不大于 0', '这类分摊会让单据的已付金额算错。',
    db.prepare('SELECT id, payment_id, doc_type, doc_id, amount FROM payment_allocations WHERE amount <= 0').all());

  // 7) 往来单位已删除但收付款仍指向它（提醒：不是错，但归属查不到名字）
  add('warn', 'dangling_party', '收付款指向的往来单位不存在', '流水里会显示不出单位名称，建议把这些记录重新指定归属。',
    db.prepare(`SELECT p.id, p.direction, p.party_type, p.party_id, p.amount, p.created_at FROM payments p
      WHERE p.party_id IS NOT NULL AND (
        (p.party_type='customer' AND NOT EXISTS(SELECT 1 FROM customers WHERE id=p.party_id))
        OR (p.party_type='supplier' AND NOT EXISTS(SELECT 1 FROM suppliers WHERE id=p.party_id)))`).all()
      .map(r => ({ ...r, amount: r2(r.amount) })));

  // 8) 库存与流水累计的差额（info）：系统启用前录入的期初库存没有流水，会天然有差额，只做提示
  const drift = db.prepare(`SELECT p.id, p.sku, p.name, p.stock, COALESCE(SUM(l.change_qty),0) AS flow
    FROM products p LEFT JOIN stock_logs l ON l.product_id = p.id
    GROUP BY p.id HAVING ABS(p.stock - COALESCE(SUM(l.change_qty),0)) > 0.001
    ORDER BY ABS(p.stock - COALESCE(SUM(l.change_qty),0)) DESC`).all()
    .map(r => ({ ...r, stock: r2(r.stock), flow: r2(r.flow), diff: r2(r.stock - r.flow) }));
  add('info', 'stock_drift', '库存与出入库流水累计有差额', '差额通常来自系统启用前录入的期初库存；若差额与期初不符，说明有未经流水的库存变动。', drift);

  // 9) 同一单位「既有未结清单据、又有预存余额」
  //    这是最容易让老板误判的两头账：客户明明交过钱，系统还在挂应收催款。
  //    正常流程里预存一产生就会被冲抵（退单/收款/改归属都会触发），所以这里出现基本就是历史遗留。
  const twoWay = [];
  const scanTwoWay = (partyType, docType) => {
    const tbl = docType === 'purchase' ? 'purchases' : 'sales';
    const col = docType === 'purchase' ? 'supplier_id' : 'customer_id';
    const adv = advanceMapOf(partyType);
    if (!adv.size) return;
    const rows = db.prepare(`SELECT * FROM (
        SELECT ${col} AS pid, SUM(total_amount - COALESCE((SELECT SUM(amount) FROM payment_allocations
          WHERE doc_type=? AND doc_id=d.id),0)) AS owe
        FROM ${tbl} d WHERE ${col} IS NOT NULL AND (status IS NULL OR status='active')
        GROUP BY ${col}
      ) WHERE owe > 0.01`).all(docType);
    for (const r of rows) {
      const a = r2(adv.get(r.pid) || 0);
      if (a > 0.01) twoWay.push({
        party_type: partyType, party_id: r.pid, name: partyName(partyType, r.pid),
        outstanding: r2(r.owe), advance: a,
        hint: `预存 ${r2(a).toFixed(2)} 可抵欠款 ${r2(r.owe).toFixed(2)}`
      });
    }
  };
  scanTwoWay('customer', 'sale');
  scanTwoWay('supplier', 'purchase');
  add('warn', 'two_way', '同一单位既有欠款、又有预存余额', '钱和欠款并存：客户以为付过了，系统却还在催款。可用「仅做抵扣」把预存冲抵欠款。', twoWay);

  // 10) 预存余额为负：分摊到单据上的钱，多于这笔收付款实际记录的钱
  //     advanceBalanceOf 会把它当 0（拿负数去抵扣等于凭空造钱），所以平时看不见。
  //     但账面缺口是真实存在的：典型成因是「金额调整」审批通过后把金额改小了，
  //     而已经分摊到单据上的钱没跟着缩回去。这里按单位还原真实余额，让缺口显性化。
  const negAdv = [];
  for (const [partyType, partyTbl, dir] of [['customer', 'customers', 'receive'], ['supplier', 'suppliers', 'pay']]) {
    const rows = db.prepare(`SELECT p.party_id AS pid,
        SUM(p.amount - COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE payment_id=p.id),0)) AS bal
      FROM payments p JOIN ${partyTbl} t ON t.id = p.party_id
      WHERE p.party_type=? AND p.party_id IS NOT NULL AND p.direction=? AND p.amount > 0
      GROUP BY p.party_id HAVING bal < -0.01`).all(partyType, dir);
    for (const r of rows) negAdv.push({
      party_type: partyType, party_id: r.pid, name: partyName(partyType, r.pid), balance: r2(r.bal),
      hint: `账面缺口 ${Math.abs(r2(r.bal)).toFixed(2)}`
    });
  }
  add('error', 'negative_advance', '往来单位预存余额为负', '分摊出去的钱多于实际收付的钱，账面存在缺口。多由金额调整把金额改小但分摊未同步造成。', negAdv);

  // 11) 无归属收付款：party_id 为空的钱不属于任何往来单位，
  //     既不进任何一家的预存余额，也不参与自动抵扣，等于躺在账外。
  //     往来账能靠「分摊反推」把其中一部分认回去，认不回去的正是这里要人工处理的。
  add('warn', 'orphan_payment', '收付款未指定往来单位', '这些钱不计入任何单位的预存，财务页的预存合计会比实际收到的钱少。请到收付款页为其「指定归属」。',
    db.prepare(`SELECT p.id, p.direction, p.amount, p.method, p.note, p.operator, p.created_at,
        COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE payment_id=p.id),0) AS alloc
      FROM payments p WHERE p.party_id IS NULL ORDER BY p.id DESC`).all()
      .map(r => ({ ...r, amount: r2(r.amount), alloc: r2(r.alloc), balance: r2(r.amount - r.alloc) }))
      .filter(r => r.balance > 0.001));

  const errors = issues.filter(i => i.level === 'error').length;
  res.json({
    checked_at: nowLocal(),
    ok: errors === 0,
    errors,
    warnings: issues.filter(i => i.level === 'warn').length,
    infos: issues.filter(i => i.level === 'info').length,
    issues,
    summary: {
      products: db.prepare('SELECT COUNT(*) AS c FROM products').get().c,
      purchases: db.prepare('SELECT COUNT(*) AS c FROM purchases').get().c,
      sales: db.prepare('SELECT COUNT(*) AS c FROM sales').get().c,
      payments: db.prepare('SELECT COUNT(*) AS c FROM payments').get().c,
      allocations: db.prepare('SELECT COUNT(*) AS c FROM payment_allocations').get().c
    }
  });
});

// 兜底：SPA 路由
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: '接口不存在' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 兜底错误处理：任何未捕获异常都返回 JSON（前端能弹出具体原因，而不是「500 空响应」）
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const msg = String((err && err.message) || '');
  const status = Number((err && (err.status || err.statusCode)) || 0);

  // 请求体解析失败（express.json 抛的 SyntaxError，自带 status=400）：这是客户端问题，
  // 原本会被下面的兜底吞成 500，让前端误以为「服务器坏了」，其实只是 JSON 不合法。
  if (status >= 400 && status < 500) {
    return res.status(400).json({ error: '请求数据格式不正确（JSON 不合法或字段类型不符）' });
  }
  if (msg.includes('FOREIGN KEY')) {
    return res.status(400).json({ error: '该记录仍被其他数据引用（如单据、流水），不能删除' });
  }
  if (msg.includes('UNIQUE')) {
    return res.status(400).json({ error: '存在重复数据，请检查编号或名称后重试' });
  }
  // 兜底 500 不再把异常原文回传前端：原文里通常带 SQL 列名、表名、绝对路径，
  // 对使用者毫无用处，却把内部结构送了出去。原文只留在服务端日志，用同一时间戳对照。
  const at = new Date().toLocaleString('zh-CN', { hour12: false });
  console.error(`[api] 未处理异常 @${at}:`, err && err.stack ? err.stack : msg);
  res.status(500).json({ error: `服务器内部错误（已记录日志 ${at}），请把该时间告知管理员` });
});

// 每天首次启动自动备份一份到 data/backups，只保留最近 7 份（不阻塞启动）
function autoBackupDaily() {
  try {
    const dbFile = process.env.INVENTORY_DB || path.join(__dirname, 'data', 'inventory.db');
    const dir = path.join(path.dirname(dbFile), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const list = () => fs.readdirSync(dir).filter(f => /^auto-.*\.db$/.test(f)).sort();
    const today = stampNow().slice(0, 8);
    if (list().some(f => f.includes(today))) return;
    const dest = path.join(dir, `auto-${stampNow()}.db`);
    db.backup(dest).then(() => {
      const all = list();
      all.slice(0, Math.max(0, all.length - 7)).forEach(f => { try { fs.unlinkSync(path.join(dir, f)); } catch (e) {} });
      console.log(`[备份] 已自动备份数据库：${path.relative(__dirname, dest)}（保留最近 7 份）`);
    }).catch(e => console.log('[备份] 自动备份失败：' + e.message));
  } catch (e) { console.log('[备份] 自动备份跳过：' + e.message); }
}

// 一次性数据修复（幂等，靠 meta 标记）：历史退单释回的钱一直躺在预存里，没有冲抵该单位当时的欠款，
// 导致「一边挂应收、一边躺预收」。这里对每个还有预存余额的单位补做一次按时间顺序的冲抵。
// 只新增分摊、不改任何金额：总应收/应付与预存合计都不变，只是把钱指回具体单据。
function fixAdvanceNotApplied() {
  const KEY = 'apply_advance_open_v1';
  if (db.prepare('SELECT value FROM meta WHERE key=?').get(KEY)) return;
  // 没有任何未分摊余额 → 无需修复，直接打标记
  const hasAdv = db.prepare(`SELECT COUNT(*) c FROM payments p
    WHERE p.amount - COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE payment_id=p.id),0) > 0.01`).get().c;
  if (!hasAdv) {
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)').run(KEY, String(Date.now()));
    return;
  }
  // 改动账务前先在 backups 留一份「修复前」快照，出问题可原样回滚
  try {
    const dir = path.join(DATA_DIR, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `pre-advance-fix-${stampNow()}.db`);
    if (!fs.existsSync(dest)) db.prepare('VACUUM INTO ?').run(dest);
    console.log(`[修复] 已保存修复前快照：backups/${path.basename(dest)}`);
  } catch (e) { console.log('[修复] 修复前快照失败（继续执行）：' + e.message); }
  const pairs = db.prepare(`SELECT DISTINCT party_type, party_id FROM payments
    WHERE party_id IS NOT NULL AND direction IN ('pay','receive')`).all();
  const tx = db.transaction(() => {
    let total = 0, parties = 0;
    for (const p of pairs) {
      if (p.party_type !== 'supplier' && p.party_type !== 'customer') continue;
      const r = applyAdvanceToOpenDocs(p.party_type === 'supplier' ? 'purchase' : 'sale', p.party_type, p.party_id, {});
      if (r.applied > 0.001) { total = r2(total + r.applied); parties++; }
    }
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)').run(KEY, String(Date.now()));
    return { total, parties };
  });
  try {
    const r = tx();
    if (r.parties > 0) console.log(`[修复] 预收款/预付款冲抵欠款：${r.parties} 个单位，共冲抵 ${fmtMoney(r.total)}`);
  } catch (e) { console.log('[修复] 预存冲抵跳过：' + e.message); }
}

fixAdvanceNotApplied();

// ---- 运行环境自检：本项目必须单进程运行 ----
// 两个隐式前提决定了它不能用多进程方式部署：
//   ① better-sqlite3 直连本地文件，SQLite 同一时刻只允许一个写者；
//      多进程并发写会让 SQLITE_BUSY 急剧增加，即便有 busy_timeout 排队也比单进程慢得多。
//   ② express-session 默认把会话存在内存里，进程之间不共享，
//      多实例时用户会被负载均衡随机打到不同进程，表现为「刚登录就被踢出」。
// 这两点都不会报错、只会表现为偶发掉线和偶发 500，极难归因，所以在启动时就明确拦一道。
(function guardSingleProcess() {
  const hints = [];
  // PM2 cluster 模式会给每个实例设置不同的 NODE_APP_INSTANCE
  if (process.env.NODE_APP_INSTANCE !== undefined) hints.push(`NODE_APP_INSTANCE=${process.env.NODE_APP_INSTANCE}（PM2 多实例）`);
  if (process.env.instances !== undefined) hints.push('instances 环境变量已设置（疑似 PM2 cluster）');
  if (!hints.length) return;
  console.log('\n' + '='.repeat(62));
  console.log('[严重] 检测到疑似多进程部署环境：' + hints.join('；'));
  console.log('       本系统必须单进程运行，原因：');
  console.log('       1) SQLite 单写者，多进程会大量 SQLITE_BUSY 写失败；');
  console.log('       2) 会话存在内存里，多进程不共享，会导致频繁掉线。');
  console.log('       请改为单实例启动：pm2 start server.js -i 1（或直接 node server.js）。');
  console.log('='.repeat(62) + '\n');
})();

const server = app.listen(PORT, HOST, () => {
  const brand = getSettings().branding;
  console.log(`${brand.shopName}专用进销存 服务已启动：http://${HOST}:${PORT}`);
  console.log(`本机访问：http://127.0.0.1:${PORT}`);
  console.log('注意：本系统为单进程设计（SQLite 单写者 + 内存会话），请勿用 PM2 cluster 等多实例方式部署。');
  autoBackupDaily();
});

// 端口被占用时友好提示，而不是崩溃报红
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`\n[提示] 端口 ${PORT} 已被占用——服务很可能已经在运行了。`);
    console.log(`       请直接打开浏览器访问：http://127.0.0.1:${PORT}`);
    console.log(`       若需重启，请先关闭已运行的旧窗口/进程，再重新启动。\n`);
    process.exit(0);
  } else {
    throw err;
  }
});

// 优雅退出：Ctrl+C / 关窗 / kill 时先把 WAL 落盘并正常关闭数据库连接。
// 不加这段时，进程被结束时 data/ 下会留下 inventory.db-wal / -shm 残留文件
// （下次启动 SQLite 能自动恢复、不丢数据，但会让人误以为库坏了）。
// 说明：start.bat 里的 taskkill /f 属于强杀，收不到这个信号，此钩子对它无效——
// 那种情况下靠 SQLite 自身的 WAL 原子性保证不损坏，故仍需上面的「先校验再杀」。
let isClosing = false;
function gracefulExit(signal) {
  if (isClosing) return;
  isClosing = true;
  console.log(`\n[退出] 收到 ${signal}，正在关闭数据库…`);
  try { db.close(); } catch (e) { console.log('[退出] 关闭数据库失败：' + e.message); }
  process.exit(0);
}
process.on('SIGINT', () => gracefulExit('SIGINT'));
process.on('SIGTERM', () => gracefulExit('SIGTERM'));
