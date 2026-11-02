/* 天下第一家专用进销存 · 前端：原生 JS 单页应用，无构建步骤 */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const state = { user: null, view: 'dashboard', settings: null, branding: null, publicSplash: null, cache: { products: [], suppliers: [], customers: [] } };

  const BRAND_FALLBACK = { shopName: '天下第一家', welcomeText: '欢迎使用天下第一家的进销存系统' };

  const yuan = (n) => '¥' + Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const intf = (n) => Number(n || 0).toLocaleString('zh-CN');
  // 四舍五入到分 —— 必须与后端保持同一算法（后端的唯一实现在 lib/num.js）。
  // 两个坑都不能省，原理见 lib/num.js 顶部说明：
  //   ① 纠偏量要跟数值本身成正比（写成 +Number.EPSILON 这个绝对常量时，数值超过 2 就静默失效）；
  //   ② 要先取绝对值再补符号 —— Math.round(-100.5) 得 -100 而不是 -101，
  //      不处理的话 -1.005 会显示 ¥-1.00，而后端算 ¥-1.01，两边对不上。
  // 浏览器无法 require 那个模块，所以这里是刻意保留的一份等价副本，
  // 改动 lib/num.js 的算法时必须同步改这里。
  const r2 = (n) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return v;
    const sign = v < 0 ? -1 : 1;
    return sign * Math.round(Math.abs(v) * (1 + Number.EPSILON * 4) * 100) / 100;
  };
  const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // ---------- 提交防抖（集中守卫，不逐个按钮写） ----------
  // 场景：网络卡一下时用户会连点「保存」，同一张单被提交两次。
  // 后端有单号唯一约束和库存校验兜底，但用户会看到「已保存」两次、甚至弹出一次重复报错。
  // 这里收口到两个点，任何表单自动生效，不用在每个 handler 里记得写：
  //   ① api() 进出计数 —— 「是否还在忙」的唯一事实来源（所有请求都过这里）；
  //   ② document 捕获阶段的 submit 监听 —— 拦第二次提交，直到上一个请求真正回来。
  let pendingReqs = 0;
  // 极端兜底：万一请求永不返回（断网后 hang 住），也不能把按钮永久锁死
  const GUARD_MAX_MS = 30000;

  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    // 已经在处理上一次提交 → 直接吞掉这一次，连庆冒泡都不往下传
    if (form.dataset.submitting === '1') { e.preventDefault(); e.stopImmediatePropagation(); return; }
    const btn = form.querySelector('button[type="submit"]');
    if (!btn) return;
    form.dataset.submitting = '1';
    const oldText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '处理中…';
    const release = () => {
      clearInterval(timer); clearTimeout(hardStop);
      form.dataset.submitting = '0';
      btn.disabled = false; btn.textContent = oldText;
    };
    // 轮询到没有未完成的请求为止：handler 常常在 await api() 之后还要再拉一次列表刷新，
    // 所以按「请求计数归零」判定结束比按固定延时更准。
    const timer = setInterval(() => { if (pendingReqs === 0) release(); }, 60);
    const hardStop = setTimeout(release, GUARD_MAX_MS);
  }, true);   // 捕获阶段：先于任何 modal 内部注册的 submit handler 执行

  async function api(method, url, body) {
    const opt = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    pendingReqs++;
    try {
      const res = await fetch(url, opt);
      // 仅在「原本已登录、会话过期」时才跳回登录页；未登录的首次探测(如 /api/me)绝不刷新，避免无限刷新死循环
      if (res.status === 401) { if (state.user) location.reload(); throw new Error('未登录'); }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    } finally {
      pendingReqs = Math.max(0, pendingReqs - 1);
    }
  }

  function toast(msg, isErr) {
    const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : '');
    t.hidden = false; clearTimeout(t._t);
    // 文字越长停留越久，避免「读不完就消失」
    const ms = Math.min(9000, 2200 + String(msg || '').length * 60);
    t._t = setTimeout(() => (t.hidden = true), ms);
  }

  function modal(html, cls) {
    const host = $('#modal-root');
    host.innerHTML = `<div class="modal-mask"><div class="modal${cls ? ' ' + cls : ''}">${html}</div></div>`;
    const mask = $('.modal-mask', host);
    const box = $('.modal', host);
    mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
    function close() { host.innerHTML = ''; }
    // 异步弹窗（先占位再填内容）必须写进 .modal 里，不能覆盖 #modal-root，
    // 否则会把 .modal-mask 一起冲掉 —— 弹窗就变成没有遮罩、没有居中的一坨裸 HTML。
    const set = (h) => { box.innerHTML = h; };
    return { host, root: host, box, set, close };
  }

  const TITLES = { dashboard: '仪表盘', products: '商品管理', purchase: '采购入库', sale: '销售出库', inventory: '库存管理', finance: '收付款', suppliers: '供应商', customers: '客户', reports: '报表', users: '用户管理', settings: '系统配置' };

  // ---------- 品牌（商店名称 / 欢迎语）----------
  function brand() {
    const b = state.branding || {};
    return {
      shopName: (b.shopName || BRAND_FALLBACK.shopName).trim(),
      welcomeText: (b.welcomeText || BRAND_FALLBACK.welcomeText).trim()
    };
  }
  function applyBranding() {
    const { shopName, welcomeText } = brand();
    const full = shopName + '专用进销存';
    const mark = [...shopName][0] || '天';
    document.title = full;
    const setText = (sel, txt) => { const el = $(sel); if (el) el.textContent = txt; };
    setText('#brand-title', full);        // 登录页标题
    setText('#login-mark', mark);
    setText('#side-mark', mark);          // 侧栏 logo 字
    setText('#side-name', shopName);      // 侧栏店名（下一行固定「专用进销存」）
    setText('#splash-mark', mark);
    setText('#splash-sub', shopName + ' · 专用进销存');
    const st = $('#splash-title');
    if (st && !st.dataset.typed) st.textContent = welcomeText;
  }
  // ---------- 全屏：系统启动后即以全屏方式播放开机画面并使用 ----------
  // 浏览器规定 requestFullscreen 必须由用户手势触发，故在首次点击/按键时进入全屏
  let fsArmed = false;
  function isFullscreen() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
  function enterFullscreen() {
    if (isFullscreen()) return;
    const el = document.documentElement;
    const fn = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!fn) return;
    try {
      const p = fn.call(el, { navigationUI: 'hide' });
      if (p && p.catch) p.catch(() => {});   // 环境不支持（如手机浏览器）时静默失败
    } catch (e) { /* 忽略 */ }
  }
  function exitFullscreen() {
    if (!isFullscreen()) return;
    const fn = document.exitFullscreen || document.webkitExitFullscreen;
    if (!fn) return;
    try { const p = fn.call(document); if (p && p.catch) p.catch(() => {}); } catch (e) { /* 忽略 */ }
  }
  function toggleFullscreen() { if (isFullscreen()) exitFullscreen(); else enterFullscreen(); }
  function updateFsUI() {
    const on = isFullscreen();
    const tip = $('#splash-fs');
    if (tip) tip.hidden = on;
    const btn = $('#fs-btn');
    if (btn) { btn.classList.toggle('on', on); btn.title = on ? '退出全屏（Esc）' : '进入全屏'; }
  }
  function armFullscreen() {
    if (fsArmed) return;
    fsArmed = true;
    const go = () => {
      document.removeEventListener('pointerdown', go, true);
      document.removeEventListener('keydown', go, true);
      enterFullscreen();
    };
    document.addEventListener('pointerdown', go, true);
    document.addEventListener('keydown', go, true);
  }
  document.addEventListener('fullscreenchange', updateFsUI);
  document.addEventListener('webkitfullscreenchange', updateFsUI);

  // ---------- 开机欢迎动画：逐字浮现 → 停留倒计时 → 淡出；空闲可循环 ----------
  const SPLASH_PLAY_MS = 2000;    // 动画本体（logo 弹入 + 逐字 + 进度条）播放时长
  let splashTimers = [];
  let splashShownAt = 0;   // 开机动画开始展示的时刻，用于"最短展示时间"保底
  let idleTimer = null;
  let statsTimer = null;
  let idleLooping = false;
  let lastActivity = Date.now();

  function clearSplashTimers() {
    splashTimers.forEach((t) => { clearTimeout(t); clearInterval(t); });
    splashTimers = [];
  }
  // 停留秒数 / 空闲等待分钟（配置缺省 6 秒 / 5 分钟；0 分钟=不进入空闲动画）
  function splashCfg() {
    const fromSettings = (state.settings && state.settings.splash) || null;
    const fromPublic = state.publicSplash || null;
    const s = fromSettings || fromPublic || {};
    const clamp = (v, min, max, d) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return d;
      return Math.min(max, Math.max(min, Math.round(n)));
    };
    return {
      duration: clamp(s.duration, 2, 30, 6),
      idleMinutes: clamp(s.idleMinutes, 0, 99, 5)
    };
  }

  // 播放一轮开机动画；loop=true 时本轮结束自动重播（空闲模式）
  function playSplash(textOverride, opts = {}) {
    const el = $('#splash');
    if (!el) return;
    splashShownAt = Date.now();
    const loop = !!opts.loop;
    const cfg = splashCfg();
    const duration = opts.duration ? Math.min(30, Math.max(2, Math.round(Number(opts.duration)))) : cfg.duration;
    const { shopName, welcomeText } = brand();
    const text = (textOverride || welcomeText || BRAND_FALLBACK.welcomeText).trim();

    clearSplashTimers();
    el.classList.add('managed');
    el.style.display = '';
    el.classList.remove('out', 'counting');
    el.dataset.loop = loop ? '1' : '';
    updateFsUI();   // 未全屏时显示「点击任意位置进入全屏」提示

    const markEl = $('#splash-mark');
    const subEl = $('#splash-sub');
    const titleEl = $('#splash-title');
    if (markEl) markEl.textContent = [...shopName][0] || '天';
    if (subEl) subEl.textContent = shopName + ' · 专用进销存';
    if (titleEl) {
      titleEl.dataset.typed = '1';
      titleEl.innerHTML = [...text].map((ch, i) =>
        `<span style="animation-delay:${(i * 0.045).toFixed(3)}s">${ch === ' ' ? '&nbsp;' : esc(ch)}</span>`
      ).join('');
    }
    // 进度条从头开始
    const bar = $('.splash-bar i', el);
    if (bar) { bar.style.animation = 'none'; void bar.offsetWidth; bar.style.animation = ''; }
    // 倒计时环复位并隐藏
    const countBox = $('#splash-count');
    const ring = $('#splash-ring');
    const num = $('#splash-num');
    if (countBox) countBox.hidden = true;
    if (ring) { ring.style.animation = 'none'; void ring.offsetWidth; }
    if (num) num.textContent = duration;
    const skipBtn = $('#splash-skip');
    if (skipBtn) skipBtn.hidden = loop;   // 循环模式靠"任意操作"退出，不显示跳过

    // ① 播放阶段结束 → 进入停留倒计时
    splashTimers.push(setTimeout(() => {
      el.classList.add('counting');
      if (countBox) countBox.hidden = false;
      if (ring) ring.style.animation = `splashRing ${duration}s linear forwards`;
      let left = duration;
      if (num) num.textContent = left;
      splashTimers.push(setInterval(() => {
        left -= 1;
        if (num) num.textContent = Math.max(left, 0);
      }, 1000));
    }, SPLASH_PLAY_MS));

    // ② 停留结束 → 循环重播 / 淡出
    splashTimers.push(setTimeout(() => {
      if (loop) playSplash(textOverride, { loop: true });
      else if (!opts.hold) hideSplash();   // hold=true 时由调用方在首屏数据就绪后主动 hideSplash，避免动画结束又空白加载
    }, SPLASH_PLAY_MS + duration * 1000));
  }

  function hideSplash() {
    const el = $('#splash');
    if (!el) return;
    clearSplashTimers();
    el.classList.add('managed');
    el.classList.remove('counting');
    el.classList.add('out');
    splashTimers.push(setTimeout(() => {
      el.style.display = 'none';
      el.classList.remove('out');
    }, 650));
  }

  // ---------- 空闲 → 循环播放开机动画，任意操作即返回原界面 ----------
  function scheduleIdle() {
    clearTimeout(idleTimer);
    idleTimer = null;
    const { idleMinutes } = splashCfg();
    if (!idleMinutes) return;                      // 0 = 不进入空闲动画
    idleTimer = setTimeout(() => {
      idleLooping = true;
      playSplash(null, { loop: true });
    }, idleMinutes * 60 * 1000);
  }
  function onUserActivity() {
    const now = Date.now();
    if (idleLooping) {                              // 动画循环中 → 立刻恢复原屏幕
      idleLooping = false;
      hideSplash();
      lastActivity = now;
      scheduleIdle();
      return;
    }
    if (now - lastActivity < 800) return;           // 节流：高频事件不必次次重置
    lastActivity = now;
    scheduleIdle();
  }
  function bindIdleWatch() {
    ['mousemove', 'mousedown', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll']
      .forEach((ev) => window.addEventListener(ev, onUserActivity, { passive: true, capture: true }));
    const skip = $('#splash-skip');
    if (skip) skip.onclick = (e) => { e.stopPropagation(); hideSplash(); };
    const fsTip = $('#splash-fs');
    if (fsTip) fsTip.onclick = (e) => { e.stopPropagation(); enterFullscreen(); };
  }

  // ---------- 启动 ----------
  // 登录成功后的初始化（不刷新页面，以保持全屏状态）
  async function startApp() {
    $('#login').hidden = true;
    $('#app').hidden = false;
    $('#user-name').textContent = state.user.displayName || state.user.username;
    try { state.settings = await api('GET', '/api/settings'); } catch { state.settings = null; }
    if (state.settings && state.settings.branding) { state.branding = state.settings.branding; applyBranding(); }
    applyMusicPlayer();                        // 按配置决定是否显示侧栏播放器
    scheduleIdle();                            // 用登录后的完整配置重新计时
    await refreshCache();
    bindNav();
    loadSidebarStats();
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = setInterval(loadSidebarStats, 60000);   // 每分钟刷新一次侧栏销售额
    await navigate('dashboard');   // 等仪表盘数据取回并渲染完成，boot 时据此对齐开机动画收尾时机
    updateFsUI();
  }

  async function boot() {
    // 先取公开配置（品牌 + 动画时长），保证登录页也有正确的商店名，并播放开机动画
    try {
      const r = await api('GET', '/api/public-settings');
      state.branding = r.branding || null;
      state.publicSplash = r.splash || null;
    } catch { state.branding = null; state.publicSplash = null; }
    applyBranding();
    bindIdleWatch();
    bindLogin();
    updateFsUI();
    armFullscreen();          // 首次点击/按键即切到全屏，之后一直在全屏下使用
    scheduleIdle();
    try {
      state.user = await api('GET', '/api/me');
    } catch { state.user = null; }
    const skip = !!sessionStorage.getItem('splash_skip');
    if (skip) sessionStorage.removeItem('splash_skip');
    if (!state.user) {
      // 未登录：开机动画走默认行为（到点自动让位给登录页）
      if (skip) { const el = $('#splash'); if (el) el.style.display = 'none'; }
      else playSplash();
      $('#login').hidden = false;
      return;
    }
    // 已登录：让开机动画与首屏数据加载重叠成一次体验——数据真正就绪且最短展示时间已过，才淡出动画，
    // 避免「动画结束→空白→再加载」的二次加载观感。hold:true 表示隐藏时机交给这里主动调用 hideSplash。
    if (skip) { const el = $('#splash'); if (el) el.style.display = 'none'; await startApp(); return; }
    playSplash(null, { hold: true });
    try { await startApp(); } catch (e) { /* 即便首屏加载失败也不让开机动画卡死 */ }
    // 保底最短展示时间（欢迎语至少看一眼），然后才淡出
    const wait = Math.max(0, SPLASH_PLAY_MS - (Date.now() - splashShownAt));
    if (wait > 0) setTimeout(hideSplash, wait); else hideSplash();
  }

  // 系统配置里的普通用户操作权限（管理员始终允许）
  function perm(key) {
    if (state.user && state.user.role === 'admin') return true;
    const p = (state.settings && state.settings.permissions) || {};
    return p[key] !== false;
  }

  // 密码策略：simple 大小写不敏感/无复杂度；medium 大小写敏感/无复杂度；complex 复杂密码
  function pwdModeHint(mode) {
    if (mode === 'medium') return '当前：中等模式 · 登录区分大小写 · 新密码仍需 ≥ 6 位';
    if (mode === 'complex') return '当前：复杂模式 · 登录区分大小写 · 新密码需 ≥ 8 位且包含大写、小写、数字、符号中至少 3 类';
    return '当前：简单模式 · 登录不区分大小写 · 新密码只需 ≥ 6 位';
  }
  function pwdPolicy() {
    const m = (state.settings && state.settings.password && state.settings.password.mode) || 'simple';
    const mode = ['simple', 'medium', 'complex'].includes(m) ? m : 'simple';
    if (mode === 'complex') {
      return {
        mode,
        minLen: 8,
        label: '复杂模式',
        labelText: '密码（至少 8 位）',
        hint: '需≥8位，且包含大写字母、小写字母、数字、符号中的至少 3 类'
      };
    }
    return {
      mode,
      minLen: 6,
      label: mode === 'medium' ? '中等模式' : '简单模式',
      labelText: '密码（至少 6 位）',
      hint: mode === 'medium'
        ? '≥6 位，大小写敏感（输入时区分大小写）'
        : '≥6 位，大小写不敏感（不区分大小写）'
    };
  }

  function bindLogin() {
    // 用 onsubmit 赋值，可重复调用而不会重复绑定
    $('#login-form').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      enterFullscreen();            // 登录按钮即用户手势，顺手切到全屏
      $('#login-error').textContent = '';
      const btn = f.querySelector('button[type="submit"]');
      if (btn) btn.disabled = true;
      try {
        state.user = await api('POST', '/api/login', { username: f.username.value, password: f.password.value });
      } catch (err) {
        $('#login-error').textContent = err.message;
        if (btn) btn.disabled = false;
        return;
      }
      f.reset();
      try { await startApp(); } catch (err) { toast(err.message, true); }   // 不再整页刷新，全屏状态得以保持
      if (btn) btn.disabled = false;
    };
  }

  // 退出登录：同样不刷新页面，回到登录页并保持全屏
  async function doLogout() {
    try { await api('POST', '/api/logout'); } catch (e) { /* 会话可能已失效，忽略 */ }
    state.user = null;
    state.settings = null;
    state.cache = { products: [], suppliers: [], customers: [] };
    reportDrill = null;
    if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
    clearSplashTimers();
    clearTimeout(idleTimer); idleTimer = null;
    idleLooping = false;
    const sp = $('#splash');
    if (sp) { sp.style.display = 'none'; sp.classList.remove('out', 'counting'); }
    const box = $('#side-sales');
    if (box) { box.hidden = true; box.innerHTML = ''; }
    // 退出登录时停止背景音乐并隐藏播放器（插播广播与计时一并停止）
    stopBroadcastTimer();
    stopBroadcast();
    if (music.audio) music.audio.pause();
    const sm = $('#side-music');
    if (sm) sm.hidden = true;
    $('#app').hidden = true;
    $('#content').innerHTML = '';
    $('#topbar-actions').innerHTML = '';
    $('#login-error').textContent = '';
    const f = $('#login-form'); if (f) { f.reset(); }
    $('#login').hidden = false;
    updateFsUI();
  }

  let navBound = false;
  function bindNav() {
    if (!navBound) {
      navBound = true;
      // 事件委托：后续按角色增删的管理入口无需再绑事件
      $('.nav-list').addEventListener('click', (e) => {
        const li = e.target.closest('li[data-view]');
        if (!li) return;
        if (li.dataset.view === 'reports') reportDrill = null;
        navigate(li.dataset.view);
      });
      $('#logout-btn').onclick = doLogout;
      $('#pwd-btn').onclick = openPasswordModal;
      const fsBtn = $('#fs-btn');
      if (fsBtn) fsBtn.onclick = toggleFullscreen;
      const mUser = $('#m-user');
      if (mUser) mUser.onclick = openAccountModal;
    }
    // 每次进入按角色重建管理员入口（换账号登录也正确）
    $$('.nav-list li[data-admin="1"]').forEach((li) => li.remove());
    if (state.user && state.user.role === 'admin') {
      [['users', '👥 用户管理'], ['settings', '⚙️ 系统配置']].forEach(([view, text]) => {
        const li = document.createElement('li');
        li.dataset.view = view;
        li.dataset.admin = '1';
        li.textContent = text;
        $('.nav-list').appendChild(li);
      });
    }
  }

  async function refreshCache() {
    const [products, suppliers, customers] = await Promise.all([
      api('GET', '/api/products'), api('GET', '/api/suppliers'), api('GET', '/api/customers')
    ]);
    state.cache = { products, suppliers, customers };
  }

  async function navigate(view) {
    state.view = view;
    $$('.nav-list li').forEach((li) => li.classList.toggle('active', li.dataset.view === view));
    $('#view-title').textContent = TITLES[view] || '';
    $('#topbar-actions').innerHTML = '';
    const renders = { dashboard: renderDashboard, products: renderProducts, purchase: renderPurchase, sale: renderSale, inventory: renderInventory, finance: renderFinance, suppliers: renderSuppliers, customers: renderCustomers, reports: renderReports, users: renderUsers, settings: renderSettings };
    // 等待本视图渲染完成（含数据取回），再刷新侧栏统计；boot 时靠这个 await 让首屏与开机动画对齐
    await (renders[view] || renderDashboard)();
    loadSidebarStats();
  }

  // ---------- 侧边栏销售额 ----------
  async function loadSidebarStats() {
    const box = $('#side-sales');
    if (!box) return;
    try {
      const r = await api('GET', '/api/sidebar-stats');
      if (r.settings) {
        state.settings = r.settings;
        if (r.settings.branding) { state.branding = r.settings.branding; applyBranding(); }
        applyMusicPlayer();   // 配置可能被其它端改动，跟随后台刷新同步播放器显隐
      }
      const v = (r.settings && r.settings.sidebarSales) || {};
      const rows = [];
      if (v.today !== false) rows.push(['今日销售额', r.stats.today]);
      if (v.month !== false) rows.push(['本月销售额', r.stats.month]);
      if (v.year !== false) rows.push(['本年累计', r.stats.year]);
      if (!rows.length) { box.hidden = true; box.innerHTML = ''; return; }
      box.innerHTML = rows.map(([k, val]) => `<div class="side-stat"><span class="k">${k}</span><span class="v">${yuan(val)}</span></div>`).join('');
      box.hidden = false;
    } catch (e) { /* 静默失败：侧栏统计不影响主流程 */ }
  }

  // ---------- 侧栏背景音乐播放器 ----------
  // 音乐目录固定为服务端 mp3/（不可配置）；用户把 .mp3 拷进该目录即可播放。
  const music = { box: null, audio: null, files: [], idx: 0, ready: false, loading: false };
  // 插播广播：与音乐播放状态无关，按间隔周期播 Broadcast/guangbo.mp3。
  // 用「按墙钟累加经过时间」而非一次性长定时器：暂停/改间隔都不需要重排计时，天然不会漂移。
  const bc = { audio: null, info: null, timer: null, elapsed: 0, lastAt: 0, playing: false, resumeMusic: false, blocked: false, fetchedAt: 0 };

  // 广播开关与间隔实时读配置，配置页保存后立刻生效（无需重建播放器）
  function bcOn() {
    const b = state.settings && state.settings.broadcast;
    return !!(b && b.enabled);
  }
  function bcInterval() {
    const b = state.settings && state.settings.broadcast;
    const n = b ? Number(b.interval) : NaN;
    return Number.isFinite(n) && n >= 30 ? Math.round(n) : 120;
  }
  function musicOn() {
    return !!(state.settings && state.settings.music && state.settings.music.enabled);
  }

  // 侧栏音频区：音乐与广播是两个独立开关，任一开启就要显示（只有音乐开关时是播放器，
  // 只有广播开关时是一条带倒计时的广播条）。广播不再依赖音乐是否在播放。
  function applyMusicPlayer(autoplay) {
    const box = $('#side-music');
    if (!box) return;
    const mOn = musicOn();
    if (!mOn && !bcOn()) {
      box.hidden = true;
      if (music.audio) music.audio.pause();
      stopBroadcastTimer();
      stopBroadcast();
      return;
    }
    box.hidden = false;
    if (!music.ready) { buildMusicPlayer(box, autoplay); return; }
    box.classList.toggle('no-music', !mOn);
    if (!mOn && music.audio) music.audio.pause();   // 关掉音乐开关后立刻静音，但广播继续按周期播
    startBroadcastTimer();
    if (mOn && !music.files.length && !music.loading) loadMusicList(false, autoplay);
    loadBroadcastInfo();
  }

  function buildMusicPlayer(box, autoplay) {
    box.innerHTML = `
      <div class="sm-head"><span>🎵 背景音乐</span><span class="sm-count" id="sm-count"></span></div>
      <div class="sm-track" id="sm-track">加载中…</div>
      <div class="sm-ctrl">
        <button type="button" class="sm-btn" id="sm-prev" title="上一首">⏮</button>
        <button type="button" class="sm-btn sm-play" id="sm-play" title="播放/暂停">▶</button>
        <button type="button" class="sm-btn" id="sm-next" title="下一首">⏭</button>
        <button type="button" class="sm-btn sm-refresh" id="sm-refresh" title="刷新列表（放入新文件后点此）">⟳</button>
      </div>
      <div class="sm-ctrl">
        <span class="sm-vol-label" title="音量">🔊</span>
        <input type="range" id="sm-vol" class="sm-vol" min="0" max="1" step="0.05" value="0.7" title="音量">
      </div>
      <div class="sm-tip sm-bc" id="sm-bc" hidden></div>
      <div class="sm-tip" id="sm-tip">把 .mp3 文件放入系统 mp3 目录即可播放</div>
      <audio id="sm-audio" preload="none"></audio>
      <audio id="sm-bc-audio" preload="auto"></audio>`;
    music.box = box;
    music.audio = box.querySelector('#sm-audio');
    music.ready = true;
    bc.audio = box.querySelector('#sm-bc-audio');
    const audio = music.audio;
    audio.addEventListener('ended', () => stepTrack(1, true));
    audio.addEventListener('play', () => { if (!bc.playing) setPlayIcon(true); });
    audio.addEventListener('pause', () => { if (!bc.playing) setPlayIcon(false); });
    audio.addEventListener('error', () => {
      const f = music.files[music.idx];
      const tip = box.querySelector('#sm-tip');
      if (tip && f) tip.textContent = `无法播放：${f.name}（请确认是有效的 mp3）`;
      setPlayIcon(false);
    });
    // 广播播完 / 播放失败 → 收尾并恢复音乐
    bc.audio.addEventListener('ended', endBroadcast);
    bc.audio.addEventListener('error', endBroadcast);
    box.querySelector('#sm-play').onclick = togglePlay;
    box.querySelector('#sm-prev').onclick = () => stepTrack(-1, false);
    box.querySelector('#sm-next').onclick = () => stepTrack(1, false);
    box.querySelector('#sm-refresh').onclick = () => { loadMusicList(true); loadBroadcastInfo(); };
    const vol = box.querySelector('#sm-vol');
    const sv = Number(localStorage.getItem('musicVol'));
    vol.value = Number.isFinite(sv) && sv >= 0 && sv <= 1 ? sv : 0.7;
    audio.volume = Number(vol.value);
    vol.oninput = () => {
      audio.volume = Number(vol.value);
      if (bc.audio) bc.audio.volume = Number(vol.value);   // 广播与音乐同一音量
      localStorage.setItem('musicVol', vol.value);
    };
    box.classList.toggle('no-music', !musicOn());   // 只开广播时隐藏音乐控件，只留广播条
    startBroadcastTimer();
    if (musicOn()) loadMusicList(false, autoplay);
    loadBroadcastInfo();
  }

  function trackTitle(f) { return String(f && f.name || '').replace(/\.mp3$/i, ''); }

  function setPlayIcon(playing) {
    const b = music.box && music.box.querySelector('#sm-play');
    if (!b) return;
    b.textContent = playing ? '⏸' : '▶';
    b.title = playing ? '暂停' : '播放';
  }

  function updateMusicMeta() {
    if (!music.box) return;
    const c = music.box.querySelector('#sm-count');
    const tip = music.box.querySelector('#sm-tip');
    if (c) c.textContent = music.files.length ? `${music.files.length} 首` : '';
    if (tip) tip.textContent = music.files.length ? '曲目来自系统 mp3 目录（固定）' : 'mp3 目录为空：请把 .mp3 文件放入系统 mp3 目录';
  }

  function cueTrack() {
    const f = music.files[music.idx];
    if (!f) return;
    music.audio.src = f.url;
    const t = music.box.querySelector('#sm-track');
    if (t) { t.textContent = trackTitle(f); t.title = f.name; }
    localStorage.setItem('musicTrack', f.name);
  }

  function tryPlay() {
    if (!music.files.length) return;
    if (!music.audio.getAttribute('src')) cueTrack();
    const p = music.audio.play();
    if (p && p.catch) p.catch(() => {
      setPlayIcon(false);
      const tip = music.box && music.box.querySelector('#sm-tip');
      if (tip) tip.textContent = '浏览器阻止了自动播放，请点击 ▶ 开始播放';
    });
  }

  function togglePlay() {
    if (!music.files.length) { loadMusicList(false, false); return; }
    if (bc.playing) { endBroadcast(); return; }   // 广播中点播放键 = 跳过广播，接着放音乐
    if (music.audio.paused) tryPlay(); else music.audio.pause();
  }

  function stepTrack(delta, forcePlay) {
    if (!music.files.length) return;
    const wasBc = bc.playing;
    if (wasBc) stopBroadcast();                   // 切歌时中止正在播的广播
    const wasPlaying = !music.audio.paused || wasBc;
    music.idx = (music.idx + delta + music.files.length) % music.files.length;
    cueTrack();
    if (forcePlay || wasPlaying) tryPlay();
  }

  async function loadMusicList(keepCurrent, autoplay) {
    if (music.loading) return;
    music.loading = true;
    try {
      const r = await api('GET', '/api/music/list');
      const prevName = keepCurrent && music.files[music.idx] ? music.files[music.idx].name : null;
      music.files = r.files || [];
      updateMusicMeta();
      if (!music.files.length) {
        music.audio.pause();
        music.audio.removeAttribute('src');
        music.idx = 0;
        const t = music.box.querySelector('#sm-track');
        if (t) t.textContent = '暂无音乐';
        setPlayIcon(false);
        return;
      }
      let i = prevName ? music.files.findIndex((f) => f.name === prevName) : -1;
      if (i < 0) i = Math.min(music.idx, music.files.length - 1);
      music.idx = i;
      if (!prevName || music.files[i].name !== prevName) cueTrack();
      else {
        const t = music.box.querySelector('#sm-track');
        if (t) t.textContent = trackTitle(music.files[i]);
      }
      if (autoplay) tryPlay();
    } catch (e) {
      if (music.box) {
        const t = music.box.querySelector('#sm-track');
        if (t) t.textContent = '音乐列表加载失败';
        const tip = music.box.querySelector('#sm-tip');
        if (tip) tip.textContent = e.message || '请检查服务是否正常';
      }
    } finally {
      music.loading = false;
    }
  }

  // ---------- 插播广播 ----------
  // 广播开关**独立生效**：不论背景音乐是否在播（甚至音乐开关是关闭的），
  // 每累计满 interval 秒就播一次 Broadcast/guangbo.mp3；若此刻音乐正在播，先暂停它，广播结束再续播。
  // 广播文件缺失则静默跳过，不打断任何东西。
  function startBroadcastTimer() {
    if (bc.timer) return;
    bc.elapsed = 0;
    bc.lastAt = Date.now();
    bc.timer = setInterval(bcTick, 1000);
  }

  function stopBroadcastTimer() {
    if (bc.timer) { clearInterval(bc.timer); bc.timer = null; }
    bc.elapsed = 0;
  }

  function bcTick() {
    const now = Date.now();
    // 按实际经过时间累计（而非「每隔一秒 +1」）：浏览器后台节流 setInterval 时也不会把插播时间拖长
    // 注意用 > 0 判断而非 || ：lastAt 初值为 0，用 || 会把它当成"无值"取 now，白丢第一个 tick
    const last = bc.lastAt > 0 ? bc.lastAt : now;
    const delta = Math.min(5, Math.max(0, (now - last) / 1000));
    bc.lastAt = now;
    if (!bcOn()) { bc.elapsed = 0; updateBcStatus(); return; }   // 关闭时清零，重新开启从 0 计时
    // 与音乐状态无关：只要当前没在播广播就继续累计（音乐没开也照常插播）
    if (!bc.playing) {
      bc.elapsed += delta;
      if (bc.elapsed >= bcInterval()) { fireBroadcast(); return; }
    }
    // 每 60 秒顺带刷新一次广播文件信息：新增/替换 guangbo.mp3 后即使音乐没开也能自动生效
    if (now - (bc.fetchedAt || 0) > 60000) loadBroadcastInfo();
    updateBcStatus();
  }

  function fireBroadcast() {
    bc.elapsed = 0;
    bc.lastAt = Date.now();
    bc.blocked = false;
    const info = bc.info;
    if (!info || !info.exists || !info.url || !bc.audio) { updateBcStatus(); return; }   // 没文件：跳过本次
    bc.playing = true;
    // 只有音乐此刻真的在播，广播结束后才需要续播；音乐没开就只是播完广播
    bc.resumeMusic = musicOn() && !!music.audio && !music.audio.paused;
    bc.audio.volume = music.audio ? music.audio.volume : 0.7;
    bc.audio.src = info.url;
    try { bc.audio.currentTime = 0; } catch (e) { /* 尚未就绪，忽略 */ }
    if (music.audio && !music.audio.paused) music.audio.pause();
    updateBcStatus();
    const p = bc.audio.play();
    if (p && p.catch) p.catch(() => {
      bc.blocked = true;      // 浏览器拒绝自动播放：本次跳过，下个周期再试，并提示用户点一下页面
      endBroadcast();
    });
  }

  // 广播结束（播完 / 出错 / 被用户跳过）：原先在播的音乐续播
  function endBroadcast() {
    if (!bc.playing || !bc.audio) return;
    const resume = bc.resumeMusic;
    bc.playing = false;
    bc.resumeMusic = false;
    bc.elapsed = 0;
    bc.lastAt = Date.now();
    try { bc.audio.pause(); } catch (e) { /* 忽略 */ }
    bc.audio.removeAttribute('src');
    updateBcStatus();
    if (resume && musicOn()) tryPlay();
  }

  // 强制中止广播且不恢复音乐（关闭音乐、退出登录时用）
  function stopBroadcast() {
    if (!bc.playing || !bc.audio) return;
    bc.playing = false;
    bc.resumeMusic = false;
    bc.elapsed = 0;
    try { bc.audio.pause(); } catch (e) { /* 忽略 */ }
    bc.audio.removeAttribute('src');
    updateBcStatus();
  }

  async function loadBroadcastInfo(force) {
    if (!music.box) return;
    // 侧栏统计每次导航都会调到这里，8 秒内复用上次结果，避免无谓请求
    if (!force && bc.info && Date.now() - (bc.fetchedAt || 0) < 8000) { updateBcStatus(); return; }
    bc.fetchedAt = Date.now();
    try { bc.info = await api('GET', '/api/broadcast/info'); }
    catch (e) { bc.info = null; }
    updateBcStatus();
  }

  function updateBcStatus() {
    const el = music.box && music.box.querySelector('#sm-bc');
    if (!el) return;
    if (!bcOn()) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    const iv = bcInterval();
    if (bc.playing) { el.textContent = '📢 正在插播广播…'; el.title = 'Broadcast/guangbo.mp3'; return; }
    const info = bc.info;
    if (!info) { el.textContent = '📢 插播广播：状态读取中…'; return; }
    if (!info.exists) {
      el.textContent = '📢 未找到 Broadcast/guangbo.mp3，插播已跳过';
      el.title = '请把 guangbo.mp3 放到系统 Broadcast 目录';
      return;
    }
    if (bc.blocked) {
      el.textContent = '📢 浏览器阻止了自动播放，点一下页面任意处即可继续插播';
      el.title = '浏览器要求先有用户操作才允许播放声音';
      return;
    }
    // 倒计时向上取整：只显示整数秒，且不会出现「还有 0 秒」却仍在等待的情况
    const left = Math.max(0, Math.ceil(iv - bc.elapsed));
    el.textContent = `📢 广播每 ${iv} 秒插播一次（还有 ${left} 秒）`;
    el.title = 'Broadcast/guangbo.mp3';
  }

  // ---------- 系统配置（管理员） ----------
  async function renderSettings() {
    $('#topbar-actions').innerHTML = '';
    let s;
    try { s = await api('GET', '/api/settings'); } catch (e) { toast(e.message, true); return; }
    const v = s.sidebarSales || {};
    const p = s.permissions || {};
    const bd = s.branding || BRAND_FALLBACK;
    const sp = s.splash || { duration: 6, idleMinutes: 5 };
    const pd = s.password || { mode: 'simple' };
    const ms = s.music || { enabled: false };
    const bcfg = s.broadcast || { enabled: false, interval: 120 };
    $('#content').innerHTML = `
      <div class="card">
        <div class="card-title">品牌与开机动画</div>
        <p class="settings-desc">商店名称显示在登录页标题与左侧菜单顶部，格式为「商店名称 + 专用进销存」；欢迎语为开机动画的文字。</p>
        <div class="form-row">
          <div class="field">
            <label>商店名称</label>
            <input id="bd-shop" maxlength="20" value="${esc(bd.shopName)}" placeholder="天下第一家">
            <div class="field-hint" id="bd-hint">页面将显示为「${esc(bd.shopName)}专用进销存」</div>
          </div>
          <div class="field">
            <label>开机欢迎语</label>
            <input id="bd-welcome" maxlength="60" value="${esc(bd.welcomeText)}" placeholder="欢迎使用天下第一家的进销存系统">
            <div class="field-hint">逐字浮现，建议 8~20 个字</div>
          </div>
        </div>
        <div class="form-row" style="margin-top:14px">
          <div class="field">
            <label>开机画面停留（秒）</label>
            <input id="sp-duration" type="number" min="2" max="30" step="1" value="${sp.duration}">
            <div class="field-hint">动画播完后停留并显示倒计时，2 ~ 30 秒</div>
          </div>
          <div class="field">
            <label>空闲自动播放等待（分钟）</label>
            <input id="sp-idle" type="number" min="0" max="99" step="1" value="${sp.idleMinutes}">
            <div class="field-hint">无操作超过该时长即循环播放开机动画，任意操作恢复原界面；0 = 不播放，最大 99 分钟</div>
          </div>
        </div>
        <button type="button" class="btn-ghost small" id="bd-preview" style="margin-top:14px">▶ 预览开机动画</button>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-title">操作权限 · 普通用户</div>
        <p class="settings-desc">控制普通用户能否退单、能否调整收付款金额。取消勾选后普通用户的操作按钮将被禁用，仅管理员可执行；该配置对全部普通账号生效。</p>
        <div class="chk-list">
          <label class="chk-row">
            <input type="checkbox" id="pm-return" ${p.userReturn !== false ? 'checked' : ''}>
            <span><b>允许普通用户退单</b><em>勾选后普通用户可发起退单申请（单据进入「退单待审」锁定，仍需管理员审批）；取消后普通用户无退单入口</em></span>
          </label>
          <label class="chk-row">
            <input type="checkbox" id="pm-adjust" ${p.userAdjustAmount !== false ? 'checked' : ''}>
            <span><b>允许普通用户调整收付款金额</b><em>勾选后普通用户可提交金额调整申请（需管理员审批）；取消后普通用户无调整入口</em></span>
          </label>
        </div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-title">登录密码策略</div>
        <p class="settings-desc">控制登录时密码是否区分大小写，以及设置新密码时的复杂度要求。该配置对全部账号生效，切换后立即作用于下一次登录与改密。</p>
        <div class="seg">
          <label><input type="radio" name="pmode" value="simple" ${(pd.mode || 'simple') === 'simple' ? 'checked' : ''}>
            <span><b>简单模式</b><small>大小写不敏感（ABC 与 abc 视为同一密码），无复杂度要求，长度 ≥ 6 位。默认</small></span></label>
          <label><input type="radio" name="pmode" value="medium" ${pd.mode === 'medium' ? 'checked' : ''}>
            <span><b>中等模式</b><small>大小写敏感，无复杂度要求，长度 ≥ 6 位</small></span></label>
          <label><input type="radio" name="pmode" value="complex" ${pd.mode === 'complex' ? 'checked' : ''}>
            <span><b>复杂模式</b><small>大小写敏感，需 ≥ 8 位且包含大写、小写、数字、符号中的至少 3 类</small></span></label>
        </div>
        <div class="field-hint" id="pmode-hint">${esc(pwdModeHint(pd.mode || 'simple'))}</div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-title">侧栏背景音乐</div>
        <p class="settings-desc">勾选后，左侧菜单栏「系统配置」下方显示播放器。音乐文件目录固定为系统根目录下的 <code>mp3</code> 文件夹（不可更改）：把 <code>.mp3</code> 文件拷贝进该目录即可播放，无需在此上传。该配置对全部账号生效。</p>
        <div class="chk-list">
          <label class="chk-row">
            <input type="checkbox" id="set-music" ${ms.enabled ? 'checked' : ''}>
            <span><b>显示背景音乐播放器</b><em>开启后在左侧菜单显示播放器，可播放/暂停、上一首/下一首、调节音量</em></span>
          </label>
        </div>
        <div class="field-hint" id="music-hint">音乐目录：<code>mp3</code>（系统固定目录）</div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-title">插播广播</div>
        <p class="settings-desc">开启后，每到一个间隔周期就插播一次广播：若此刻背景音乐正在播放，会先暂停音乐、广播播完自动接着放；音乐没在播（甚至音乐开关关闭）也照常按周期插播。广播文件目录固定为系统根目录下的 <code>Broadcast</code> 文件夹，文件名固定为 <code>guangbo.mp3</code>（均不可更改）：把文件拷进去即可生效，替换后无需重启（最长约 1 分钟自动生效）。</p>
        <div class="chk-list">
          <label class="chk-row">
            <input type="checkbox" id="set-bc" ${bcfg.enabled ? 'checked' : ''}>
            <span><b>启用插播广播</b><em>不论音乐是否在播放，每隔一个周期插播 Broadcast/guangbo.mp3；音乐在播时播完自动续播</em></span>
          </label>
        </div>
        <div class="form-row" style="margin-top:14px">
          <div class="field">
            <label>播放间隔（秒）</label>
            <input id="bc-interval" type="number" min="30" max="3600" step="10" value="${bcfg.interval}">
            <div class="field-hint">音乐每累计播放满该时长插播一次，30 ~ 3600 秒，默认 120 秒</div>
          </div>
          <div class="field">
            <label>广播文件状态</label>
            <div class="field-hint" id="bc-file-hint">检测中…</div>
          </div>
        </div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-title">左侧菜单 · 销售额显示</div>
        <p class="settings-desc">勾选后，左侧菜单栏下部会显示对应期间的销售额卡片；取消勾选即隐藏。该配置对全部账号生效。</p>
        <div class="chk-list">
          <label class="chk-row">
            <input type="checkbox" id="ss-today" ${v.today !== false ? 'checked' : ''}>
            <span><b>当天销售额</b><em>今日 0 点至今的销售合计（不含已退单）</em></span>
          </label>
          <label class="chk-row">
            <input type="checkbox" id="ss-month" ${v.month !== false ? 'checked' : ''}>
            <span><b>当月销售额</b><em>本月 1 日至今的销售合计（不含已退单）</em></span>
          </label>
          <label class="chk-row">
            <input type="checkbox" id="ss-year" ${v.year !== false ? 'checked' : ''}>
            <span><b>当年累计销售额</b><em>本年 1 月 1 日至今的销售合计（不含已退单）</em></span>
          </label>
        </div>
      </div>
      ${state.user && state.user.role === 'admin' ? `
      <div class="card" style="margin-top:16px">
        <div class="card-title">数据安全 · 备份</div>
        <p class="settings-desc">把当前全部数据（商品、单据、收付款、客户供应商、配置）打包成一个数据库文件下载保存。服务每天首次启动时也会自动备份一份，保留最近 7 天。</p>
        <div class="bak-row">
          <button type="button" class="btn-primary" id="bak-now">⬇ 立即备份并下载</button>
          <span class="field-hint" id="bak-hint"></span>
        </div>
        <p class="settings-desc" style="margin-top:10px">还原方法：先关闭服务，把备份文件改名为 <code>inventory.db</code>，覆盖 <code>data</code> 目录下的同名文件（并删除 <code>inventory.db-wal</code> / <code>inventory.db-shm</code>），再重新启动。</p>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-title">数据体检 <span class="tag gray" id="hc-tag">未检查</span></div>
        <p class="settings-desc">一次性核对账面上最容易出问题的地方：分摊是否挂在已退单的单据上、单据有没有被付超、库存有没有负数、单据总额与明细合计是否相符、收付款金额是否异常。</p>
        <div class="bak-row">
          <button type="button" class="btn-ghost" id="hc-run">开始体检</button>
          <span class="field-hint" id="hc-hint"></span>
        </div>
        <div id="hc-result" style="margin-top:12px"></div>
      </div>` : ''}
      <div class="modal-actions" style="justify-content:flex-start;margin-top:20px">
        <button class="btn-primary" id="save-settings">保存配置</button>
      </div>
      <p class="settings-desc" style="margin-top:12px">提示：销售额统计口径为「销售出库单金额合计」，与报表一致；退单待审的单据仍计入，已确认退单的不计入。品牌、动画与权限设置保存后立即生效；开机动画的停留时长在下次打开或刷新页面时按新设置播放。</p>`;
    // 广播文件检测：让管理员一眼看到 guangbo.mp3 是否就位
    (async () => {
      const hint = $('#bc-file-hint');
      if (!hint) return;
      try {
        const bi = await api('GET', '/api/broadcast/info');
        hint.textContent = bi.exists
          ? `✅ 已找到 Broadcast/guangbo.mp3（${(bi.size / 1048576).toFixed(2)} MB）`
          : '⚠️ 未找到 Broadcast/guangbo.mp3，插播将自动跳过';
      } catch (e) { hint.textContent = '广播文件状态读取失败'; }
    })();
    $('#bd-preview').onclick = () => {
      const t = $('#bd-welcome').value.trim();
      if (!t) toast('欢迎语为空，预览将使用已保存的文案');
      const d = parseInt($('#sp-duration').value, 10);
      if (!(d >= 2 && d <= 30)) return toast('停留时长请填写 2 ~ 30 秒', true);
      playSplash(t, { duration: d });
    };
    const bakBtn = $('#bak-now');
    if (bakBtn) {
      const bakHint = $('#bak-hint');
      const lastAt = localStorage.getItem('lastBackupAt');
      bakHint.textContent = lastAt ? `上次备份：${new Date(lastAt).toLocaleString('zh-CN')}` : '还没有手动备份过';
      bakBtn.onclick = async () => {
        bakBtn.disabled = true; bakHint.textContent = '正在打包数据…';
        try {
          const res = await fetch('/api/backup', { credentials: 'same-origin' });
          if (!res.ok) {
            const d = await res.json().catch(() => ({}));
            throw new Error(d.error || `备份失败（HTTP ${res.status}）`);
          }
          const blob = await res.blob();
          const cd = res.headers.get('Content-Disposition') || '';
          const mm = /filename\*=UTF-8''([^;]+)/i.exec(cd);
          const name = mm ? decodeURIComponent(mm[1]) : '进销存备份.db';
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = name;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
          localStorage.setItem('lastBackupAt', new Date().toISOString());
          bakHint.textContent = `已下载：${name}（${(blob.size / 1048576).toFixed(2)} MB）`;
        } catch (e) {
          bakHint.textContent = '';
          toast(e.message, true);
        } finally { bakBtn.disabled = false; }
      };
    }
    // 数据体检：把「钱与货对不上」的典型症状一次查出来
    const hcBtn = $('#hc-run');
    if (hcBtn) {
      const HC_COLS = {
        orphan_alloc: [['payment_id', '收付款#'], ['doc_type', '类型'], ['doc_id', '单据#'], ['amount', '金额']],
        over_alloc: [['doc_type', '类型'], ['bill_no', '单号'], ['total_amount', '单据总额'], ['alloc', '已分摊']],
        returned_alloc: [['bill_no', '单号'], ['doc_type', '类型'], ['amount', '分摊额']],
        negative_stock: [['sku', 'SKU'], ['name', '商品'], ['stock', '库存']],
        bad_total: [['doc_type', '类型'], ['bill_no', '单号'], ['total', '单据总额'], ['items_total', '明细合计']],
        bad_payment: [['id', '#'], ['direction', '方向'], ['amount', '金额'], ['note', '备注']],
        bad_alloc: [['id', '#'], ['payment_id', '收付款#'], ['amount', '金额']],
        dangling_party: [['id', '#'], ['party_type', '类型'], ['party_id', '单位#'], ['amount', '金额']],
        stock_drift: [['sku', 'SKU'], ['name', '商品'], ['stock', '当前库存'], ['flow', '流水累计'], ['diff', '差额']]
      };
      const LV = { error: ['danger', '需要处理'], warn: ['warn', '建议处理'], info: ['gray', '提示'] };
      const renderHc = (r) => {
        const tag = $('#hc-tag');
        tag.className = 'tag ' + (r.ok ? (r.errors ? 'danger' : (r.warnings ? 'warn' : 'ok')) : 'danger');
        tag.textContent = r.ok
          ? (r.warnings || r.infos ? `正常 · ${r.warnings + r.infos} 条提示` : '正常')
          : `${r.errors} 项需处理`;
        if (!r.issues.length) {
          return `<p class="muted" style="font-size:13px">✅ 未发现异常（商品 ${r.summary.products} · 采购单 ${r.summary.purchases} · 销售单 ${r.summary.sales} · 收付款 ${r.summary.payments} · 分摊 ${r.summary.allocations}）</p>`;
        }
        return r.issues.map((it) => {
          const [cls, label] = LV[it.level] || LV.info;
          const cols = HC_COLS[it.code] || [];
          const head = cols.map(([, t]) => `<th>${esc(t)}</th>`).join('');
          const DT = { purchase: '采购单', sale: '销售单' };
          const body = it.items.map((row) => `<tr>${cols.map(([k]) => {
            const raw = row[k];
            const v = k === 'doc_type' ? (DT[raw] || raw) : raw;
            const num = typeof v === 'number';
            return `<td class="${num ? 'num' : ''}">${esc(num ? Number(v).toLocaleString('zh-CN') : String(v == null ? '—' : v))}</td>`;
          }).join('')}</tr>`).join('');
          return `<div style="padding:12px 14px;border:1px solid var(--border);border-radius:12px;margin-bottom:10px">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <span class="tag ${cls}">${label}</span>
              <b>${esc(it.title)}</b>
              <span class="muted" style="font-size:12.5px">${it.count} 条${it.count > it.items.length ? `（仅显示前 ${it.items.length} 条）` : ''}</span>
            </div>
            <p class="muted" style="font-size:12.5px;margin:6px 0 8px">${esc(it.detail)}</p>
            ${cols.length ? `<div class="table-scroll" style="max-height:240px"><table class="log-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>` : ''}
          </div>`;
        }).join('');
      };
      hcBtn.onclick = async () => {
        hcBtn.disabled = true;
        $('#hc-hint').textContent = '正在检查…';
        try {
          const r = await api('GET', '/api/health/check');
          $('#hc-result').innerHTML = renderHc(r);
          $('#hc-hint').textContent = `检查完成：${String(r.checked_at || '').replace('T', ' ').slice(0, 19)}`;
        } catch (e) {
          $('#hc-hint').textContent = '';
          toast(e.message, true);
        } finally { hcBtn.disabled = false; }
      };
    }
    $('#save-settings').onclick = async (e) => {
      const btn = e.currentTarget; btn.disabled = true;
      const wasMusic = !!(state.settings && state.settings.music && state.settings.music.enabled);
      try {
        const modeEl = $('input[name="pmode"]:checked');
        const bcIv = parseInt($('#bc-interval').value, 10);
        if (!(bcIv >= 30 && bcIv <= 3600)) throw new Error('插播间隔请填写 30 ~ 3600 秒');
        state.settings = await api('PUT', '/api/settings', {
          branding: {
            shopName: $('#bd-shop').value.trim(),
            welcomeText: $('#bd-welcome').value.trim()
          },
          splash: {
            duration: parseInt($('#sp-duration').value, 10),
            idleMinutes: parseInt($('#sp-idle').value, 10)
          },
          permissions: {
            userReturn: $('#pm-return').checked,
            userAdjustAmount: $('#pm-adjust').checked
          },
          sidebarSales: {
            today: $('#ss-today').checked,
            month: $('#ss-month').checked,
            year: $('#ss-year').checked
          },
          password: { mode: modeEl ? modeEl.value : 'simple' },
          music: { enabled: $('#set-music').checked },
          broadcast: { enabled: $('#set-bc').checked, interval: bcIv }
        });
        state.branding = state.settings.branding;
        applyBranding();
        const bd2 = state.branding || BRAND_FALLBACK;
        const sp2 = state.settings.splash || { duration: 6, idleMinutes: 5 };
        $('#bd-shop').value = bd2.shopName;
        $('#bd-welcome').value = bd2.welcomeText;
        $('#sp-duration').value = sp2.duration;
        $('#sp-idle').value = sp2.idleMinutes;
        $('#bd-hint').textContent = `页面将显示为「${bd2.shopName}专用进销存」`;
        if ($('#pmode-hint') && state.settings.password) $('#pmode-hint').textContent = pwdModeHint(state.settings.password.mode);
        scheduleIdle();                    // 空闲等待时间可能变了，重新计时
        // 音乐开关即时生效：从关闭切到开启时尝试自动播放（保存动作属于用户手势，浏览器允许播放）
        applyMusicPlayer(!wasMusic && !!(state.settings.music && state.settings.music.enabled));
        loadBroadcastInfo(true);           // 广播开关/间隔改了就立刻反映到播放器提示
        toast(`配置已保存（停留 ${sp2.duration} 秒，空闲 ${sp2.idleMinutes ? sp2.idleMinutes + ' 分钟' : '不播放'}）`);
        await loadSidebarStats();
      } catch (err) { toast(err.message, true); }
      btn.disabled = false;
    };
    // 切换密码模式时即时显示对应说明
    $$('input[name="pmode"]').forEach(r => r.onchange = () => {
      if ($('#pmode-hint')) $('#pmode-hint').textContent = pwdModeHint(r.value);
    });
  }

  // ---------- 仪表盘 ----------
  // 待办提醒卡：只有确实存在待办时才显示，避免仪表盘堆砌
  function todoCard(t) {
    if (!t) return '';
    const isAdmin = state.user && state.user.role === 'admin';
    const items = [];
    if (isAdmin && t.returnCount > 0) {
      const brief = t.returns.slice(0, 2).map(r => `${r.bill_no} · ${r.party || '未指定'} · ${yuan(r.total_amount)}`).join('　');
      items.push({ ic: '⏳', title: `${t.returnCount} 张单据退单待审`, sub: brief + (t.returnCount > 2 ? ` 等 ${t.returnCount} 张` : ''), go: 'finance' });
    }
    if (isAdmin && t.adjustCount > 0) {
      items.push({ ic: '💴', title: `${t.adjustCount} 笔收付款金额调整待审`, sub: `合计变动 ${yuan(t.adjustDiff)}，审批后立即生效`, go: 'finance' });
    }
    if (t.lowStockCount > 0) {
      items.push({ ic: '📦', title: `${t.lowStockCount} 个商品库存已到下限`, sub: '仪表盘下方可直接勾选导出采购清单', go: 'alerts' });
    }
    if (!items.length) return '';
    return `<div class="card todo-card">
      <div class="card-title"><span>待办提醒 <span class="tag pending">${items.length} 类</span></span></div>
      <div class="todo-list">${items.map(i => `
        <div class="todo-item">
          <span class="todo-ic">${i.ic}</span>
          <div class="todo-main"><b>${esc(i.title)}</b><em>${esc(i.sub)}</em></div>
          <button type="button" class="btn-ghost small" data-go="${i.go}">去处理</button>
        </div>`).join('')}</div>
    </div>`;
  }

  async function renderDashboard() {
    const ov = await api('GET', '/api/reports/overview');
    const trend = await api('GET', '/api/reports/sales-trend');
    const top = await api('GET', '/api/reports/top-products');
    const alerts = await api('GET', '/api/inventory/alerts');
    let todo = null;
    try { todo = await api('GET', '/api/todo-summary'); } catch (e) { todo = null; }
    $('#content').innerHTML = `
      ${todoCard(todo)}
      <div class="grid cols-4">
        <div class="stat accent"><div class="label">今日销售额</div><div class="value">${yuan(ov.todaySales)}</div><div class="sub">利润 ${yuan(ov.todayProfit)}</div></div>
        <div class="stat good"><div class="label">本月销售额</div><div class="value">${yuan(ov.monthSales)}</div><div class="sub">利润 ${yuan(ov.monthProfit)}</div></div>
        <div class="stat"><div class="label">本月进货成本</div><div class="value">${yuan(ov.monthPurchase)}</div><div class="sub">商品数 ${ov.productCount}</div></div>
        <div class="stat warn"><div class="label">库存预警</div><div class="value">${ov.lowStockCount}</div><div class="sub">库存总值 ${yuan(ov.stockValue)}</div></div>
      </div>
      <div class="grid cols-2" style="margin-top:16px">
        <div class="card"><div class="card-title">近 14 天销售趋势</div>${trendChart(trend)}</div>
        <div class="card"><div class="card-title">畅销商品 TOP</div>${topTable(top)}</div>
      </div>
      <div class="card" style="margin-top:16px" id="alert-card">
        <div class="card-title">
          <span>库存预警 <span class="tag warn">${alerts.length} 项</span></span>
          ${alerts.length ? `<span class="alert-tools">
            <span class="muted" id="alert-sel">已选 0 / ${alerts.length} 项</span>
            <button type="button" class="btn-ghost small" id="alert-export">⬇️ 导出 Excel</button>
          </span>` : ''}
        </div>
        ${alerts.length ? `<div class="table-wrap"><table><thead><tr>
            <th class="chk-col"><input type="checkbox" id="alert-all" title="全选 / 取消全选"></th>
            <th>商品</th><th>SKU</th><th class="num">当前库存</th><th class="num">下限</th></tr></thead><tbody>
          ${alerts.map(a => `<tr>
            <td class="chk-col"><input type="checkbox" class="alert-chk" value="${a.id}"></td>
            <td>${esc(a.name)}</td><td>${esc(a.sku || '-')}</td><td class="num">${intf(a.stock)}</td><td class="num">${intf(a.min_stock)}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="empty">暂无预警，库存充足 🎉</p>'}
      </div>`;
    bindAlertExport();
    $$('.todo-item [data-go]').forEach((b) => {
      b.onclick = () => {
        const go = b.dataset.go;
        if (go === 'alerts') {
          const el = $('#alert-card');
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return;
        }
        navigate(go);
      };
    });
  }

  // 库存预警：勾选（含全选）后导出选中项
  function bindAlertExport() {
    const all = $('#alert-all');
    const boxes = $$('.alert-chk');
    const btn = $('#alert-export');
    const tip = $('#alert-sel');
    if (!all || !btn || !boxes.length) return;
    const refresh = () => {
      const picked = boxes.filter(b => b.checked);
      all.checked = picked.length > 0 && picked.length === boxes.length;
      all.indeterminate = picked.length > 0 && picked.length < boxes.length;   // 部分选中
      if (tip) tip.textContent = `已选 ${picked.length} / ${boxes.length} 项`;
    };
    all.onchange = () => { boxes.forEach(b => { b.checked = all.checked; }); refresh(); };
    boxes.forEach(b => { b.onchange = refresh; });
    btn.onclick = () => exportAlertExcel(btn, boxes.filter(b => b.checked).map(b => Number(b.value)));
    refresh();
  }

  async function exportAlertExcel(btn, ids) {
    if (!ids.length) { toast('请先勾选要导出的商品', true); return; }
    btn.disabled = true;
    try {
      const res = await fetch('/api/inventory/alerts/export', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids })
      });
      if (!res.ok) {
        let msg = '导出失败';
        try { const d = await res.json(); msg = d.error || msg; } catch (e) {}
        throw new Error(msg);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      const a = document.createElement('a');
      a.href = url;
      a.download = `库存预警_${stamp}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast(`已导出 ${ids.length} 条库存预警`);
    } catch (e) {
      toast(e.message, true);
    }
    btn.disabled = false;
  }

  // 金额轴刻度：把最大值凑成 1/2/2.5/5 的整数倍，避免出现 13,847 这种刻度
  function niceStep(v) {
    if (!(v > 0)) return 1;
    const exp = Math.floor(Math.log10(v));
    const base = Math.pow(10, exp);
    const n = v / base;
    const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return m * base;
  }
  function shortMoney(v) {
    const n = Number(v) || 0;
    if (Math.abs(n) >= 10000) return (n / 10000).toFixed(Math.abs(n) >= 100000 ? 0 : 1) + '万';
    return String(Math.round(n));
  }

  function trendChart(rows) {
    // 后端只返回「有销售的日子」，空白天必须按 0 补齐，
    // 否则折线会把相隔好几天的两个点直接连起来，看着像天天都开单。
    const byDay = new Map((rows || []).map(r => [String(r.day).slice(0, 10), r]));
    const days = [];
    const base = new Date(); base.setHours(0, 0, 0, 0);
    for (let i = 13; i >= 0; i--) {
      const dd = new Date(base.getTime() - i * 86400000);
      const key = `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}-${String(dd.getDate()).padStart(2, '0')}`;
      const hit = byDay.get(key);
      days.push({ day: key, amount: hit ? Number(hit.amount) || 0 : 0, profit: hit ? Number(hit.profit) || 0 : 0 });
    }
    const w = 620, h = 340;
    const P = { l: 56, r: 16, t: 16, b: 30 };
    const iw = w - P.l - P.r, ih = h - P.t - P.b;
    const maxV = Math.max(1, ...days.map(d => Math.max(d.amount, d.profit)));
    const step = niceStep(maxV / 3);
    const top = Math.max(step * 3, Math.ceil(maxV / step) * step);
    const X = (i) => P.l + (iw * i) / Math.max(1, days.length - 1);
    const Y = (v) => P.t + ih - (ih * (Number(v) || 0)) / top;
    const poly = (k) => days.map((d, i) => `${X(i).toFixed(1)},${Y(d[k]).toFixed(1)}`).join(' ');
    const area = `${P.l},${P.t + ih} ${poly('amount')} ${X(days.length - 1).toFixed(1)},${P.t + ih}`;
    const grid = [0, 1, 2, 3].map(k => {
      const gy = P.t + ih - (ih * k) / 3;
      return `<line x1="${P.l}" y1="${gy.toFixed(1)}" x2="${w - P.r}" y2="${gy.toFixed(1)}" stroke="#eef2f7"/>
        <text x="${P.l - 8}" y="${(gy + 3.5).toFixed(1)}" font-size="10" fill="#8a94a6" text-anchor="end">${k === 0 ? '0' : shortMoney((top * k) / 3)}</text>`;
    }).join('');
    const labels = days.map((d, i) => (i % 2 === 0 || i === days.length - 1)
      ? `<text x="${X(i).toFixed(1)}" y="${h - 9}" font-size="10" fill="#8a94a6" text-anchor="middle">${d.day.slice(5)}</text>` : '').join('');
    const dots = days.map((d, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(d.amount).toFixed(1)}" r="2.6" fill="#2563eb"><title>${d.day}｜销售 ${yuan(d.amount)}｜利润 ${yuan(d.profit)}</title></circle>`).join('');
    const sumAmt = days.reduce((s, d) => s + d.amount, 0);
    const sumPft = days.reduce((s, d) => s + d.profit, 0);
    const best = days.reduce((a, b) => (b.amount > a.amount ? b : a), days[0]);
    return `<div class="chart-legend">
        <span><i style="background:#2563eb"></i>销售额</span>
        <span><i style="background:#f59e0b"></i>利润</span>
        <span class="muted">单位：元，悬停看每天明细</span>
      </div>
      <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto">
        ${grid}
        <polygon points="${area}" fill="#eff4ff"/>
        <polyline points="${poly('amount')}" fill="none" stroke="#2563eb" stroke-width="2" stroke-linejoin="round"/>
        <polyline points="${poly('profit')}" fill="none" stroke="#f59e0b" stroke-width="1.6" stroke-dasharray="4 3" stroke-linejoin="round"/>
        <line x1="${P.l}" y1="${P.t + ih}" x2="${w - P.r}" y2="${P.t + ih}" stroke="#dbe3ee"/>
        ${dots}${labels}
      </svg>
      <div class="chart-stats">
        <div><span class="muted">14 天合计</span><b>${yuan(sumAmt)}</b></div>
        <div><span class="muted">日均</span><b>${yuan(sumAmt / days.length)}</b></div>
        <div><span class="muted">最高单日</span><b>${yuan(best.amount)}<i class="muted"> ${best.day.slice(5)}</i></b></div>
        <div><span class="muted">14 天利润</span><b class="${sumPft < 0 ? 'danger' : ''}">${yuan(sumPft)}</b></div>
      </div>`;
  }

  function topTable(rows) {
    if (!rows.length) return '<p class="empty">暂无销售数据</p>';
    return `<div class="table-wrap"><table><thead><tr><th>商品</th><th class="num">销量</th><th class="num">销售额</th><th class="num">利润</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td>${esc(r.name)}</td><td class="num">${intf(r.qty)}</td><td class="num">${yuan(r.amount)}</td><td class="num">${yuan(r.profit)}</td></tr>`).join('')}
    </tbody></table></div>`;
  }

  // ---------- 商品 ----------
  async function renderProducts() {
    const act = $('#topbar-actions');
    act.innerHTML = `<button class="btn-primary" id="add-product">+ 新增商品</button>
      <button class="btn-ghost" id="dl-template">⬇️ 下载模板</button>
      <button class="btn-ghost" id="import-products">⬆️ 导入商品</button>`;
    $('#content').innerHTML = `<div class="card"><div class="toolbar">
      <input id="prod-search" placeholder="搜索名称 / SKU / 分类">
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-soft)"><input type="checkbox" id="prod-low"> 仅看预警</label>
    </div><div id="prod-body" class="table-wrap"><p class="empty">加载中…</p></div></div>`;
    $('#add-product').onclick = () => openProductModal();
    $('#dl-template').onclick = () => downloadTemplate();
    $('#import-products').onclick = () => openImportModal();
    const load = debounce(async () => {
      const s = $('#prod-search').value.trim();
      const low = $('#prod-low').checked ? '1' : '';
      const rows = await api('GET', `/api/products?search=${encodeURIComponent(s)}&low=${low}`);
      $('#prod-body').innerHTML = prodTable(rows);
      bindProdRows();
    }, 200);
    $('#prod-search').addEventListener('input', load);
    $('#prod-low').addEventListener('change', load);
    load();
  }

  function prodTable(rows) {
    if (!rows.length) return '<p class="empty">没有匹配的商品</p>';
    return `<table><thead><tr><th>SKU</th><th>名称</th><th>分类</th><th>单位</th><th class="num">进货价</th><th class="num">销售价</th><th class="num">库存</th><th class="num">下限</th><th>状态</th><th>操作</th></tr></thead><tbody>
      ${rows.map(p => `<tr data-id="${p.id}">
        <td>${esc(p.sku || '-')}</td><td>${esc(p.name)}</td><td>${esc(p.category || '-')}</td><td>${esc(p.unit)}</td>
        <td class="num">${yuan(p.purchase_price)}</td><td class="num">${yuan(p.sale_price)}</td>
        <td class="num">${intf(p.stock)}</td><td class="num">${intf(p.min_stock)}</td>
        <td>${p.stock <= p.min_stock ? '<span class="tag warn">预警</span>' : '<span class="tag ok">正常</span>'}</td>
        <td><button class="btn-ghost small" data-act="edit">编辑</button>${state.user && state.user.role === 'admin' ? ` <button class="btn-danger" data-act="del" title="删除商品（仅限无出入库记录、无库存流水的商品）">删除</button>` : ''}</td>
      </tr>`).join('')}
    </tbody></table>`;
  }

  function bindProdRows() {
    $$('#prod-body tr[data-id]').forEach((tr) => {
      const id = tr.dataset.id;
      tr.querySelector('[data-act="edit"]').onclick = () => openProductModal(id);
      const delBtn = tr.querySelector('[data-act="del"]');
      if (!delBtn) return;          // 普通用户不显示删除按钮（服务端也已要求管理员权限）
      delBtn.onclick = async () => {
        if (!confirm('确定删除该商品？')) return;
        try { await api('DELETE', `/api/products/${id}`); toast('已删除'); await refreshCache(); renderProducts(); }
        catch (e) { toast(e.message, true); }
      };
    });
  }

  // ---------- 商品导入 / 模板 ----------
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  function fileStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  }
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).replace(/^data:[^;]*;base64,/, ''));
      r.onerror = () => reject(new Error('文件读取失败'));
      r.readAsDataURL(file);
    });
  }
  function downloadXlsxBase64(b64, filename) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    downloadBlob(new Blob([arr], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename);
  }

  async function downloadTemplate() {
    try {
      const res = await fetch('/api/products/template', { method: 'GET', credentials: 'same-origin' });
      if (!res.ok) { let msg = '模板下载失败'; try { const d = await res.json(); msg = d.error || msg; } catch (e) {} throw new Error(msg); }
      const blob = await res.blob();
      downloadBlob(blob, `商品导入模板_${fileStamp()}.xlsx`);
      toast('已下载模板');
    } catch (e) { toast(e.message, true); }
  }

  function openImportModal() {
    const m = modal(`<h3>导入商品</h3>
      <div class="import-box">
        <p class="muted">支持 <b>.xlsx</b>（建议用系统模板）与 <b>.csv</b>。导入规则：仅导入库里<b>没有该商品编码</b>的行；
        编码重复（库内已存在 / 本文件内重复）或校验不通过的行会进入「未导入表」。</p>
        <input type="file" id="imp-file" accept=".xlsx,.csv">
        <div id="imp-result" class="import-result"></div>
        <div class="modal-actions">
          <button class="btn-ghost" id="imp-close">关闭</button>
        </div>
      </div>`);
    const fileEl = m.box.querySelector('#imp-file');
    const resEl = m.box.querySelector('#imp-result');
    m.box.querySelector('#imp-close').onclick = () => m.close();
    fileEl.onchange = async () => {
      const f = fileEl.files && fileEl.files[0];
      if (!f) return;
      fileEl.disabled = true;
      resEl.innerHTML = '<p class="muted">解析中…</p>';
      try {
        const b64 = await fileToBase64(f);
        const data = await api('POST', '/api/products/import', { file: b64, filename: f.name });
        renderImportResult(data, resEl);
        if (data.imported > 0) { await refreshCache(); renderProducts(); }
      } catch (e) {
        resEl.innerHTML = `<p class="err">${esc(e.message)}</p>`;
      } finally {
        fileEl.disabled = false;
      }
    };
  }

  function renderImportResult(data, el) {
    const total = data.total || 0;
    const imported = data.imported || 0;
    const skipped = data.skipped || [];
    let html = `<div class="import-summary">
      <span class="tag ok">导入成功 ${imported} 条</span>
      <span class="tag">共 ${total} 条</span>
      <span class="${skipped.length ? 'tag warn' : 'tag'}">未导入 ${skipped.length} 条</span>
    </div>`;
    if (skipped.length) {
      html += `<div class="import-actions"><button class="btn-primary small" id="dl-unimported">⬇️ 下载未导入表</button></div>`;
      html += `<table class="import-skipped"><thead><tr><th>行号</th><th>商品编码</th><th>商品名称</th><th>未导入原因</th></tr></thead><tbody>
        ${skipped.map((s) => `<tr><td>${s.row}</td><td>${esc(s.sku || '-')}</td><td>${esc(s.name || '-')}</td><td>${esc(s.reason)}</td></tr>`).join('')}
      </tbody></table>`;
    }
    el.innerHTML = html;
    if (skipped.length && data.unimported_xlsx) {
      el.querySelector('#dl-unimported').onclick = () => downloadXlsxBase64(data.unimported_xlsx, `未导入商品_${fileStamp()}.xlsx`);
    }
  }

  async function openProductModal(id) {
    // 打开前刷新商品缓存，保证编码去重比对的是最新数据
    try { state.cache.products = await api('GET', '/api/products'); } catch (e) {}
    const p = id ? state.cache.products.find(x => x.id == id) : null;
    const scanBox = p ? '' : `
      <div class="scan-box">
        <div class="scan-head"><span>📷 扫码录入</span><span class="muted" style="font-size:12px">用扫码枪扫描条码/二维码（或输入后回车）：含中文/字母→商品名称；纯数字→商品编码</span></div>
        <input id="scan-input" autocomplete="off" placeholder="点此聚焦后扫描…（支持 名称|编码 或 JSON）">
        <div id="scan-hint" class="scan-hint"></div>
      </div>`;
    const m = modal(`<h3>${p ? '编辑商品' : '新增商品'}</h3>
      <form id="pf">
        ${scanBox}
        <div class="form-row">
          <div class="field"><label>商品名称 *</label><input name="name" value="${p ? esc(p.name) : ''}" required></div>
          <div class="field"><label>SKU / 编码</label><input name="sku" value="${p ? esc(p.sku || '') : ''}" placeholder="与现有编码不可重复"></div>
        </div>
        <div class="form-row">
          <div class="field"><label>分类</label><input name="category" value="${p ? esc(p.category || '') : ''}" placeholder="如 饮料"></div>
          <div class="field"><label>单位</label><input name="unit" value="${p ? esc(p.unit) : '个'}"></div>
        </div>
        <div class="form-row">
          <div class="field"><label>进货价</label><input name="purchase_price" type="number" step="0.01" min="0" value="${p ? p.purchase_price : ''}"></div>
          <div class="field"><label>销售价</label><input name="sale_price" type="number" step="0.01" min="0" value="${p ? p.sale_price : ''}"></div>
        </div>
        ${p ? '' : '<div class="form-row"><div class="field"><label>初始库存</label><input name="stock" type="number" min="0" value="0"></div><div class="field"><label>库存下限（预警）</label><input name="min_stock" type="number" min="0" value="0"></div></div>'}
        ${p ? '<div class="form-row"><div class="field"><label>库存下限（预警）</label><input name="min_stock" type="number" min="0" value="' + (p.min_stock || 0) + '"></div><div class="field"><label>说明</label><input name="note" value="' + esc(p.note || '') + '"></div></div>' : '<div class="field"><label>说明</label><input name="note"></div>'}
        <div class="modal-actions"><button type="button" class="btn-ghost" id="cancel">取消</button><button type="submit" class="btn-primary">保存</button></div>
      </form>`);
    m.root.querySelector('#cancel').onclick = m.close;
    const nameEl = m.root.querySelector('[name="name"]');
    const skuEl = m.root.querySelector('[name="sku"]');
    const scanEl = m.root.querySelector('#scan-input');
    const hintEl = m.root.querySelector('#scan-hint');

    // 解析扫码内容：JSON / 分隔符(名称|编码) / 单值
    const isCodeLike = (s) => /^[A-Za-z0-9\-_.]+$/.test(s) && s.length <= 24;
    function parseScan(raw) {
      const txt = (raw || '').trim();
      if (!txt) return { name: '', sku: '' };
      // JSON：{"name":"...","sku"/"barcode":"..."}
      if (txt[0] === '{') {
        try {
          const o = JSON.parse(txt);
          return { name: o.name || o.商品名称 || '', sku: o.sku || o.barcode || o.编码 || o.条码 || o.code || '' };
        } catch (e) { /* 继续按普通文本处理 */ }
      }
      // 分隔符：名称|编码 / 名称,编码 / 名称#编码 / Tab
      const parts = txt.split(/[|,\t#;]/).map(s => s.trim()).filter(Boolean);
      if (parts.length >= 2) {
        let a = parts[0], b = parts[1];
        if (isCodeLike(a) && !isCodeLike(b)) return { name: b, sku: a };
        if (isCodeLike(b) && !isCodeLike(a)) return { name: a, sku: b };
        return { name: a, sku: b };
      }
      // 单值：纯数字视为条码/编码，其余视为名称
      if (/^\d{6,}$/.test(txt)) return { name: '', sku: txt };
      return { name: txt, sku: '' };
    }
    function handleScan(raw) {
      const { name, sku } = parseScan(raw);
      if (!name && !sku) return;
      // 去重：编码已存在
      if (sku) {
        const dup = state.cache.products.find(x => (x.sku || '') && x.sku.toLowerCase() === String(sku).toLowerCase());
        if (dup) { hintEl.textContent = `⚠ 编码「${sku}」已被商品「${dup.name}」使用，不能重复`; hintEl.className = 'scan-hint err'; toast('该商品编码已存在', true); return; }
      }
      // 同名提示（不阻断）
      let note = '';
      if (name) {
        const same = state.cache.products.find(x => x.name === name);
        if (same) note = `（提示：已存在同名商品「${name}」）`;
      }
      if (name) nameEl.value = name;
      if (sku) skuEl.value = sku;
      hintEl.textContent = `已录入：${name ? '名称「' + name + '」' : ''}${name && sku ? ' ' : ''}${sku ? '编码「' + sku + '」' : ''}${note}`;
      hintEl.className = 'scan-hint' + (note ? ' warn' : '');
      (name ? skuEl : nameEl).focus();
    }
    if (scanEl) {
      scanEl.focus();
      scanEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); handleScan(scanEl.value); scanEl.value = ''; }
      });
    }

    m.root.querySelector('#pf').addEventListener('submit', async (e) => {
      e.preventDefault(); const f = e.target;
      const skuVal = (f.sku.value || '').trim();
      // 提交前客户端去重预检（排除自身）
      if (skuVal) {
        const dup = state.cache.products.find(x => (x.sku || '') && x.sku.toLowerCase() === skuVal.toLowerCase() && (!p || x.id !== p.id));
        if (dup) return toast(`商品编码「${skuVal}」已存在（${dup.name}），请更换`, true);
      }
      const body = {
        name: f.name.value, sku: skuVal, category: f.category.value, unit: f.unit.value,
        purchase_price: f.purchase_price.value, sale_price: f.sale_price.value, min_stock: f.min_stock.value, note: f.note.value
      };
      if (!p) body.stock = f.stock.value;
      try {
        if (p) await api('PUT', `/api/products/${p.id}`, body); else await api('POST', '/api/products', body);
        toast('已保存'); m.close(); await refreshCache(); renderProducts();
      } catch (err) { toast(err.message, true); }
    });
  }

  // ---------- 供应商 / 客户（结构相同） ----------
  function partnerView(kind) {
    return async () => {
      const act = $('#topbar-actions');
      act.innerHTML = `<button class="btn-primary" id="add-p">+ 新增</button>`;
      $('#content').innerHTML = `<div class="card"><div class="toolbar"><input id="p-search" placeholder="搜索名称 / 联系人 / 电话"></div>
        <div id="p-body" class="table-wrap"><p class="empty">加载中…</p></div></div>`;
      $('#add-p').onclick = () => openPartnerModal(kind);
      const apiPath = kind === 'suppliers' ? '/api/suppliers' : '/api/customers';
      const load = debounce(async () => {
        const rows = await api('GET', `${apiPath}?search=${encodeURIComponent($('#p-search').value.trim())}`);
        $('#p-body').innerHTML = partnerTable(rows, kind);
        $$('#p-body tr[data-id]').forEach((tr) => {
          const id = tr.dataset.id;
          tr.querySelector('[data-act="edit"]').onclick = () => openPartnerModal(kind, id);
          const txBtn = tr.querySelector('[data-act="tx"]');
          if (txBtn) txBtn.onclick = (e) => { e.preventDefault(); openPartnerTx(kind, parseInt(id), txBtn.textContent); };
          tr.querySelector('[data-act="del"]').onclick = async () => {
            if (!confirm('确定删除？')) return;
            try { await api('DELETE', `${apiPath}/${id}`); toast('已删除'); await refreshCache(); kind === 'suppliers' ? renderSuppliers() : renderCustomers(); }
            catch (e) { toast(e.message, true); }
          };
        });
      }, 200);
      $('#p-search').addEventListener('input', load);
      load();
    };
  }
  const renderSuppliers = partnerView('suppliers');
  const renderCustomers = partnerView('customers');

  function partnerTable(rows, kind) {
    if (!rows.length) return '<p class="empty">暂无数据</p>';
    const creditHead = kind === 'customer'
      ? `<th class="num">授信额度</th><th class="num">当前应收</th><th class="num">预收款</th><th class="num">可用额度</th>`
      : '';
    // 可用额度 = 授信额度 - max(0, 应收 - 预收款)：预收款是客户已经交过的钱，先冲抵欠款，剩下的才占额度
    const creditBody = (r) => kind === 'customer'
      ? `<td class="num">${yuan(r.credit_limit)}</td><td class="num">${yuan(r.receivable)}</td>
         <td class="num">${r.advance > 0.001 ? `<span class="tag ok">${yuan(r.advance)}</span>` : '<span class="muted">—</span>'}</td>
         <td class="num ${r.available < -0.001 ? 'danger' : ''}" title="授信占用 ${yuan(r.credit_used)}">${yuan(r.available)}</td>`
      : '';
    return `<table><thead><tr><th>名称</th><th>联系人</th><th>电话</th><th>地址</th><th>备注</th>${creditHead}<th>操作</th></tr></thead><tbody>
      ${rows.map(r => `<tr data-id="${r.id}"><td><a href="javascript:void 0" class="pname" data-act="tx" data-id="${r.id}" title="点击查看交易清单">${esc(r.name)}</a></td><td>${esc(r.contact || '-')}</td><td>${esc(r.phone || '-')}</td><td>${esc(r.address || '-')}</td><td>${esc(r.note || '-')}</td>${creditBody(r)}
        <td><button class="btn-ghost small" data-act="edit">编辑</button> <button class="btn-danger" data-act="del">删除</button></td></tr>`).join('')}
    </tbody></table>`;
  }

  async function openPartnerModal(kind, id) {
    const apiPath = kind === 'suppliers' ? '/api/suppliers' : '/api/customers';
    const list = kind === 'suppliers' ? state.cache.suppliers : state.cache.customers;
    const r = id ? list.find(x => x.id == id) : null;
    const isCustomer = kind === 'customers';
    // 授信额度是唯一的赊账风控闸门，服务端只允许管理员修改，这里直接禁用输入框避免普通用户白试一次
    const isAdmin = !!(state.user && state.user.role === 'admin');
    const clVal = r ? (r.credit_limit ?? 100000) : 100000;
    const creditField = isCustomer
      ? `<div class="field"><label>授信额度（赊货金额）${isAdmin ? '' : ' <span class="muted">（仅管理员可改）</span>'}</label>
          <input name="credit_limit" type="number" step="0.01" min="0" value="${esc(clVal)}"${isAdmin ? '' : ' disabled'}>
          <small class="muted">${isAdmin ? '客户欠款超过此额度将禁止开单，默认 100000' : `当前 ${yuan(clVal)}，需提高请联系管理员`}</small></div>`
      : '';
    const m = modal(`<h3>${r ? '编辑' : '新增'}${kind === 'suppliers' ? '供应商' : '客户'}</h3>
      <form id="pf">
        <div class="field"><label>名称 *</label><input name="name" value="${r ? esc(r.name) : ''}" required></div>
        <div class="form-row"><div class="field"><label>联系人</label><input name="contact" value="${r ? esc(r.contact || '') : ''}"></div>
        <div class="field"><label>电话</label><input name="phone" value="${r ? esc(r.phone || '') : ''}"></div></div>
        <div class="field"><label>地址</label><input name="address" value="${r ? esc(r.address || '') : ''}"></div>
        ${creditField}
        <div class="field"><label>备注</label><input name="note" value="${r ? esc(r.note || '') : ''}"></div>
        <div class="modal-actions"><button type="button" class="btn-ghost" id="cancel">取消</button><button type="submit" class="btn-primary">保存</button></div>
      </form>`);
    m.root.querySelector('#cancel').onclick = m.close;
    m.root.querySelector('#pf').addEventListener('submit', async (e) => {
      e.preventDefault(); const f = e.target;
      const body = { name: f.name.value, contact: f.contact.value, phone: f.phone.value, address: f.address.value, note: f.note.value };
      if (isCustomer && f.credit_limit) body.credit_limit = parseFloat(f.credit_limit.value);
      try {
        if (r) await api('PUT', `${apiPath}/${r.id}`, body); else await api('POST', apiPath, body);
        toast('已保存'); m.close(); await refreshCache(); kind === 'suppliers' ? renderSuppliers() : renderCustomers();
      } catch (err) { toast(err.message, true); }
    });
  }

  // ---------- 往来单位交易清单（客户 / 供应商，点名称打开） ----------
  const STATUS_TEXT = { active: '正常', pending_return: '退单待审', returned: '已退单' };

  function openPartnerTx(kind, id, name) {
    const type = kind === 'suppliers' ? 'supplier' : 'customer';
    const isSup = type === 'supplier';
    const f = { product: '', from: '', to: '' };
    const m = modal(`
      <div class="modal-head">
        <div class="avatar">${isSup ? '🏭' : '🧑‍💼'}</div>
        <div style="flex:1">
          <div class="mt">${esc(name || '')}</div>
          <div class="ms">${isSup ? '供应商' : '客户'}交易清单 · 按交易时间倒序</div>
        </div>
        <button class="btn-ghost small" id="tx-close">关闭</button>
      </div>
      <div id="tx-wrap"><p class="empty">加载中…</p></div>`, 'modal-tx');
    m.root.querySelector('#tx-close').onclick = m.close;

    const qs = () => {
      const q = new URLSearchParams();
      if (f.product) q.set('product', f.product);
      if (f.from) q.set('from', f.from);
      if (f.to) q.set('to', f.to);
      return q.toString();
    };

    const tableHtml = (d) => {
      if (!d.list.length) return `<p class="empty">${f.product || f.from || f.to ? '没有符合条件交易记录' : '该' + (isSup ? '供应商' : '客户') + '暂无交易记录'}</p>`;
      const t = d.totals;
      return `
        <div class="tx-sum">
          <span>共 <b>${t.count}</b> 笔</span>
          <span>商品件数 <b>${intf(t.qty)}</b></span>
          <span>金额合计 <b>${yuan(t.amountActive)}</b></span>
          ${t.countPending ? `<span class="muted">退单待审 ${t.countPending} 笔</span>` : ''}
          ${t.countReturned ? `<span class="muted">已退单 ${t.countReturned} 笔 · ${yuan(t.amountReturned)}（不计入合计）</span>` : ''}
        </div>
        <div class="table-scroll">
          <div class="table-wrap"><table class="tx-table">
            <thead><tr><th>交易时间</th><th>单号</th><th>商品明细</th><th class="num">件数</th><th class="num">金额</th><th class="num">已${isSup ? '付' : '收'}</th><th class="num">未${isSup ? '付' : '收'}</th><th>状态</th></tr></thead>
            <tbody>
              ${d.list.map(r => {
                const tag = r.status === 'returned'
                  ? '<span class="tag gray">已退单</span>'
                  : (r.status === 'pending_return' ? '<span class="tag pending">退单待审</span>' : '<span class="tag good">正常</span>');
                const items = (r.items || []).length
                  ? `<div class="tx-items">${r.items.map(it => `<div>${esc(it.name)}<span class="muted"> × ${intf(it.qty)}${it.unit ? esc(it.unit) : ''}</span></div>`).join('')}</div>`
                  : '<span class="muted">—</span>';
                return `<tr class="${r.status === 'returned' ? 'row-returned' : (r.status === 'pending_return' ? 'row-pending' : '')}">
                  <td class="time-col">${esc((r.created_at || '').slice(0, 16))}</td>
                  <td>${esc(r.bill_no)}</td>
                  <td>${items}</td>
                  <td class="num">${intf(r.qty)}</td>
                  <td class="num">${yuan(r.amount)}</td>
                  <td class="num">${yuan(r.paid)}</td>
                  <td class="num ${r.outstanding > 0.001 && r.status !== 'returned' ? 'danger' : ''}">${yuan(r.outstanding)}</td>
                  <td>${tag}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table></div>
        </div>`;
    };

    async function load() {
      const wrap = m.root.querySelector('#tx-wrap');
      wrap.innerHTML = `
        <div class="filter-bar">
          <label>商品名称<input id="tx-prod" value="${esc(f.product)}" placeholder="模糊匹配商品名"></label>
          <label>起始日期<input type="date" id="tx-from" value="${esc(f.from)}"></label>
          <label>结束日期<input type="date" id="tx-to" value="${esc(f.to)}"></label>
          <button class="btn-primary small" id="tx-go">查询</button>
          <button class="btn-ghost small" id="tx-reset">重置</button>
          <button class="btn-ghost small" id="tx-export">⬇️ 导出 Excel</button>
        </div>
        <div id="tx-body"><p class="empty">加载中…</p></div>`;
      const readFilters = () => {
        f.product = (m.root.querySelector('#tx-prod').value || '').trim();
        f.from = m.root.querySelector('#tx-from').value || '';
        f.to = m.root.querySelector('#tx-to').value || '';
        if (f.from && f.to && f.from > f.to) { const t = f.from; f.from = f.to; f.to = t; }
      };
      m.root.querySelector('#tx-go').onclick = () => { readFilters(); load(); };
      m.root.querySelector('#tx-reset').onclick = () => { f.product = ''; f.from = ''; f.to = ''; load(); };
      ['#tx-prod', '#tx-from', '#tx-to'].forEach((sel) => {
        const el = m.root.querySelector(sel);
        if (el) el.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); readFilters(); load(); } };
      });
      m.root.querySelector('#tx-export').onclick = (e) => exportPartnerTx(e.currentTarget, type, id, qs());

      const body = m.root.querySelector('#tx-body');
      try {
        const d = await api('GET', `/api/partners/${type}/${id}/transactions?${qs()}`);
        body.innerHTML = tableHtml(d);
      } catch (err) {
        body.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
      }
    }
    load();
  }

  async function exportPartnerTx(btn, type, id, query) {
    btn.disabled = true;
    try {
      const res = await fetch(`/api/partners/${type}/${id}/transactions/export?${query}`, { credentials: 'same-origin' });
      if (!res.ok) {
        let msg = '导出失败';
        try { const d = await res.json(); msg = d.error || msg; } catch (e) { /* 忽略 */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      const a = document.createElement('a');
      a.href = url;
      a.download = `${type === 'supplier' ? '采购' : '销售'}交易清单_${stamp}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast('已导出交易清单');
    } catch (err) { toast(err.message, true); }
    btn.disabled = false;
  }

  // ---------- 采购入库 ----------
  function renderPurchase() {
    $('#topbar-actions').innerHTML = '';
    $('#content').innerHTML = billForm('purchase');
    initBillForm('purchase');
  }
  function renderSale() {
    $('#topbar-actions').innerHTML = '';
    $('#content').innerHTML = billForm('sale');
    initBillForm('sale');
  }

  function billForm(kind) {
    const isPur = kind === 'purchase';
    const partnerOptions = (isPur ? state.cache.suppliers : state.cache.customers)
      .map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    const partnerLabel = isPur ? '供应商' : '客户';
    return `<div class="card">
      <div class="card-title">${isPur ? '采购入库单' : '销售出库单'}</div>
      <div class="scan-bar">
        <span class="scan-ico">📷</span>
        <input id="bill-scan" autocomplete="off" spellcheck="false" placeholder="扫码枪扫描商品条码 / SKU，或输入商品名称后回车（支持「编码*数量」，如 P001*3）">
        <span id="scan-tip" class="scan-tip">支持扫码枪（扫完自动回车）· 连续扫码可多行录入</span>
      </div>
      <div class="scan-cands" id="scan-cands"></div>
      <div class="form-row">
        <div class="field"><label>${partnerLabel}</label><select id="bill-partner"><option value="">（${isPur ? '无 / 直采' : '散客'}）</option>${partnerOptions}</select></div>
        <div class="field"><label>定金 / 首付款（约定，可选）</label><input id="bill-deposit" type="number" step="0.01" min="0" value="0" placeholder="如 200"></div>
        <div class="field"><label>备注</label><input id="bill-note" placeholder="可选"></div>
      </div>
      <p id="bill-advance" class="advance-tip"></p>
      <p id="bill-credit" class="advance-tip"></p>
      <div class="line-items" id="line-items"></div>
      <button class="btn-ghost" id="add-line" type="button">+ 添加商品</button>
      <div class="bill-summary">合计：<b id="bill-total">¥0.00</b></div>
      <div class="due-box" id="bill-due" style="display:none"></div>
      <div class="submit-bar">
        ${isPur ? '' : `<label class="pay-now" title="勾选表示本次出库当场收清全款；提交时会让你确认一次">
          <input type="checkbox" id="bill-paid" checked>
          <span>出库同时收款完毕</span>
          <select id="bill-pay-method" class="pay-method">
            <option value="cash">现金</option>
            <option value="bank">银行转账</option>
            <option value="wechat">微信</option>
            <option value="alipay">支付宝</option>
            <option value="other">其他</option>
          </select>
        </label>`}
        <button class="btn-primary" id="submit-bill">提交${isPur ? '入库' : '出库'}</button>
      </div>
      <p id="bill-msg" class="bill-msg"></p>
    </div>`;
  }

  function initBillForm(kind) {
    const isPur = kind === 'purchase';
    const itemsBox = $('#line-items');

    // 创建一行明细；pid 指定时直接选中该商品并回填单价
    const makeLine = (pid) => {
      const row = document.createElement('div');
      row.className = 'line-row';
      const opts = state.cache.products.map(p => `<option value="${p.id}" data-pp="${p.purchase_price}" data-sp="${p.sale_price}">${esc(p.name)}（库存${intf(p.stock)}）</option>`).join('');
      row.innerHTML = `<select class="li-prod">${opts}</select>
        <input class="li-qty" type="number" min="1" step="1" value="1" placeholder="数量">
        <input class="li-price" type="number" step="0.01" min="0" placeholder="单价">
        <span class="li-sub num">¥0.00</span>
        <button type="button" class="del">×</button>`;
      const sel = row.querySelector('.li-prod');
      if (pid != null) sel.value = String(pid);
      const fillPrice = () => {
        const o = sel.selectedOptions[0];
        if (!o) return;
        row.querySelector('.li-price').value = isPur ? (o.dataset.pp || 0) : (o.dataset.sp || 0);
        recalc();
      };
      sel.addEventListener('change', () => { row._pristine = false; fillPrice(); });
      row.querySelector('.li-qty').addEventListener('input', () => { row._pristine = false; recalc(); });
      row.querySelector('.li-price').addEventListener('input', () => { row._pristine = false; recalc(); });
      row.querySelector('.del').addEventListener('click', () => { row.remove(); recalc(); });
      itemsBox.appendChild(row);
      if (state.cache.products.length) fillPrice();
      return row;
    };
    // ---------- 收款预览：货款 − 定金 − 可用预存 = 本次需另收 ----------
    // 销售出库的核心口径：先看客户有没有预收款，有就先抵；抵完还差才谈「收款 / 挂账」
    let curTotal = 0;        // 明细合计（recalc 维护）
    let advBal = 0;          // 该客户当前可用预收款余额
    const depVal = () => Math.max(0, parseFloat($('#bill-deposit').value) || 0);
    function dueInfo() {
      const total = r2(curTotal);
      const dep = r2(depVal());
      const base = Math.max(0, r2(total - dep));          // 定金已收，剩下才是要抵/要收的
      const use = Math.min(advBal, base);                  // 预存最多抵到本单清零
      const need = Math.max(0, r2(base - use));            // 抵扣后仍需另收的部分
      return { total, dep, base, use: r2(use), need };
    }
    // 把「预存怎么抵、还差多少」直接画在提交按钮上方，随明细/定金/客户变化实时刷新
    function renderDue() {
      const box = $('#bill-due');
      const tip = $('#bill-advance');
      if (!box) return;
      if (isPur) { box.style.display = 'none'; box.innerHTML = ''; return; }
      const pid = $('#bill-partner').value;
      if (!pid || curTotal <= 0) { box.style.display = 'none'; box.innerHTML = ''; return; }
      const d = dueInfo();
      const bits = [`货款 <b>${yuan(d.total)}</b>`];
      if (d.dep > 0.001) bits.push(`定金 <b>${yuan(d.dep)}</b>`);
      if (d.use > 0.001) bits.push(`预收款抵扣 <b>${yuan(d.use)}</b>`);
      let main, cls;
      if (d.need <= 0.001) {
        main = d.use > 0.001 ? '✓ 预收款足够，提交即自动抵扣结清，无需再收款' : '本单已由定金结清';
        cls = 'ok';
      } else {
        main = `本次需另收 <b>${yuan(d.need)}</b>${d.use > 0.001 ? '（预收款已先抵）' : ''}`;
        cls = 'warn';
      }
      box.style.display = '';
      box.className = 'due-box ' + cls;
      box.innerHTML = `<div class="due-line">${bits.join('<span class="due-sep">·</span>')}</div>
        <div class="due-main">${main}</div>`;
      if (tip) tip.textContent = advBal > 0.001
        ? `该客户可用预收款余额：${yuan(advBal)}（提交时按上面顺序先抵扣本单）`
        : '';
    }

    const recalc = () => {
      let total = 0;
      $$('.line-row', itemsBox).forEach((row) => {
        const qty = parseFloat(row.querySelector('.li-qty').value) || 0;
        const price = parseFloat(row.querySelector('.li-price').value) || 0;
        const sub = qty * price; total += sub;
        row.querySelector('.li-sub').textContent = yuan(sub);
      });
      $('#bill-total').textContent = yuan(total);
      curTotal = total;
      renderDue();
    };
    // 点击「+ 添加商品」新增的空白行可被首次扫码复用
    const addLine = () => { const r = makeLine(); r._pristine = true; return r; };
    $('#add-line').addEventListener('click', addLine);
    addLine();

    // ---------- 扫码枪 / 手动检索录入 ----------
    // 扫码枪本质是「快速键盘输入 + 回车」：聚焦扫码框直接扫即可，扫完自动匹配商品库并加行
    const scanEl = $('#bill-scan');
    const scanTip = $('#scan-tip');
    const candBox = $('#scan-cands');
    const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
    const scanMsg = (text, type) => {
      if (!scanTip) return;
      scanTip.textContent = text;
      scanTip.className = 'scan-tip' + (type ? ' ' + type : '');
    };
    // 按「编码/条码精确 → 名称精确 → 编码前缀 → 名称包含」优先级匹配
    const matchProducts = (code) => {
      const q = norm(code);
      if (!q) return [];
      const list = state.cache.products || [];
      const stages = [
        (p) => p.sku && norm(p.sku) === q,
        (p) => norm(p.name) === q,
        (p) => p.sku && norm(p.sku).startsWith(q),
        (p) => norm(p.name).includes(q)
      ];
      for (const test of stages) {
        const hit = list.filter(test);
        if (hit.length) return hit;
      }
      return [];
    };
    const flashRow = (row) => {
      row.classList.remove('scan-hit');
      void row.offsetWidth;
      row.classList.add('scan-hit');
      setTimeout(() => row.classList.remove('scan-hit'), 900);
    };
    const qtyInBill = (pid) => $$('.line-row', itemsBox)
      .filter(r => r.querySelector('.li-prod').value === String(pid))
      .reduce((s, r) => s + (parseInt(r.querySelector('.li-qty').value) || 0), 0);
    // 把商品加进单据：已存在则数量累加，否则复用空白行/新增行
    const scanAdd = (p, n) => {
      let row = $$('.line-row', itemsBox).find(r => r.querySelector('.li-prod').value === String(p.id));
      if (row) {
        const q = row.querySelector('.li-qty');
        q.value = (parseInt(q.value) || 0) + n;
        row._pristine = false;
      } else {
        const blank = $$('.line-row', itemsBox).find(r => r._pristine);
        if (blank) {
          blank._pristine = false;
          row = blank;
          const sel = row.querySelector('.li-prod');
          sel.value = String(p.id);
          const o = sel.selectedOptions[0];
          row.querySelector('.li-qty').value = n;
          row.querySelector('.li-price').value = isPur ? (o.dataset.pp || 0) : (o.dataset.sp || 0);
        } else {
          row = makeLine(p.id);
          row._pristine = false;
          row.querySelector('.li-qty').value = n;
          const o = row.querySelector('.li-prod').selectedOptions[0];
          row.querySelector('.li-price').value = isPur ? (o.dataset.pp || 0) : (o.dataset.sp || 0);
        }
      }
      candBox.innerHTML = '';
      flashRow(row);
      recalc();
      return row;
    };
    const showCandidates = (list, n) => {
      candBox.innerHTML = `<span class="muted" style="font-size:12px">匹配到 ${list.length} 个商品，点击选择：</span>` +
        list.slice(0, 12).map(p => `<button type="button" class="scan-cand" data-pid="${p.id}">${esc(p.name)}${p.sku ? ` · ${esc(p.sku)}` : ''}（库存 ${intf(p.stock)}）</button>`).join('');
      $$('.scan-cand', candBox).forEach(btn => btn.onclick = () => {
        const p = state.cache.products.find(x => String(x.id) === btn.dataset.pid);
        if (p) { scanAdd(p, n); scanMsg(`已添加 ${p.name} × ${n}`, 'ok'); }
        if (scanEl) scanEl.focus();
      });
    };
    const doScan = () => {
      if (!scanEl) return;
      const raw = scanEl.value.trim();
      if (!raw) return;
      scanEl.value = '';
      candBox.innerHTML = '';
      // 支持「编码*数量」「编码x3」「编码 3」
      let code = raw, n = 1;
      const m = raw.match(/^(.+?)\s*(?:[*xX×]|数量)\s*(\d+)$/) || raw.match(/^(.+?)\s+(\d+)$/);
      if (m) { code = m[1].trim(); n = Math.max(1, parseInt(m[2], 10) || 1); }
      const hits = matchProducts(code);
      if (!hits.length) {
        scanMsg(`未找到「${raw}」——请检查条码，或先到「商品管理」建档`, 'err');
        return;
      }
      if (hits.length > 1) {
        scanMsg(`「${raw}」匹配到 ${hits.length} 个商品，请从下方选择`, 'warn');
        showCandidates(hits, n);
        return;
      }
      const p = hits[0];
      scanAdd(p, n);
      const inBill = qtyInBill(p.id);
      let tip = `已添加 ${p.name} × ${n}（本单合计 ${inBill}，库存 ${intf(p.stock)}）`;
      let type = 'ok';
      if (!isPur && inBill > p.stock) { tip += ` ⚠ 库存不足`; type = 'err'; }
      scanMsg(tip, type);
    };
    if (scanEl) {
      scanEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); doScan(); }
        else if (e.key === 'Escape') { scanEl.value = ''; candBox.innerHTML = ''; }
      });
      // 扫码枪通常以回车结束；个别设备发 Tab，这里一并接住
      scanEl.addEventListener('keydown', (e) => {
        if (e.key === 'Tab' && scanEl.value.trim()) { e.preventDefault(); doScan(); }
      });
      setTimeout(() => scanEl.focus(), 0);
    }

    // 选定往来单位时，取其可用预存（预付款/预收款）余额，并刷新抵扣预览
    const refreshAdvance = async () => {
      const tip = $('#bill-advance');
      const creditTip = $('#bill-credit');
      const pid = $('#bill-partner').value;
      advBal = 0;
      if (!pid) {
        if (tip) tip.textContent = '';
        creditTip.textContent = ''; creditTip.className = 'advance-tip';
        renderDue();
        return;
      }
      // 赊货额度提示（仅销售出库、针对客户）
      if (!isPur) {
        const c = state.cache.customers.find(x => x.id == pid);
        if (c) {
          if (c.available < -0.001) {
            creditTip.className = 'advance-tip danger';
            creditTip.textContent = `⚠ 该客户已超授信额度：当前欠款 ${yuan(c.receivable)} / 授信 ${yuan(c.credit_limit)}，提交将被拒绝`;
          } else {
            creditTip.className = 'advance-tip';
            creditTip.textContent = `该客户可用授信 ${yuan(c.available)}（当前欠款 ${yuan(c.receivable)} / 授信 ${yuan(c.credit_limit)}）`;
          }
        } else { creditTip.textContent = ''; }
      } else {
        creditTip.textContent = ''; creditTip.className = 'advance-tip';
      }
      try {
        const r = await api('GET', `/api/advance-balance?party_type=${isPur ? 'supplier' : 'customer'}&party_id=${pid}`);
        if ($('#bill-partner').value !== pid) return;   // 等待期间已换单位，丢弃旧响应
        advBal = r.balance > 0.001 ? r.balance : 0;
        if (isPur && tip) {
          tip.textContent = advBal > 0.001 ? `该单位可用预付款余额：${yuan(advBal)}（提交时将自动抵减）` : '';
        }
      } catch (e) {
        advBal = 0;
        if (isPur && tip) tip.textContent = '';
      }
      renderDue();
    };
    const partnerSel = $('#bill-partner');
    if (partnerSel) partnerSel.addEventListener('change', refreshAdvance);
    // 定金改变会影响「还需抵/收」的基数，实时重算
    const depInput = $('#bill-deposit');
    if (depInput) depInput.addEventListener('input', renderDue);
    refreshAdvance();

    // ---------- 出库同时收款：勾选联动收款方式 ----------
    const paidBox = isPur ? null : $('#bill-paid');
    const payMethodSel = isPur ? null : $('#bill-pay-method');
    const syncPayMethod = () => {
      if (!paidBox || !payMethodSel) return;
      payMethodSel.disabled = !paidBox.checked;
      payMethodSel.title = paidBox.checked ? '本次收款的收款方式' : '未勾选「收款完毕」，本单按挂账处理';
    };
    if (paidBox) {
      paidBox.addEventListener('change', syncPayMethod);
      syncPayMethod();
    }

    $('#submit-bill').addEventListener('click', async () => {
      const rows = $$('.line-row', itemsBox);
      const items = rows.map((row) => ({
        product_id: parseInt(row.querySelector('.li-prod').value),
        qty: parseInt(row.querySelector('.li-qty').value),
        price: parseFloat(row.querySelector('.li-price').value) || 0
      }));
      const msg = $('#bill-msg');
      msg.className = 'bill-msg'; msg.textContent = '';
      const partnerId = $('#bill-partner').value ? parseInt($('#bill-partner').value) : null;
      const depositVal = Math.max(0, parseFloat($('#bill-deposit').value) || 0);
      const totalNow = r2(items.reduce((s, it) => s + (it.qty > 0 ? it.qty * it.price : 0), 0));
      if (totalNow <= 0) { msg.textContent = '请先添加商品并填写数量'; return; }
      if (!isPur && depositVal > totalNow + 0.001) {
        msg.textContent = `定金 ${yuan(depositVal)} 超过本单货款 ${yuan(totalNow)}，请修正后再提交`;
        return;
      }
      // 销售出库：提交前现取一次预收款余额，避免页面停留期间退单/收款导致预览与实际不一致
      if (!isPur && partnerId) {
        try {
          const r = await api('GET', `/api/advance-balance?party_type=customer&party_id=${partnerId}`);
          advBal = r.balance > 0.001 ? r.balance : 0;
          renderDue();
        } catch (e) { /* 取不到就按页面已有值走，后台仍会以真实余额抵扣 */ }
      }
      let paidInFull = !!(paidBox && paidBox.checked);
      if (!isPur) {
        const d = dueInfo();
        if (d.need <= 0.001) {
          // 预收款（含定金）已覆盖本单：只做抵扣，不必再问「是否已收款」。
          // 这里刻意不置 paid_in_full：万一余额刚被其它操作占用，宁可差额挂应收，也不凭空记一笔「已收款」。
          paidInFull = false;
          msg.className = 'bill-msg ok';
          msg.textContent = d.use > 0.001
            ? `客户预收款 ${yuan(d.use)} 将直接抵扣本单，无需另收款，提交后本单结清。`
            : '本单已由定金结清，无需另收款。';
        } else if (paidInFull) {
          // 抵扣后仍差钱：弹窗讲清「抵多少、还要收多少」
          const ans = await askCollected(d);
          if (ans === 'cancel') return;
          if (ans === 'unpaid') {
            paidBox.checked = false;
            syncPayMethod();
            msg.className = 'bill-msg ok';
            msg.textContent = `已改为「未收款」：本单先抵预收款 ${yuan(d.use)}，剩余 ${yuan(d.need)} 挂为应收。确认无误后请再次点击「提交出库」。`;
            return;
          }
        }
      }
      try {
        const res = await api('POST', isPur ? '/api/purchases' : '/api/sales', {
          [isPur ? 'supplier_id' : 'customer_id']: partnerId,
          deposit: depositVal,
          note: $('#bill-note').value, items,
          paid_in_full: paidInFull,
          pay_method: payMethodSel ? payMethodSel.value : 'cash'
        });
        const bits = [];
        if (res.advance_applied > 0.001) bits.push(`${isPur ? '预付款' : '预收款'}抵扣 ${yuan(res.advance_applied)}`);
        if (res.paid_now > 0.001) bits.push(`本次收款 ${yuan(res.paid_now)}`);
        if (res.outstanding > 0.001) bits.push(`${isPur ? '未付' : '未收'} ${yuan(res.outstanding)} ${isPur ? '已挂应付' : '已挂应收'}`);
        else if (!isPur) bits.push('本单已结清');
        toast(`单据已提交：${res.bill_no}；${bits.join('，')}`);
        await refreshCache();
        kind === 'purchase' ? renderPurchase() : renderSale();
        loadSidebarStats();   // 立刻刷新侧栏销售额
      } catch (e) { msg.className = 'bill-msg'; msg.textContent = e.message; }
    });
  }

  // 抵扣后仍差钱时确认「差额怎么处理」：resolve('paid' 已收款) / 'unpaid' 挂账 / 'cancel' 取消
  function askCollected(d) {
    return new Promise((resolve) => {
      let done = false;
      const rowsHtml = [
        `货款 <b>${yuan(d.total)}</b>`,
        d.dep > 0.001 ? `定金 <b>${yuan(d.dep)}</b>` : '',
        d.use > 0.001 ? `预收款抵扣 <b>${yuan(d.use)}</b>` : '',
        `本次需另收 <b class="due-hl">${yuan(d.need)}</b>`
      ].filter(Boolean).map(t => `<li>${t}</li>`).join('');
      const m = modal(`<div class="modal-head">
          <div class="avatar">💰</div>
          <div>
            <div class="mt">还差 ${yuan(d.need)}，怎么处理？</div>
            <div class="ms">客户预收款已先抵扣，剩余部分请选择收款或挂账</div>
          </div>
        </div>
        <ul class="due-list">${rowsHtml}</ul>
        <div class="form-note">
          <b>已收款</b>：提交出库，只就差额 ${yuan(d.need)} 生成一笔收款记录，本单应收归零。<br>
          <b>未收款</b>：提交出库，差额 ${yuan(d.need)} 挂为该客户的应收（受授信额度约束）。<br>
          <span class="muted">预收款部分不再重复收钱，只是把客户之前交过的钱挂到本单上。</span>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn-ghost" id="c-cancel">取消</button>
          <button type="button" class="btn-warn" id="c-unpaid">未收款（差额挂账）</button>
          <button type="button" class="btn-primary" id="c-paid">已收款，提交</button>
        </div>`, 'modal-confirm');
      const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
      // 点遮罩/X 关闭视为取消，避免 Promise 永远挂起
      const mask = m.root.querySelector('.modal-mask');
      if (mask) mask.addEventListener('click', (e) => { if (e.target === mask) finish('cancel'); });
      m.root.querySelector('#c-cancel').onclick = () => finish('cancel');
      m.root.querySelector('#c-unpaid').onclick = () => finish('unpaid');
      m.root.querySelector('#c-paid').onclick = () => finish('paid');
    });
  }

  // ---------- 库存管理 ----------
  async function renderInventory() {
    $('#topbar-actions').innerHTML = `<label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-soft)"><input type="checkbox" id="inv-low"> 仅看预警</label>`;
    $('#content').innerHTML = `<div class="card"><div id="inv-body" class="table-wrap"><p class="empty">加载中…</p></div></div>`;
    const load = debounce(async () => {
      const low = $('#inv-low').checked ? '1' : '';
      const rows = await api('GET', `/api/inventory?low=${low}`);
      $('#inv-body').innerHTML = invTable(rows);
      $$('#inv-body tr[data-id]').forEach((tr) => {
        tr.querySelector('[data-act="lots"]').onclick = () => openLotsModal(tr.dataset.id);
        tr.querySelector('[data-act="adj"]').onclick = () => openAdjustModal(tr.dataset.id);
        const lg = tr.querySelector('[data-act="logs"]');
        if (lg) lg.onclick = () => openStockLogsModal(tr.dataset.id);
      });
    }, 200);
    $('#inv-low').addEventListener('change', load);
    load();
  }

  function invTable(rows) {
    if (!rows.length) return '<p class="empty">暂无商品</p>';
    return `<table><thead><tr><th>SKU</th><th>名称</th><th>分类</th><th class="num">库存</th><th class="num">下限</th><th>状态</th><th>操作</th></tr></thead><tbody>
      ${rows.map(p => `<tr data-id="${p.id}"><td>${esc(p.sku || '-')}</td><td>${esc(p.name)}</td><td>${esc(p.category || '-')}</td>
        <td class="num">${intf(p.stock)}</td><td class="num">${intf(p.min_stock)}</td>
        <td>${p.stock <= p.min_stock ? '<span class="tag warn">预警</span>' : '<span class="tag ok">正常</span>'}</td>
        <td><button class="btn-ghost small" data-act="lots">批次</button> <button class="btn-ghost small" data-act="logs">流水</button> <button class="btn-ghost small" data-act="adj">盘点调整</button></td></tr>`).join('')}
    </tbody></table>`;
  }

  async function openAdjustModal(id) {
    const p = state.cache.products.find(x => x.id == id);
    const m = modal(`<h3>盘点调整 · ${esc(p.name)}</h3>
      <p style="color:var(--text-soft);font-size:13px">当前库存：${intf(p.stock)} ${esc(p.unit)}</p>
      <form id="af">
        <div class="field"><label>调整数量（正=盘盈/入库，负=盘亏/出库）</label><input name="delta" type="number" step="1" required placeholder="如 10 或 -5"></div>
        <div class="field"><label>原因</label><input name="reason" placeholder="如 盘点盈余 / 损耗报损"></div>
        <div class="modal-actions"><button type="button" class="btn-ghost" id="cancel">取消</button><button type="submit" class="btn-primary">确定调整</button></div>
      </form>`);
    m.root.querySelector('#cancel').onclick = m.close;
    m.root.querySelector('#af').addEventListener('submit', async (e) => {
      e.preventDefault(); const f = e.target;
      try { await api('POST', '/api/inventory/adjust', { product_id: id, delta: f.delta.value, reason: f.reason.value });
        toast('库存已更新'); m.close(); await refreshCache(); renderInventory(); }
      catch (err) { toast(err.message, true); }
    });
  }

  // 库存流水：/api/stock-logs 早就有了，但界面一直没有入口，
  // 盘点调整、退单、作废留下的痕迹用户看不到，出问题无从追溯。
  const STOCK_LOG_TYPES = {
    purchase: '采购入库', sale: '销售出库',
    purchase_return: '采购退单（退回供应商）', sale_return: '销售退货（回仓）',
    purchase_void: '作废采购单', sale_void: '作废销售单',
    adjust: '盘点调整'
  };
  async function openStockLogsModal(id) {
    const p = state.cache.products.find(x => x.id == id) || {};
    const head = (inner) => `<h3>库存流水 · ${esc(p.name || '')}</h3>${inner}`;
    const m = modal(head('<p class="empty">加载中…</p>'), 'modal-logs');
    try {
      const rows = await api('GET', `/api/stock-logs?product_id=${encodeURIComponent(id)}`);
      const sum = rows.reduce((s, r) => s + (Number(r.change_qty) || 0), 0);
      const drift = r2((Number(p.stock) || 0) - sum);
      const body = rows.length
        ? `<div class="table-scroll"><table class="log-table"><thead><tr>
            <th>时间</th><th>类型</th><th class="num">变动</th><th class="num">结存</th><th>关联</th><th>备注</th><th>操作人</th>
          </tr></thead><tbody>${rows.map(r => {
            const q = Number(r.change_qty) || 0;
            return `<tr><td class="time-col">${esc((r.created_at || '').replace('T', ' ').slice(0, 16))}</td>
              <td>${esc(STOCK_LOG_TYPES[r.type] || r.type || '-')}</td>
              <td class="num ${q >= 0 ? 'log-in' : 'log-out'}">${q > 0 ? '+' : ''}${intf(q)}</td>
              <td class="num">${intf(r.balance)}</td>
              <td>${r.ref_id ? `<span class="muted">#${r.ref_id}</span>` : '<span class="muted">—</span>'}</td>
              <td class="log-note" title="${esc(r.note || '')}">${esc(r.note || '-')}</td>
              <td>${esc(r.operator || '-')}</td></tr>`;
          }).join('')}</tbody></table></div>`
        : '<p class="empty">这个商品还没有出入库记录</p>';
      const driftTip = Math.abs(drift) > 0.001
        ? `<div class="log-drift">流水累计 ${intf(sum)}，当前库存 ${intf(p.stock)}，差额 <b>${intf(drift)}</b>。差额通常来自系统启用前录入的期初库存；若对不上，可在「盘点调整」里修正。</div>`
        : '';
      m.set(head(`<p class="muted" style="font-size:13px;margin:-6px 0 12px">当前库存 <b>${intf(p.stock)}</b> ${esc(p.unit || '')} · 共 ${rows.length} 条记录（最多显示最近 500 条）</p>${body}${driftTip}
        <div class="modal-actions"><button type="button" class="btn-ghost" id="logs-close">关闭</button></div>`));
      const closeBtn = m.box.querySelector('#logs-close');
      if (closeBtn) closeBtn.onclick = m.close;
    } catch (e) {
      m.set(head(`<p class="empty">${esc(e.message)}</p>`));
    }
  }

  // 批次明细：展示某商品当前在库批次（供应商/批号/单价/剩余-总量/入库时间），体现同品不同供应商/批次价差
  async function openLotsModal(id) {
    const p = state.cache.products.find(x => x.id == id) || {};
    const head = (inner) => `<h3>批次明细 · ${esc(p.name || '')}</h3>${inner}`;
    const m = modal(head('<p class="empty">加载中…</p>'), 'modal-lots');
    try {
      const data = await api('GET', `/api/products/${encodeURIComponent(id)}/lots`);
      const srcLabel = { purchase: '采购入库', sale_return: '销售退回', adjust: '盘点增益' };
      const body = data.lots.length
        ? `<p class="muted" style="font-size:13px;margin:-6px 0 12px">加权均价 <b>${yuan(data.product.purchase_price)}</b> · 在库批次 ${data.lots.length} 个 · 总数量 ${intf(data.totalQty)} · 货值 ${yuan(data.totalCost)}</p>
           <div class="table-scroll"><table class="log-table"><thead><tr>
             <th>批号</th><th>供应商</th><th>来源</th><th class="num">单价</th><th class="num">总量</th><th class="num">剩余</th><th>入库时间</th>
           </tr></thead><tbody>${data.lots.map(l => `<tr>
             <td>${esc(l.batch_no || '-')}</td>
             <td>${esc(l.supplier_name || '-')}</td>
             <td>${esc(srcLabel[l.source] || l.source || '-')}</td>
             <td class="num">${yuan(l.unit_cost)}</td>
             <td class="num">${intf(l.qty)}</td>
             <td class="num">${intf(l.remaining_qty)}</td>
             <td class="time-col">${esc((l.received_at || '').replace('T', ' ').slice(0, 16))}</td>
           </tr>`).join('')}</tbody></table></div>`
        : '<p class="empty">这个商品当前没有在库批次</p>';
      m.set(head(`${body}<div class="modal-actions"><button type="button" class="btn-ghost" id="lots-close">关闭</button></div>`));
      const closeBtn = m.box.querySelector('#lots-close');
      if (closeBtn) closeBtn.onclick = m.close;
    } catch (e) {
      m.set(head(`<p class="empty">${esc(e.message)}</p>`));
    }
  }

  // ---------- 报表 ----------
  // 报表下钻状态：null=总览；{kind:'payable'|'receivable'} 汇总；{kind:'supplier'|'customer',id} 单家明细
  let reportDrill = null;
  // 报表日期段：默认当月（本月 1 日 ~ 今天），起始/结束均可自选
  const pad2 = (x) => String(x).padStart(2, '0');
  const localDate = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
  const monthStart = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-01`; };
  let reportFrom = monthStart();   // YYYY-MM-DD
  let reportTo = localDate();      // YYYY-MM-DD
  function gotoReport(d) { reportDrill = d; renderReports(); }

  function repSummaryTable(rows, kind) {
    if (!rows.length) return '<p class="empty">暂无' + (kind === 'supplier' ? '有应付的供应商' : '有应收的客户') + '</p>';
    const head = kind === 'supplier'
      ? `<th>供应商</th><th class="num">总采购</th><th class="num">已付</th><th class="num">应付未付</th><th></th>`
      : `<th>客户</th><th class="num">总销售</th><th class="num">已收</th><th class="num">应收未收</th><th class="num">授信额度</th><th>状态</th><th></th>`;
    const body = rows.map(r => {
      if (kind === 'supplier') {
        return `<tr data-id="${r.id}"${r.unlinked ? ' class="row-unlinked"' : ''}><td>${esc(r.name)}</td><td class="num">${yuan(r.total)}</td><td class="num">${yuan(r.paid)}</td><td class="num"><b>${yuan(r.payable)}</b></td><td class="ops"><button class="btn-ghost small" data-detail="${r.id}">查看明细</button></td></tr>`;
      }
      const over = r.over_limit ? `<span class="tag danger">超授信</span>` : `<span class="tag good">正常</span>`;
      // 散客（未指定客户）无授信额度概念，相关列显示「—」
      const creditCell = (r.credit_limit == null) ? '<span class="muted">—</span>' : yuan(r.credit_limit);
      const statusCell = (r.credit_limit == null) ? '<span class="muted">—</span>' : over;
      return `<tr data-id="${r.id}"${r.unlinked ? ' class="row-unlinked"' : ''}><td>${esc(r.name)}</td><td class="num">${yuan(r.total)}</td><td class="num">${yuan(r.received)}</td><td class="num ${r.over_limit ? 'danger' : ''}"><b>${yuan(r.receivable)}</b></td><td class="num">${creditCell}</td><td>${statusCell}</td><td class="ops"><button class="btn-ghost small" data-detail="${r.id}">查看明细</button></td></tr>`;
    }).join('');
    return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  // 库存商品金额统计卡片（收付款 / 报表 共用）
  function inventoryStatCards(sv) {
    sv = sv || { qty: 0, skuCount: 0, costValue: 0, retailValue: 0, grossMargin: 0, byCategory: [] };
    return `
      <div class="stat accent"><div class="label">库存商品总金额（成本）</div><div class="value">${yuan(sv.costValue)}</div><div class="sub">按采购价合计 · 可售货值 ${yuan(sv.retailValue)}</div></div>
      <div class="stat"><div class="label">库存商品货值（售价）</div><div class="value">${yuan(sv.retailValue)}</div><div class="sub">${sv.grossMargin > 0 ? `潜在毛利 ${yuan(sv.grossMargin)}` : '按销售价合计'}</div></div>
      <div class="stat"><div class="label">库存总件数</div><div class="value">${intf(sv.qty)}</div><div class="sub">共 ${intf(sv.skuCount)} 种商品 · ${(sv.byCategory || []).length} 个分类</div></div>`;
  }

  function inventoryCategoryTable(rows) {
    if (!rows || !rows.length) return '<p class="empty">暂无库存商品</p>';
    const total = rows.reduce((s, r) => ({ qty: s.qty + (r.qty || 0), cost: s.cost + (r.costValue || 0), retail: s.retail + (r.retailValue || 0) }), { qty: 0, cost: 0, retail: 0 });
    const body = rows.map(r => `<tr><td>${esc(r.category)}</td><td class="num">${intf(r.qty)}</td><td class="num">${yuan(r.costValue)}</td><td class="num">${yuan(r.retailValue)}</td></tr>`).join('');
    return `<div class="table-wrap"><table><thead><tr><th>分类</th><th class="num">库存数量</th><th class="num">成本金额</th><th class="num">售价货值</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr><td><b>合计</b></td><td class="num"><b>${intf(total.qty)}</b></td><td class="num"><b>${yuan(total.cost)}</b></td><td class="num"><b>${yuan(total.retail)}</b></td></tr></tfoot></table></div>`;
  }

  // 往来单位流水账：单据与收付款按时间倒序混排
  function partyLedgerView(d, kind) {
    const isSup = kind === 'supplier';
    const t = d.totals || {};
    const entries = d.entries || [];
    const bal = t.outstanding || 0;
    const adv = t.advance || 0;

    const head = `<th>时间</th><th>类型</th><th>单号 / 事项</th><th class="num">金额</th><th>说明</th>`;
    const body = entries.map(e => {
      const at = esc((e.at || '').replace('T', ' '));
      if (e.kind === 'doc') {
        const noteBits = [];
        if (e.deposit > 0.001) noteBits.push(`约定定金 ${yuan(e.deposit)}`);
        if (!isSup && e.profit != null) noteBits.push(`利润 ${yuan(e.profit)}`);
        if (e.note) noteBits.push(esc(e.note));
        return `<tr>
          <td class="nowrap">${at}</td>
          <td><span class="tag ${isSup ? 'primary' : 'good'}">${isSup ? '采购入库' : '销售出库'}</span></td>
          <td>${esc(e.no)}</td>
          <td class="num"><span class="lg-in">+${yuan(e.amount)}</span></td>
          <td class="muted">${noteBits.join(' · ') || '—'}</td>
        </tr>`;
      }
      const bits = [];
      bits.push(PAY_METHODS[e.method] || e.method || '现金');
      if (e.is_deposit) bits.unshift('定金');
      const allocs = e.allocs || [];
      if (allocs.length) bits.push('冲抵 ' + allocs.map(a => `${esc(a.bill_no || '')} ${yuan(a.amount)}`).join('、'));
      if (e.to_advance > 0.001) bits.push(`转预存 ${yuan(e.to_advance)}`);
      if (e.note) bits.push(esc(e.note));
      return `<tr>
        <td class="nowrap">${at}</td>
        <td><span class="tag ${e.is_deposit ? 'danger' : 'good'}">${e.is_deposit ? (isSup ? '付定金' : '收定金') : (isSup ? '付款' : '收款')}</span></td>
        <td class="muted">—</td>
        <td class="num"><span class="lg-out">−${yuan(e.amount)}</span></td>
        <td class="muted">${bits.join(' · ')}</td>
      </tr>`;
    }).join('');

    if (!entries.length) return '<p class="empty">该单位暂无往来流水</p>';
    return `
      <div class="table-wrap"><table>
        <thead><tr>${head}</tr></thead>
        <tbody>${body}</tbody>
        <tfoot><tr>
          <td colspan="3"><b>合计（${entries.length} 笔）</b></td>
          <td class="num"><b>${yuan(bal)}</b></td>
          <td class="muted">单据合计 ${yuan(t.docTotal)} − 已${isSup ? '付' : '收'} ${yuan(t.paidTotal)}${adv > 0.001 ? `（其中预存 ${yuan(adv)}）` : ''}</td>
        </tr></tfoot>
      </table></div>`;
  }

  function docDetailTable(list, kind) {
    if (!list.length) return '<p class="empty">该单位暂无相关单据</p>';
    const head = kind === 'supplier'
      ? `<th>采购单号</th><th class="num">金额</th><th class="num">已付</th><th class="num">未付</th><th>日期</th>`
      : `<th>销售单号</th><th class="num">金额</th><th class="num">已收</th><th class="num">未收</th><th class="num">利润</th><th>日期</th>`;
    const body = list.map(r => kind === 'supplier'
      ? `<tr><td>${esc(r.bill_no)}</td><td class="num">${yuan(r.total)}</td><td class="num">${yuan(r.paid)}</td><td class="num"><b>${yuan(r.outstanding)}</b></td><td>${esc((r.created_at || '').replace('T', ' '))}</td></tr>`
      : `<tr><td>${esc(r.bill_no)}</td><td class="num">${yuan(r.total)}</td><td class="num">${yuan(r.received)}</td><td class="num"><b>${yuan(r.outstanding)}</b></td><td class="num">${yuan(r.profit)}</td><td>${esc((r.created_at || '').replace('T', ' '))}</td></tr>`
    ).join('');
    return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  // ---------- 退单报表 / 改价报表 ----------
  let retStatus = 'all';   // all | returned | pending
  let retKeyword = '';
  let priceType = 'all';   // all | doc | product | purchase
  let priceKeyword = '';

  // 退单报表：采购退单 / 销售退单（含退单待审）
  function returnsReportView(d) {
    const stat = (s) => `${s.count} 笔 · ${yuan(s.amount)}`;
    const table = (side, isPur) => {
      if (!side.list.length) return `<p class="empty">本期间暂无${isPur ? '采购' : '销售'}退单</p>`;
      const body = side.list.map(r => {
        const pending = r.status === 'pending_return';
        return `<tr class="${pending ? 'row-pending' : 'row-returned'}">
          <td>${pending ? '<span class="tag pending">退单待审</span>' : '<span class="tag muted">已退单</span>'}</td>
          <td>${esc(r.bill_no)}</td>
          <td>${esc(r.party)}</td>
          <td class="product-cell" title="${esc(r.products)}">${esc(r.products) || '<span class="muted">—</span>'}</td>
          <td class="num"><b>${yuan(r.total)}</b></td>
          <td class="muted">${esc(r.reason) || '—'}</td>
          <td>${esc(r.requested_by) || '—'}<div class="muted" style="font-size:12px">${esc(r.requested_at)}</div></td>
          <td>${esc(r.approved_by) || '<span class="muted">待审批</span>'}<div class="muted" style="font-size:12px">${pending ? '' : esc(r.atFull)}</div></td>
        </tr>`;
      }).join('');
      return `<div class="table-scroll"><div class="table-wrap"><table>
        <thead><tr><th>状态</th><th>单号</th><th>${isPur ? '供应商' : '客户'}</th><th>商品</th><th class="num">单据金额</th><th>退单原因</th><th>申请人 / 时间</th><th>审批人 / 完成时间</th></tr></thead>
        <tbody>${body}</tbody>
        <tfoot><tr><td colspan="4"><b>合计（${side.count} 笔 · 已退 ${side.returnedCount} / 待审 ${side.pendingCount}）</b></td><td class="num"><b>${yuan(side.amount)}</b></td><td colspan="3" class="muted">已退 ${yuan(side.returnedAmount)} · 待审 ${yuan(side.pendingAmount)}</td></tr></tfoot>
      </table></div></div>`;
    };
    return `
      <div class="grid cols-4">
        <div class="stat accent"><div class="label">采购退单</div><div class="value">${stat(d.purchase)}</div><div class="sub">已退 ${d.purchase.returnedCount} 笔 / 待审 ${d.purchase.pendingCount} 笔</div></div>
        <div class="stat good"><div class="label">销售退单</div><div class="value">${stat(d.sale)}</div><div class="sub">已退 ${d.sale.returnedCount} 笔 / 待审 ${d.sale.pendingCount} 笔</div></div>
        <div class="stat warn"><div class="label">退单待审（锁定中）</div><div class="value">${d.totals.pendingCount} 笔</div><div class="sub">金额 ${yuan(d.totals.pendingAmount)} · 需管理员审批</div></div>
        <div class="stat"><div class="label">退单金额合计</div><div class="value">${yuan(d.totals.amount)}</div><div class="sub">共 ${d.totals.count} 笔（已退 ${yuan(d.totals.returnedAmount)}）</div></div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-title">筛选 <span class="muted" style="font-weight:400;font-size:12px">按退单 / 申请时间统计（${esc(d.period)}）</span></div>
        <div class="filter-bar">
          <label>状态<select id="ret-status">
            <option value="all"${d.status === 'all' ? ' selected' : ''}>全部（含待审）</option>
            <option value="returned"${d.status === 'returned' ? ' selected' : ''}>已退单</option>
            <option value="pending"${d.status === 'pending' ? ' selected' : ''}>退单待审</option>
          </select></label>
          <label>单号 / 单位 / 商品<input id="ret-kw" value="${esc(d.keyword)}" placeholder="模糊匹配"></label>
          <button class="btn-primary small" id="ret-go">查询</button>
          <button class="btn-ghost small" id="ret-reset">重置</button>
        </div>
      </div>
      <div class="card" style="margin-top:16px"><div class="card-title">采购退单明细（${esc(d.period)}）</div>${table(d.purchase, true)}</div>
      <div class="card" style="margin-top:16px"><div class="card-title">销售退单明细（${esc(d.period)}）</div>${table(d.sale, false)}</div>`;
  }

  // 改价报表：单据改价 / 商品调价 / 采购进价变动 + 收付款金额调整
  function priceReportView(d) {
    const s = d.summary || {};
    const rows = (d.list || []).map(r => {
      const up = r.diff > 0;
      const badge = r.type === 'product' ? '<span class="tag primary">商品调价</span>'
        : (r.type === 'purchase' ? '<span class="tag warn">进价变动</span>'
          : (r.doc_type === 'purchase' ? '<span class="tag gray">采购改价</span>' : '<span class="tag good">销售改价</span>'));
      return `<tr>
        <td class="nowrap">${esc(r.atFull)}</td>
        <td>${badge}</td>
        <td class="product-cell" title="${esc(r.product_name)}">${esc(r.product_name)}</td>
        <td class="nowrap">${esc(r.fieldText)}</td>
        <td class="num">${yuan(r.old_price)}</td>
        <td class="num"><b>${yuan(r.new_price)}</b></td>
        <td class="num ${up ? 'up' : 'down'}">${up ? '↑' : '↓'} ${yuan(Math.abs(r.diff))}</td>
        <td class="num">${r.qty > 0 ? intf(r.qty) : '—'}</td>
        <td class="num ${r.amount > 0 ? 'up' : (r.amount < 0 ? 'down' : '')}">${r.qty > 0 ? (r.amount > 0 ? '+' : '') + yuan(r.amount) : '<span class="muted">—</span>'}</td>
        <td class="nowrap">${esc(r.source) || '—'}</td>
        <td>${esc(r.party) || '<span class="muted">—</span>'}</td>
        <td>${esc(r.operator) || '—'}</td>
        <td class="muted">${esc(r.note) || '—'}</td>
      </tr>`;
    }).join('');
    const listHtml = (d.list || []).length
      ? `<div class="table-scroll"><div class="table-wrap"><table>
          <thead><tr><th>时间</th><th>类型</th><th>商品</th><th>价格项</th><th class="num">原价</th><th class="num">新价</th><th class="num">单价差</th><th class="num">数量</th><th class="num">影响金额</th><th>单号 / 来源</th><th>往来单位</th><th>操作人</th><th>备注</th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr><td colspan="8"><b>合计（${s.count} 条）</b></td><td class="num"><b>${yuan(s.netAmount)}</b></td><td colspan="4" class="muted">受数量影响，进价/售价变动分别汇总</td></tr></tfoot>
        </table></div></div>`
      : '<p class="empty">本期间暂无改价记录。生效范围：商品管理里改进货价/售价、开单时手动改单价、采购进价与上次不同（历史数据按采购序列自动推算）。</p>';

    const adjRows = (d.adjustments || []).map(a => `<tr>
        <td class="nowrap">${esc(a.at)}</td>
        <td><span class="tag gray">${esc(a.directionText)}</span></td>
        <td>${esc(a.party)}</td>
        <td class="num">${yuan(a.old_amount)}</td>
        <td class="num"><b>${yuan(a.new_amount)}</b></td>
        <td class="num ${a.diff > 0 ? 'up' : 'down'}">${a.diff > 0 ? '+' : ''}${yuan(a.diff)}</td>
        <td><span class="tag ${a.status === 'approved' ? 'good' : (a.status === 'pending' ? 'pending' : 'muted')}">${esc(a.statusText)}</span></td>
        <td>${esc(a.requested_by) || '—'}<div class="muted" style="font-size:12px">${esc(a.requested_at)}</div></td>
        <td>${esc(a.approved_by) || '—'}<div class="muted" style="font-size:12px">${esc(a.approved_at)}</div></td>
        <td class="muted">${esc(a.status === 'rejected' ? (a.reject_reason || a.reason) : a.reason) || '—'}</td>
      </tr>`).join('');

    const adjCard = (d.adjustments || []).length ? `
      <div class="card" style="margin-top:16px">
        <div class="card-title">收付款金额调整记录 <span class="tag gray">调账（非商品单价）</span></div>
        <div class="table-scroll"><div class="table-wrap"><table>
          <thead><tr><th>时间</th><th>方向</th><th>往来单位</th><th class="num">原金额</th><th class="num">新金额</th><th class="num">差额</th><th>状态</th><th>申请人 / 时间</th><th>审批人 / 时间</th><th>说明</th></tr></thead>
          <tbody>${adjRows}</tbody>
        </table></div></div>
      </div>` : '';

    return `
      <div class="grid cols-4">
        <div class="stat"><div class="label">改价记录</div><div class="value">${s.count} 条</div><div class="sub">期间 ${esc(d.period)}</div></div>
        <div class="stat warn"><div class="label">价格上调</div><div class="value">${s.upCount} 条</div><div class="sub">影响金额 ${yuan(s.upAmount)}</div></div>
        <div class="stat good"><div class="label">价格下调</div><div class="value">${s.downCount} 条</div><div class="sub">影响金额 ${yuan(s.downAmount)}</div></div>
        <div class="stat accent"><div class="label">净影响金额</div><div class="value">${yuan(s.netAmount)}</div><div class="sub">按数量折算（正=整体涨价）</div></div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-title">筛选</div>
        <div class="filter-bar">
          <label>类型<select id="prc-type">
            <option value="all"${d.type === 'all' ? ' selected' : ''}>全部</option>
            <option value="doc"${d.type === 'doc' ? ' selected' : ''}>单据改价</option>
            <option value="product"${d.type === 'product' ? ' selected' : ''}>商品调价</option>
            <option value="purchase"${d.type === 'purchase' ? ' selected' : ''}>进价变动</option>
          </select></label>
          <label>商品 / 单号 / 单位<input id="prc-kw" value="${esc(d.keyword)}" placeholder="模糊匹配"></label>
          <button class="btn-primary small" id="prc-go">查询</button>
          <button class="btn-ghost small" id="prc-reset">重置</button>
        </div>
      </div>
      <div class="card" style="margin-top:16px"><div class="card-title">改价明细（${esc(d.period)}）</div>${listHtml}</div>
      ${adjCard}`;
  }

  async function renderReports() {
    const top = $('#topbar-actions');
    const back = !!reportDrill;
    top.innerHTML = (back ? `<button class="btn-ghost" id="rep-back">← 返回</button>` : '') +
      `<label class="period-label">起始</label><input type="date" id="rep-from" value="${reportFrom}" class="input-sm">
       <label class="period-label">结束</label><input type="date" id="rep-to" value="${reportTo}" class="input-sm">
       <button class="btn-primary small" id="rep-query">查询</button>
       <button class="btn-ghost small" id="rep-export">导出 Excel</button>`;
    const content = $('#content');

    // ---- 单家往来流水账 ----
    if (reportDrill && reportDrill.kind === 'supplier') {
      const d = await api('GET', `/api/reports/party/supplier/${reportDrill.id}/ledger`);
      const t = d.totals || {};
      content.innerHTML = `
        <div class="grid cols-3">
          <div class="stat"><div class="label">${esc(d.party.name)} · 累计采购（应付）</div><div class="value">${yuan(t.docTotal)}</div><div class="sub">约定定金合计 ${yuan(t.depositTotal)}</div></div>
          <div class="stat good"><div class="label">累计已付</div><div class="value">${yuan(t.paidTotal)}</div><div class="sub">含定金与预付款${t.advance > 0.001 ? ` · 未抵用预存 ${yuan(t.advance)}` : ''}</div></div>
          <div class="stat warn"><div class="label">应付未付（未结清）</div><div class="value">${yuan(t.outstanding)}</div><div class="sub">与"总应付"口径一致</div></div>
        </div>
        <div class="card" style="margin-top:16px"><div class="card-title">${esc(d.party.name)} · 往来流水账（按时间倒序）</div>${partyLedgerView(d, 'supplier')}</div>`;
      if ($('#rep-back')) $('#rep-back').onclick = () => gotoReport({ kind: 'payable' });
      bindPeriod();
      return;
    }
    if (reportDrill && reportDrill.kind === 'customer') {
      const d = await api('GET', `/api/reports/party/customer/${reportDrill.id}/ledger`);
      const t = d.totals || {};
      content.innerHTML = `
        <div class="grid cols-3">
          <div class="stat"><div class="label">${esc(d.party.name)} · 累计销售（应收）</div><div class="value">${yuan(t.docTotal)}</div><div class="sub">约定定金合计 ${yuan(t.depositTotal)}</div></div>
          <div class="stat good"><div class="label">累计已收</div><div class="value">${yuan(t.paidTotal)}</div><div class="sub">含定金与预收款${t.advance > 0.001 ? ` · 未抵用预存 ${yuan(t.advance)}` : ''}</div></div>
          <div class="stat warn"><div class="label">应收未收（未结清）</div><div class="value">${yuan(t.outstanding)}</div><div class="sub">与"总应收"口径一致</div></div>
        </div>
        <div class="card" style="margin-top:16px"><div class="card-title">${esc(d.party.name)} · 往来流水账（按时间倒序）</div>${partyLedgerView(d, 'customer')}</div>`;
      if ($('#rep-back')) $('#rep-back').onclick = () => gotoReport({ kind: 'receivable' });
      bindPeriod();
      return;
    }

    const [ar, pe] = await Promise.all([
      api('GET', '/api/reports/ar-ap'),
      api('GET', `/api/reports/period?from=${encodeURIComponent(reportFrom)}&to=${encodeURIComponent(reportTo)}`)
    ]);

    // ---- 按供应商/客户汇总 ----
    if (reportDrill && reportDrill.kind === 'payable') {
      content.innerHTML = `
        <div class="grid cols-4">
          <div class="stat warn"><div class="label">应付总额（未付）</div><div class="value">${yuan(ar.purchase.outstanding)}</div><div class="sub">已付 ${yuan(ar.purchase.paid)} / 共 ${yuan(ar.purchase.total)}</div></div>
        </div>
        <div class="card" style="margin-top:16px"><div class="card-title">应付未付 · 按供应商（含直采）</div>${repSummaryTable(ar.suppliers, 'supplier')}</div>`;
      if ($('#rep-back')) $('#rep-back').onclick = () => gotoReport(null);
      $$('#content [data-detail]').forEach(b => b.onclick = () => gotoReport({ kind: 'supplier', id: parseInt(b.dataset.detail) }));
      bindPeriod();
      return;
    }
    if (reportDrill && reportDrill.kind === 'receivable') {
      content.innerHTML = `
        <div class="grid cols-4">
          <div class="stat good"><div class="label">应收总额（未收）</div><div class="value">${yuan(ar.sale.outstanding)}</div><div class="sub">已收 ${yuan(ar.sale.received)} / 共 ${yuan(ar.sale.total)}</div></div>
        </div>
        <div class="card" style="margin-top:16px"><div class="card-title">应收未收 · 按客户（含散客）</div>${repSummaryTable(ar.customers, 'customer')}</div>`;
      if ($('#rep-back')) $('#rep-back').onclick = () => gotoReport(null);
      $$('#content [data-detail]').forEach(b => b.onclick = () => gotoReport({ kind: 'customer', id: parseInt(b.dataset.detail) }));
      bindPeriod();
      return;
    }

    // ---- 退单报表 ----
    if (reportDrill && reportDrill.kind === 'returns') {
      const qs = `?from=${encodeURIComponent(reportFrom)}&to=${encodeURIComponent(reportTo)}&status=${encodeURIComponent(retStatus)}&keyword=${encodeURIComponent(retKeyword)}`;
      const d = await api('GET', '/api/reports/returns' + qs);
      content.innerHTML = returnsReportView(d);
      if ($('#rep-back')) $('#rep-back').onclick = () => gotoReport(null);
      $('#ret-go').onclick = () => {
        retStatus = $('#ret-status').value;
        retKeyword = $('#ret-kw').value.trim();
        renderReports();
      };
      $('#ret-reset').onclick = () => { retStatus = 'all'; retKeyword = ''; renderReports(); };
      $('#ret-kw').onkeydown = (e) => { if (e.key === 'Enter') $('#ret-go').click(); };
      bindPeriod();
      return;
    }
    // ---- 改价报表 ----
    if (reportDrill && reportDrill.kind === 'price') {
      const qs = `?from=${encodeURIComponent(reportFrom)}&to=${encodeURIComponent(reportTo)}&type=${encodeURIComponent(priceType)}&keyword=${encodeURIComponent(priceKeyword)}`;
      const d = await api('GET', '/api/reports/price-changes' + qs);
      content.innerHTML = priceReportView(d);
      if ($('#rep-back')) $('#rep-back').onclick = () => gotoReport(null);
      $('#prc-go').onclick = () => {
        priceType = $('#prc-type').value;
        priceKeyword = $('#prc-kw').value.trim();
        renderReports();
      };
      $('#prc-reset').onclick = () => { priceType = 'all'; priceKeyword = ''; renderReports(); };
      $('#prc-kw').onkeydown = (e) => { if (e.key === 'Enter') $('#prc-go').click(); };
      bindPeriod();
      return;
    }

    // ---- 总览 ----
    const [retSum, prcSum] = await Promise.all([
      api('GET', `/api/reports/returns?from=${encodeURIComponent(reportFrom)}&to=${encodeURIComponent(reportTo)}&status=all`).catch(() => null),
      api('GET', `/api/reports/price-changes?from=${encodeURIComponent(reportFrom)}&to=${encodeURIComponent(reportTo)}&type=all`).catch(() => null)
    ]);
    content.innerHTML = `
      <div class="stat-section">
        <div class="stat-section-title">资金往来<span class="ss-sub">此刻还欠多少、别人还欠你多少</span></div>
        <div class="grid cols-3">
          <div class="stat good clickable" id="card-receivable"><div class="label">总应收（未收）</div><div class="value">${yuan(ar.totalReceivable)}</div><div class="sub">点此查看按客户明细 →</div></div>
          <div class="stat warn clickable" id="card-payable"><div class="label">总应付（未付）</div><div class="value">${yuan(ar.totalPayable)}</div><div class="sub">点此查看按供应商明细 →</div></div>
          <div class="stat"><div class="label">净头寸（应收-应付）</div><div class="value">${yuan(ar.net)}</div><div class="sub">正数=资金净流入</div></div>
        </div>
      </div>

      <div class="stat-section">
        <div class="stat-section-title">本期经营<span class="ss-sub">${esc(pe.period)}</span></div>
        <div class="grid cols-4">
          <div class="stat"><div class="label">本期销售额</div><div class="value">${yuan(pe.salesAmount)}</div><div class="sub">共 ${pe.saleCount == null ? '—' : intf(pe.saleCount)} 单</div></div>
          <div class="stat"><div class="label">本期采购额</div><div class="value">${yuan(pe.purchaseAmount)}</div><div class="sub">共 ${pe.purchaseCount == null ? '—' : intf(pe.purchaseCount)} 单</div></div>
          <div class="stat accent"><div class="label">本期利润（已实现）</div><div class="value">${yuan(pe.salesProfit)}</div><div class="sub">按单据记录的成本结算</div></div>
          <div class="stat"><div class="label">预计利润（销售额-进货额）</div><div class="value">${yuan(pe.estimatedProfit)}</div><div class="sub">粗算，仅参考</div></div>
        </div>
      </div>

      <div class="stat-section">
        <div class="stat-section-title">库存资金<span class="ss-sub">压在货上的钱</span></div>
        <div class="grid cols-3">
          ${inventoryStatCards(ar.stockValue)}
        </div>
      </div>
      <div class="card" style="margin-top:16px"><div class="card-title">库存商品金额 · 按分类</div>${inventoryCategoryTable(ar.stockValue && ar.stockValue.byCategory)}</div>
      <div class="card" style="margin-top:16px">
        <div class="card-title">专项报表 <span class="muted" style="font-weight:400;font-size:12px">（${esc(pe.period)}，点卡片查看明细）</span></div>
        <div class="grid cols-2">
          <div class="report-entry" id="card-returns">
            <div>
              <div class="re-title">🔁 采购 / 销售退单报表</div>
              <div class="re-sub">${retSum ? `本期退单 ${retSum.totals.count} 笔 · ${yuan(retSum.totals.amount)}${retSum.totals.pendingCount ? ` · 待审 ${retSum.totals.pendingCount} 笔` : ''}` : '退单明细、原因、审批人与时间'}</div>
            </div>
            <div class="re-go">查看 →</div>
          </div>
          <div class="report-entry" id="card-price">
            <div>
              <div class="re-title">💲 改价报表</div>
              <div class="re-sub">${prcSum ? `本期改价 ${prcSum.summary.count} 条 · 净影响 ${yuan(prcSum.summary.netAmount)}` : '商品调价、单据改价、进价变动、调账记录'}</div>
            </div>
            <div class="re-go">查看 →</div>
          </div>
        </div>
      </div>
      <div class="card" style="margin-top:16px"><div class="card-title">本期采购明细（${pe.period}）</div>${docDetailTable(pe.purchases, 'supplier')}</div>
      <div class="card" style="margin-top:16px"><div class="card-title">本期销售明细（${pe.period}）</div>${docDetailTable(pe.sales, 'customer')}</div>`;

    $('#card-receivable').onclick = () => gotoReport({ kind: 'receivable' });
    $('#card-payable').onclick = () => gotoReport({ kind: 'payable' });
    $('#card-returns').onclick = () => gotoReport({ kind: 'returns' });
    $('#card-price').onclick = () => gotoReport({ kind: 'price' });
    bindPeriod();

    function bindPeriod() {
      const f = $('#rep-from'), t = $('#rep-to'), q = $('#rep-query');
      if (f) f.onchange = (e) => { reportFrom = e.target.value; };
      if (t) t.onchange = (e) => { reportTo = e.target.value; };
      if (q) q.onclick = () => {
        if (reportFrom && reportTo && reportFrom > reportTo) return toast('起始日期不能晚于结束日期', true);
        renderReports();
      };
      const ex = $('#rep-export');
      if (ex) ex.onclick = () => exportReportExcel(ex);
    }
  }

  // 导出当前日期段的 Excel 报表（多工作表：概览/应收/应付/采购/销售/库存/收付款）
  async function exportReportExcel(btn) {
    if (btn) btn.disabled = true;
    try {
      const qs = `?from=${encodeURIComponent(reportFrom)}&to=${encodeURIComponent(reportTo)}`;
      const res = await fetch('/api/reports/export' + qs, { credentials: 'same-origin' });
      if (!res.ok) {
        let msg = '导出失败';
        try { const d = await res.json(); msg = d.error || msg; } catch (e) {}
        throw new Error(msg);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `经营报表_${reportFrom}_${reportTo}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast('已导出 Excel，请查看浏览器下载目录');
    } catch (e) {
      toast(e.message, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function docList(rows, kind) {
    if (!rows.length) return '<p class="empty">暂无单据</p>';
    return `<div class="table-wrap"><table><thead><tr><th>单号</th><th>${kind === 'sale' ? '客户' : '供应商'}</th><th class="num">金额</th><th class="num">${kind === 'sale' ? '利润' : '成本'}</th><th>时间</th></tr></thead><tbody>
      ${rows.slice(0, 12).map(r => `<tr><td>${esc(r.bill_no)}</td><td>${esc(kind === 'sale' ? (r.customer_name || '散客') : (r.supplier_name || '-'))}</td>
        <td class="num">${yuan(r.total_amount)}</td><td class="num">${yuan(kind === 'sale' ? r.total_profit : r.total_amount)}</td><td>${esc((r.created_at || '').replace('T', ' '))}</td></tr>`).join('')}
    </tbody></table></div>`;
  }

  function openPasswordModal() {
    const pol = pwdPolicy();
    const m = modal(`<h3>修改密码</h3>
      <form id="pwf">
        <div class="field"><label>原密码</label><input name="oldPassword" type="password" required></div>
        <div class="field"><label>新密码（至少 ${pol.minLen} 位）</label><input name="newPassword" type="password" required minlength="${pol.minLen}">
          <div class="field-hint">${esc(pol.label)}：${esc(pol.hint)}</div></div>
        <div class="modal-actions"><button type="button" class="btn-ghost" id="cancel">取消</button><button type="submit" class="btn-primary">更新</button></div>
      </form>`);
    m.root.querySelector('#cancel').onclick = m.close;
    m.root.querySelector('#pwf').addEventListener('submit', async (e) => {
      e.preventDefault(); const f = e.target;
      try { await api('POST', '/api/me/password', { oldPassword: f.oldPassword.value, newPassword: f.newPassword.value });
        toast('密码已更新'); m.close(); }
      catch (err) { toast(err.message, true); }
    });
  }

  // 账户菜单：手机端侧栏底部整块隐藏（.side-foot 在 ≤768px 下 display:none），
  // 所以顶栏留一个统一入口，改密/全屏/退出在手机上也能用
  function openAccountModal() {
    const u = state.user || {};
    const name = u.display_name || u.username || '';
    const m = modal(`<h3>账户</h3>
      <div class="acct-head">
        <div class="acct-avatar">${esc(String(name).slice(0, 1) || '?')}</div>
        <div class="acct-meta"><b>${esc(name)}</b><span>${esc(u.username || '')} · ${u.role === 'admin' ? '管理员' : '普通用户'}</span></div>
      </div>
      <div class="acct-acts">
        <button type="button" class="btn-ghost" id="acct-pwd">🔑 修改密码</button>
        <button type="button" class="btn-ghost" id="acct-fs">⛶ ${isFullscreen() ? '退出全屏' : '进入全屏'}</button>
        <button type="button" class="btn-ghost danger" id="acct-logout">退出登录</button>
      </div>`);
    m.box.querySelector('#acct-pwd').onclick = () => { m.close(); openPasswordModal(); };
    m.box.querySelector('#acct-fs').onclick = () => { m.close(); toggleFullscreen(); };
    m.box.querySelector('#acct-logout').onclick = () => { m.close(); doLogout(); };
  }

  // ---------- 收付款 ----------
  const PAY_METHODS = { cash: '现金', bank: '银行转账', alipay: '支付宝', wechat: '微信', other: '其他' };

  // 收付款明细筛选状态：采购与销售各自独立（互不挂钩），默认当月、全部退单状态
  let finPurFilters = null;   // 采购应付 { party, product, from, to, ret, status }
  let finSalFilters = null;   // 销售应收 { party, product, from, to, ret, status }
  let finSuppliers = [], finCustomers = [];
  let finPayLimit = 400;   // 收付款流水一次显示多少笔，「加载更多」时递增
  function finMonth() {
    const n = new Date(), y = n.getFullYear(), m = n.getMonth();
    const pad = (x) => String(x).padStart(2, '0');
    const last = new Date(y, m + 1, 0).getDate();
    return { from: `${y}-${pad(m + 1)}-01`, to: `${y}-${pad(m + 1)}-${pad(last)}` };
  }
  function finDefault() {
    const { from, to } = finMonth();
    return { party: '', product: '', from, to, ret: 'all', status: 'all' };
  }
  const finPur = () => finPurFilters || finDefault();
  const finSal = () => finSalFilters || finDefault();
  // 采购(p_*)与销售(s_*)两套独立参数一起带上，各自只影响自己的明细表
  function finQuery() {
    const p = finPur(), s = finSal();
    const qs = new URLSearchParams();
    if (p.party) qs.set('p_supplier', p.party);
    if (p.product) qs.set('p_product', p.product);
    if (p.from) qs.set('p_from', p.from);
    if (p.to) qs.set('p_to', p.to);
    qs.set('p_return', p.ret || 'all');
    qs.set('p_status', p.status || 'all');
    if (s.party) qs.set('s_customer', s.party);
    if (s.product) qs.set('s_product', s.product);
    if (s.from) qs.set('s_from', s.from);
    if (s.to) qs.set('s_to', s.to);
    qs.set('s_return', s.ret || 'all');
    qs.set('s_status', s.status || 'all');
    if (finPayLimit > 400) qs.set('pay_limit', String(finPayLimit));
    return '?' + qs.toString();
  }
  // 每张明细表各自的筛选条（含「退单」状态筛选）
  function finFilterBar(kind) {
    const isPur = kind === 'purchase';
    const f = isPur ? finPur() : finSal();
    const list = isPur ? finSuppliers : finCustomers;
    const label = isPur ? '供应商' : '客户';
    const opts = list.map(p => `<option value="${p.id}" ${String(f.party) === String(p.id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
    const retOpts = [['all', '全部'], ['normal', '正常(未退单)'], ['returned', '已退单'], ['pending', '退单待审']]
      .map(([v, t]) => `<option value="${v}" ${f.ret === v ? 'selected' : ''}>${t}</option>`).join('');
    const statusOpts = [['all', '全部'], ['unpaid', '未付款'], ['partial', '部分付款'], ['settled', '已结清']]
      .map(([v, t]) => `<option value="${v}" ${f.status === v ? 'selected' : ''}>${t}</option>`).join('');
    return `<div class="filter-bar">
      <label>${label}<select id="f-party-${kind}"><option value="">全部${label}</option>${opts}</select></label>
      <label>商品名称<input id="f-product-${kind}" value="${esc(f.product)}" placeholder="模糊匹配"></label>
      <label>状态<select id="f-status-${kind}">${statusOpts}</select></label>
      <label>退单<select id="f-return-${kind}">${retOpts}</select></label>
      <label>起始<input type="date" id="f-from-${kind}" value="${f.from}"></label>
      <label>结束<input type="date" id="f-to-${kind}" value="${f.to}"></label>
      <button class="btn-primary small" data-search="${kind}">查询</button>
      <button class="btn-ghost small" data-reset="${kind}">重置(当月)</button>
      <span class="fin-io">
        <button class="btn-ghost small" data-print="${kind}" title="按当前筛选条件打印本表（A4 横向，自动重复表头）">打印</button>
        <button class="btn-ghost small" data-export="${kind}" title="按当前筛选条件导出 Excel">导出 Excel</button>
      </span>
    </div>`;
  }

  async function renderFinance() {
    $('#topbar-actions').innerHTML = `<button class="btn-primary" id="add-pay">+ 记收付款</button><button class="btn-ghost" id="open-ledger">收付流水账</button>`;
    const [data, orphans] = await Promise.all([
      api('GET', '/api/finance/summary' + finQuery()),
      api('GET', '/api/payments/orphans').catch(() => [])
    ]);
    finSuppliers = data.suppliers || [];
    finCustomers = data.customers || [];
    const pur = data.purchase, sal = data.sale, adv = data.advances;
    // 挂在账外、不属于任何单位的钱：不进任何一家的预存，也不参与自动抵扣
    const orph = data.orphans || { count: 0, balance: 0 };
    state.cache.__purList = pur.list;
    state.cache.__salList = sal.list;
    // 状态：按「抵扣 / 现金 / 欠款」的构成显示，而不是笼统的「已结清 / 部分付款」
    const PAY_TAGS = {
      unpaid: ['未付款', 'danger'],
      adv_settled: ['抵扣付完', 'ok'],
      cash_settled: ['现金付完', 'ok'],
      adv_partial: ['抵扣部分+欠款', 'warn'],
      cash_partial: ['现金部分+欠款', 'warn'],
      mixed_settled: ['抵扣+现金付完', 'ok'],
      mixed_partial: ['抵扣+现金+欠款', 'warn']
    };
    const payTag = (r, type) => {
      const t = PAY_TAGS[r.pay_kind] || PAY_TAGS.unpaid;
      const bits = [];
      if (r.paid_advance > 0.001) bits.push(`抵扣 ${yuan(r.paid_advance)}`);
      if (r.paid_cash > 0.001) bits.push(`现金 ${yuan(r.paid_cash)}`);
      const verb = type === 'purchase' ? '已付' : '已收';
      const title = `${verb} ${yuan(r.paid)}${bits.length ? `（${bits.join(' + ')}）` : ''} / 单据 ${yuan(r.total)}，尚欠 ${yuan(r.outstanding)}`;
      return `<span class="tag ${t[1]}" title="${esc(title)}">${t[0]}</span>`;
    };
    const depTag = (s) => s === '-' ? '<span class="muted">—</span>' : s === '已付' ? '<span class="tag ok">定金已付</span>' : '<span class="tag warn">定金未付</span>';

    // 交易时间列（单据创建时间，精确到分；悬停看秒）
    const timeCell = (t) => {
      const full = String(t || '').replace('T', ' ');
      if (!full) return '<td class="time-col"><span class="muted">—</span></td>';
      return `<td class="time-col" title="${esc(full)}">${esc(full.slice(0, 16))}</td>`;
    };

    // 交易数量列：单品显示「数量 + 单位」（如 5 箱），多品显示总件数并标注项数，悬停看每项明细
    const qtyCell = (r) => {
      if (!(r.qty_total > 0)) return '<td class="num qty-col"><span class="muted">—</span></td>';
      const detail = r.qty_detail || '';
      if (r.item_count <= 1) {
        return `<td class="num qty-col" title="${esc(detail)}">${intf(r.qty_total)}${r.qty_unit ? `<span class="qty-unit">${esc(r.qty_unit)}</span>` : ''}</td>`;
      }
      return `<td class="num qty-col" title="${esc(detail)}">${intf(r.qty_total)}<span class="qty-items">·${r.item_count}项</span></td>`;
    };

    const docRow = (r, type) => {
      const advBal = type === 'purchase'
        ? (adv.suppliers.find(a => a.id === r.party_id)?.balance || 0)
        : (adv.customers.find(a => a.id === r.party_id)?.balance || 0);
      const canAdv = advBal > 0.001;
      const isAdmin = state.user.role === 'admin';
      const canReturn = perm('userReturn');
      const returnBtn = canReturn
        ? `<button class="btn-danger small" data-return="${type}" data-id="${r.id}">退单</button>`
        : `<button class="btn-ghost small" disabled title="管理员已在系统配置中关闭普通用户的退单权限">退单</button>`;
      const prod = `<td class="prod-col" title="${esc(r.products || '')}">${r.products ? esc(r.products) : '<span class="muted">—</span>'}</td>`;
      if (r.docStatus === 'returned') {
        const reason = r.return_reason || '';
        const approver = r.return_approved_by ? ` · 审批 ${esc(r.return_approved_by)}` : '';
        return `<tr class="row-returned"><td><a href="javascript:void 0" class="pname" data-doc="${type}" data-id="${r.id}" title="点击查看整单明细">${esc(r.bill_no)}</a></td>${timeCell(r.created_at)}<td>${esc(r.partner || (type === 'purchase' ? '直采' : '散客'))}</td>${prod}${qtyCell(r)}
          <td class="num">${yuan(r.total)}</td><td class="num">${r.deposit > 0.001 ? yuan(r.deposit) : '—'}</td><td>—</td>
          <td class="num">—</td><td class="num">—</td><td><span class="tag muted">已退单</span></td>
          <td class="ops"><span class="muted" title="${esc(reason)}">${reason ? esc(reason).slice(0, 8) + (reason.length > 8 ? '…' : '') : '—'}${approver}</span></td></tr>`;
      }
      if (r.docStatus === 'pending_return') {
        const reqBy = r.return_requested_by || '';
        const reqAt = (r.return_requested_at || '').slice(0, 16);
        return `<tr class="row-pending"><td><a href="javascript:void 0" class="pname" data-doc="${type}" data-id="${r.id}" title="点击查看整单明细">${esc(r.bill_no)}</a></td>${timeCell(r.created_at)}<td>${esc(r.partner || (type === 'purchase' ? '直采' : '散客'))}</td>${prod}${qtyCell(r)}
          <td class="num">${yuan(r.total)}</td><td class="num">${r.deposit > 0.001 ? yuan(r.deposit) : '—'}</td><td>—</td>
          <td class="num">${yuan(r.paid)}</td><td class="num">${yuan(r.outstanding)}</td>
          <td><span class="tag pending">退单待审</span></td>
          <td class="ops">${isAdmin ? `<button class="btn-warn small" data-approve="${type}" data-id="${r.id}">审批退单</button>` : `<span class="muted" title="${esc(reqAt)}">${esc(reqBy)} 申请中</span>`}</td></tr>`;
      }
      return `<tr><td><a href="javascript:void 0" class="pname" data-doc="${type}" data-id="${r.id}" title="点击查看整单明细">${esc(r.bill_no)}</a></td>${timeCell(r.created_at)}<td>${esc(r.partner || (type === 'purchase' ? '直采' : '散客'))}</td>${prod}${qtyCell(r)}
        <td class="num">${yuan(r.total)}</td><td class="num">${r.deposit > 0.001 ? yuan(r.deposit) : '—'}</td><td>${r.deposit > 0.001 ? depTag(r.deposit_status) : '—'}</td>
        <td class="num">${yuan(r.paid)}</td><td class="num">${yuan(r.outstanding)}</td><td>${payTag(r, type)}</td>
        <td class="ops"><button class="btn-ghost small" data-pay="${type}" data-id="${r.id}">${type === 'purchase' ? '付款' : '收款'}</button>${canAdv ? ` <button class="btn-ghost small" data-adv="${type}" data-id="${r.id}" data-bal="${advBal}">用预付款抵扣</button>` : ''} ${returnBtn}${isAdmin ? ` <button class="btn-ghost small" data-void="${type}" data-id="${r.id}" title="彻底撤销这张录错的单据：回滚库存、撤销收付款分摊，并删除单据本身">作废</button>` : ''}</td></tr>`;
    };

    $('#content').innerHTML = `
      <div class="grid cols-4">
        <div class="stat warn"><div class="label">应付未付（采购）</div><div class="value">${yuan(pur.outstanding)}</div><div class="sub">已付 ${yuan(pur.paid)} / 共 ${yuan(pur.total)}</div></div>
        <div class="stat good"><div class="label">应收未收（销售）</div><div class="value">${yuan(sal.outstanding)}</div><div class="sub">已收 ${yuan(sal.paid)} / 共 ${yuan(sal.total)}</div></div>
        <div class="stat"><div class="label">净头寸（应收-应付）</div><div class="value">${yuan(data.net)}</div><div class="sub">正数=资金净流入</div></div>
        <div class="stat accent"><div class="label">预付款/预收款余额</div><div class="value">${yuan(adv.total)}</div><div class="sub">${orph.balance > 0.001 ? `另有 ${yuan(orph.balance)} 未指定单位` : '可抵扣后续单据'}</div></div>
      </div>
      ${orph.balance > 0.001 ? `<div style="margin-top:12px;padding:10px 14px;border-radius:8px;background:var(--warn-soft);color:var(--warn);font-size:13px;line-height:1.7">
        有 <b>${orph.count} 笔共 ${yuan(orph.balance)}</b> 的收付款<b>没有指定往来单位</b>。
        这笔钱不属于任何客户/供应商，所以上面的预存余额里<b>不包含它</b>，也不会自动抵扣后续单据——
        这就是「实际收到的钱」和「各单位预存合计」对不上时的差额所在。请到下方「未关联往来单位的预收/预付款」里指定单位。
      </div>` : ''}

      <div class="grid cols-3" style="margin-top:12px">
        ${inventoryStatCards(data.stockValue)}
      </div>

      ${orphanCard(orphans)}

      <div class="card" style="margin-top:16px">
        <div class="card-title">采购应付明细 <span class="tag warn">${pur.listStats.unpaid} 笔未付 · ${pur.listStats.partial} 笔部分 · ${pur.listStats.settled} 笔已结清</span>${pur.listStats.returned ? ` <span class="tag muted">${pur.listStats.returned} 笔已退单</span>` : ''}${pur.listStats.pending ? ` <span class="tag pending">${pur.listStats.pending} 笔退单待审</span>` : ''}</div>
        ${finFilterBar('purchase')}
        <div class="table-scroll"><div class="table-wrap">
          <table class="fin-table"><thead><tr><th>采购单号</th><th>交易时间</th><th>供应商</th><th>商品名称</th><th class="num">数量</th><th class="num">总金额</th><th class="num">定金(约定)</th><th>定金状态</th><th class="num">已付</th><th class="num">未付</th><th>状态</th><th>操作</th></tr></thead><tbody>
            ${pur.list.length ? pur.list.map(r => docRow(r, 'purchase')).join('') : '<tr><td colspan="12" class="empty">暂无符合条件的采购单</td></tr>'}
          </tbody></table>
        </div></div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-title">销售应收明细 <span class="tag warn">${sal.listStats.unpaid} 笔未收 · ${sal.listStats.partial} 笔部分 · ${sal.listStats.settled} 笔已结清</span>${sal.listStats.returned ? ` <span class="tag muted">${sal.listStats.returned} 笔已退单</span>` : ''}${sal.listStats.pending ? ` <span class="tag pending">${sal.listStats.pending} 笔退单待审</span>` : ''}</div>
        ${finFilterBar('sale')}
        <div class="table-scroll"><div class="table-wrap">
          <table class="fin-table"><thead><tr><th>销售单号</th><th>交易时间</th><th>客户</th><th>商品名称</th><th class="num">数量</th><th class="num">总金额</th><th class="num">定金(约定)</th><th>定金状态</th><th class="num">已收</th><th class="num">未收</th><th>状态</th><th>操作</th></tr></thead><tbody>
            ${sal.list.length ? sal.list.map(r => docRow(r, 'sale')).join('') : '<tr><td colspan="12" class="empty">暂无符合条件的销售单</td></tr>'}
          </tbody></table>
        </div></div>
      </div>

      <div class="grid cols-2" style="margin-top:16px">
        <div class="card"><div class="card-title">供应商预付款余额</div>${advList(adv.suppliers, 'supplier')}</div>
        <div class="card"><div class="card-title">客户预收款余额</div>${advList(adv.customers, 'customer')}</div>
      </div>

      ${adjustmentCard(data.adjustments, state.user.role === 'admin')}

      <div class="card" style="margin-top:16px">
        <div class="card-title">收付款流水
          <span class="tag gray">${data.payments_total || 0} 笔</span>
          <span class="muted" style="font-weight:400;font-size:12px">${state.user.role === 'admin' ? '金额可点「调整金额」修改（立即生效），录错的记录可直接删除' : (perm('userAdjustAmount') ? '金额可点「调整金额」修改（需管理员审批）' : '普通用户的金额调整权限已由管理员关闭')}</span>
        </div>
        <div class="table-wrap">
          <table><thead><tr><th>时间</th><th>类型</th><th>往来单位</th><th>分摊单据</th><th class="num">金额</th><th>方式</th><th>备注</th><th>操作人</th><th>操作</th></tr></thead><tbody>
            ${data.payments.length ? data.payments.map(p => payRow(p)).join('') : '<tr><td colspan="9" class="empty">暂无收付款记录</td></tr>'}
          </tbody></table>
        </div>
        ${(data.payments_total || 0) > data.payments.length ? `<div class="load-more">
          <span class="muted">已显示最近 ${data.payments.length} 笔，还有 ${data.payments_total - data.payments.length} 笔更早的记录</span>
          <button class="btn-ghost small" id="pay-more">加载更多</button>
        </div>` : ''}
      </div>`;

    $('#add-pay').onclick = () => openPaymentModal();
    $('#open-ledger').onclick = () => openLedgerModal();
    // 为未归属的纯预付款/预收款指定往来单位
    $$('#content [data-orphan-do]').forEach(btn => btn.onclick = async () => {
      const id = btn.dataset.orphanDo, dir = btn.dataset.dir;
      const sel = $(`#content [data-orphan-party="${id}"]`);
      const pid = sel && sel.value;
      if (!pid) return toast('请选择往来单位', true);
      btn.disabled = true;
      try {
        await api('POST', `/api/payments/${id}/assign-party`, { party_type: dir === 'pay' ? 'supplier' : 'customer', party_id: parseInt(pid) });
        toast('已指定归属，后续交易将自动抵扣'); renderFinance();
      } catch (e) { toast(e.message, true); btn.disabled = false; }
    });
    $$('#content [data-pay]').forEach(btn => btn.onclick = () => openPaymentModal(btn.dataset.pay, parseInt(btn.dataset.id)));
    $$('#content [data-adv]').forEach(btn => btn.onclick = () => openApplyAdvanceModal(btn.dataset.adv, parseInt(btn.dataset.id), parseFloat(btn.dataset.bal)));
    // 点单号看整单明细（商品、金额、备注可改、管理员可作废）
    $$('#content [data-doc]').forEach(a => a.onclick = () => openDocModal(a.dataset.doc, parseInt(a.dataset.id)));
    // 删除整笔收付款记录（管理员）：录错金额/方向、重复录入时用来更正
    $$('#content [data-del-pay]').forEach(btn => btn.onclick = async () => {
      const id = parseInt(btn.dataset.delPay), amt = parseFloat(btn.dataset.amt) || 0;
      if (!confirm(`确定删除这笔 ${yuan(amt)} 的收付款记录吗？\n\n删除后：\n· 分摊到单据的金额会被撤销，单据未结金额自动恢复；\n· 未分摊部分对应的预付款/预收款余额同步减少；\n· 该记录（含其金额调整申请）一并删除，不可撤销。`)) return;
      btn.disabled = true;
      try { await api('DELETE', `/api/payments/${id}`); toast('已删除该笔收付款记录'); await refreshCache(); renderFinance(); }
      catch (e) { toast(e.message, true); btn.disabled = false; }
    });
    $$('#content [data-return]').forEach(btn => btn.onclick = () => openReturnModal(btn.dataset.return, parseInt(btn.dataset.id)));
    // 作废单据（管理员）：彻底撤销一张录错的单
    $$('#content [data-void]').forEach(btn => btn.onclick = async () => {
      const type = btn.dataset.void, id = parseInt(btn.dataset.id);
      const reason = prompt(`作废${type === 'purchase' ? '采购' : '销售'}单的原因（会记入留痕）：`, '');
      if (reason === null) return;
      if (!confirm(`确认作废这张单据？\n\n· ${type === 'purchase' ? '库存会扣减本单商品数量' : '本单商品会退回库存'}\n· 该单的收付款分摊全部撤销（钱退回预付款/预收款）\n· 单据与明细将被删除，不可撤销`)) return;
      btn.disabled = true;
      try {
        await api('POST', `/api/${type === 'purchase' ? 'purchases' : 'sales'}/${id}/void`, { reason });
        toast('已作废该单据'); await refreshCache(); renderFinance();
      } catch (e) { toast(e.message, true); btn.disabled = false; }
    });
    $$('#content [data-approve]').forEach(btn => btn.onclick = () => openReturnModal(btn.dataset.approve, parseInt(btn.dataset.id)));
    $$('#content [data-ledger]').forEach(btn => btn.onclick = () => openLedgerModal(btn.dataset.ledger, parseInt(btn.dataset.id)));
    // 收付款金额调整：发起申请 / 管理员审批
    $$('#content [data-adj-pay]').forEach(btn => btn.onclick = () => openAdjustPaymentModal(parseInt(btn.dataset.adjPay), parseFloat(btn.dataset.adjAmt)));
    $$('#content [data-adj-approve]').forEach(btn => btn.onclick = async () => {
      if (!confirm('确认通过该金额调整？通过后金额立即生效。')) return;
      btn.disabled = true;
      try {
        const r = await api('POST', `/api/payments/adjustments/${btn.dataset.adjApprove}/approve`, {});
        let msg = `已通过，金额调整为 ${yuan(r.amount)}`;
        if (r.trimmed > 0.001) msg += `；撤销分摊 ${yuan(r.trimmed)}`;
        toast(msg); renderFinance();
      } catch (e) { toast(e.message, true); btn.disabled = false; }
    });
    $$('#content [data-adj-reject]').forEach(btn => btn.onclick = async () => {
      const reason = prompt('请输入驳回原因（可留空）：', '');
      if (reason === null) return;
      btn.disabled = true;
      try {
        await api('POST', `/api/payments/adjustments/${btn.dataset.adjReject}/reject`, { reason });
        toast('已驳回'); renderFinance();
      } catch (e) { toast(e.message, true); btn.disabled = false; }
    });
    // 明细筛选：采购、销售各自独立查询（互不挂钩），含退单状态筛选
    $$('#content [data-search]').forEach(btn => btn.onclick = () => {
      const kind = btn.dataset.search;
      const st = {
        party: $(`#content #f-party-${kind}`).value,
        product: $(`#content #f-product-${kind}`).value.trim(),
        ret: $(`#content #f-return-${kind}`).value,
        status: $(`#content #f-status-${kind}`).value,
        from: $(`#content #f-from-${kind}`).value,
        to: $(`#content #f-to-${kind}`).value
      };
      if (st.from && st.to && st.from > st.to) return toast('起始日期不能晚于结束日期', true);
      if (kind === 'purchase') finPurFilters = st; else finSalFilters = st;
      renderFinance();
    });
    $$('#content [data-reset]').forEach(btn => btn.onclick = () => {
      const kind = btn.dataset.reset;
      if (kind === 'purchase') finPurFilters = null; else finSalFilters = null;
      renderFinance();
    });
    // 打印 / 导出：都只作用于「当前已查询出的结果」，不会重新按全量取数
    $$('#content [data-print]').forEach(btn => btn.onclick = () => printFinance(btn.dataset.print));
    $$('#content [data-export]').forEach(btn => btn.onclick = () => exportFinance(btn, btn.dataset.export));
  }

  // 付款构成 → 纯文本状态（页面标签、打印、导出口径必须一致）
  const FIN_PAY_TEXT = {
    unpaid: '未付款', adv_settled: '抵扣付完', cash_settled: '现金付完',
    adv_partial: '抵扣部分+欠款', cash_partial: '现金部分+欠款',
    mixed_settled: '抵扣+现金付完', mixed_partial: '抵扣+现金+欠款'
  };
  const finRowStatus = (r) => (r.docStatus === 'returned' ? '已退单'
    : r.docStatus === 'pending_return' ? '退单待审'
      : (FIN_PAY_TEXT[r.pay_kind] || '未付款'));

  // 打印当前筛选结果：新开窗口写一份自包含 HTML。
  // 不直接 window.print() 主页面，原因有三：
  //   ① 明细表套在 .table-scroll（max-height:460px）里，直接打印只会得到可见的十来行；
  //   ② 主页面有侧栏、统计卡、操作按钮列，都得靠 @media print 一个个藏，容易漏；
  //   ③ 独立窗口能自己定页边距、横向纸张、跨页重复表头，还能让用户另存为 PDF。
  function printFinance(kind) {
    const isPur = kind === 'purchase';
    const list = isPur ? (state.cache.__purList || []) : (state.cache.__salList || []);
    if (!list.length) { toast('当前筛选条件下没有单据', true); return; }
    const f = isPur ? finPur() : finSal();
    const partyArr = isPur ? finSuppliers : finCustomers;
    const partyText = f.party
      ? ((partyArr.find(x => String(x.id) === String(f.party)) || {}).name || '全部')
      : '全部';
    const who = isPur ? '供应商' : '客户';
    const colPaid = isPur ? '已付' : '已收';
    const colDue = isPur ? '未付' : '未收';
    const brand = (state.branding && state.branding.shopName) || '';

    let cnt = 0, sumTotal = 0, sumPaid = 0, sumOut = 0, retCnt = 0;
    for (const r of list) {
      if (r.docStatus === 'returned') { retCnt++; continue; }
      cnt++; sumTotal += r.total; sumPaid += r.paid; sumOut += r.outstanding;
    }
    const body = list.map((r) => {
      const isRet = r.docStatus === 'returned';
      return `<tr${isRet ? ' class="ret"' : ''}>
        <td>${esc(r.bill_no)}</td>
        <td>${esc((r.created_at || '').slice(0, 16))}</td>
        <td>${esc(r.partner || (isPur ? '直采' : '散客'))}</td>
        <td class="prod">${esc(r.qty_detail || r.products || '—')}</td>
        <td class="num">${intf(r.qty_total)}</td>
        <td class="num">${yuan(r.total)}</td>
        <td class="num">${isRet ? '—' : yuan(r.paid)}</td>
        <td class="num">${isRet ? '—' : yuan(r.outstanding)}</td>
        <td>${esc(finRowStatus(r))}</td>
      </tr>`;
    }).join('');

    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${esc((brand ? brand + ' · ' : '') + (isPur ? '采购应付明细' : '销售应收明细'))}</title>
<style>
  @page { size: A4 landscape; margin: 10mm; }
  * { box-sizing: border-box; }
  body { font-family: "Microsoft YaHei","PingFang SC","Hiragino Sans GB",sans-serif; color:#111; font-size:12px; margin:0; padding:14px; }
  h1 { font-size:17px; margin:0 0 6px; letter-spacing:.5px; }
  .meta { color:#555; font-size:11.5px; line-height:1.8; margin-bottom:10px; }
  table { width:100%; border-collapse:collapse; }
  th, td { border:1px solid #b4b4b4; padding:5px 6px; text-align:left; vertical-align:top; }
  th { background:#efefef; font-weight:600; white-space:nowrap; }
  .num { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
  .prod { max-width:300px; word-break:break-all; }
  tr.ret td { color:#8a8a8a; }
  tfoot td { font-weight:700; background:#f7f7f7; }
  .foot { margin-top:10px; color:#666; font-size:11px; }
  @media print { thead { display:table-header-group; } tr { page-break-inside:avoid; } }
</style></head><body>
<h1>${esc((brand ? brand + ' · ' : '') + (isPur ? '采购应付明细' : '销售应收明细'))}</h1>
<div class="meta">
  ${who}：${esc(partyText)} ｜ 商品：${esc(f.product || '全部')} ｜ 状态：${esc(({ all: '全部', unpaid: '未付款', partial: '部分付款', settled: '已结清' })[f.status] || '全部')}
  ｜ 退单：${esc(({ all: '全部', normal: '正常(未退单)', returned: '已退单', pending: '退单待审' })[f.ret] || '全部')}
  ｜ 日期：${esc(f.from || '不限')} ~ ${esc(f.to || '不限')}<br>
  共 ${cnt} 笔${retCnt ? `（另有已退单 ${retCnt} 笔，不计入合计）` : ''}
</div>
<table>
  <thead><tr><th>单号</th><th>交易时间</th><th>${who}</th><th>商品明细</th><th class="num">数量</th><th class="num">总金额</th><th class="num">${colPaid}</th><th class="num">${colDue}</th><th>状态</th></tr></thead>
  <tbody>${body}</tbody>
  <tfoot><tr><td colspan="5">合计（${cnt} 笔，不含已退单）</td><td class="num">${yuan(sumTotal)}</td><td class="num">${yuan(sumPaid)}</td><td class="num">${yuan(sumOut)}</td><td></td></tr></tfoot>
</table>
<div class="foot">打印时间：${esc(new Date().toLocaleString('zh-CN', { hour12: false }))}</div>
</body></html>`;

    const w = window.open('', '_blank');
    if (!w) { toast('浏览器拦截了打印窗口，请允许本站弹窗后重试', true); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
    // 等一帧再唤起打印，避免部分浏览器在文档尚未就绪时打印出空白页
    setTimeout(() => { try { w.focus(); w.print(); } catch (e) { /* 用户可能在打印前已关窗 */ } }, 350);
  }

  // 导出当前筛选结果：参数直接复用 finQuery()，与页面查询用的是同一份 URL 参数
  async function exportFinance(btn, kind) {
    const isPur = kind !== 'sale';
    btn.disabled = true;
    try {
      const res = await fetch('/api/finance/export' + finQuery() + '&kind=' + kind, { credentials: 'same-origin' });
      if (!res.ok) {
        let msg = '导出失败';
        try { const d = await res.json(); msg = d.error || msg; } catch (e) { /* 忽略 */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${isPur ? '采购应付明细' : '销售应收明细'}_${fileStamp()}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast(`已导出${isPur ? '采购应付' : '销售应收'}明细`);
    } catch (err) { toast(err.message, true); }
    btn.disabled = false;
  }

  // 退单处理：根据单据状态与当前用户角色，分三种情况处理
  // - 普通用户：仅能「锁定」申请，等待管理员审批
  // - 管理员：可直接退单；对处于「退单待审」的单据可审批通过或驳回
  async function openReturnModal(type, id) {
    const isPur = type === 'purchase';
    const m = modal('<h3>加载中…</h3>');
    let detail;
    try {
      detail = await api('GET', `/api/${isPur ? 'purchases' : 'sales'}/${id}`);
    } catch (e) { m.close(); return toast(e.message, true); }
    const itemsHtml = (detail.items || []).map(it => `<li>${esc(it.product_name || it.name || '商品')} × ${intf(it.qty)} ${esc(it.unit || '')} · ${yuan(it.subtotal)}</li>`).join('');
    const isAdmin = state.user.role === 'admin';
    // 退单释放的钱会先冲抵该单位其它欠款，提示里说清楚，避免用户以为钱凭空少了
    const advTip = (r) => (r && r.advance_applied > 0.001)
      ? `；已自动冲抵${isPur ? '该供应商其它应付' : '该客户其它欠款'} ${yuan(r.advance_applied)}` : '';

    // 权限拦截：管理员关闭了普通用户退单权限时，不允许发起新的退单（待审单据仍可查看）
    if (!isAdmin && detail.status !== 'pending_return' && !perm('userReturn')) {
      m.set(`<h3>${isPur ? '采购' : '销售'}退单 · ${esc(detail.bill_no)}</h3>
        <div class="form-note warn">管理员已在「系统配置 → 操作权限」中关闭普通用户的退单权限，如需退单请联系管理员处理。</div>
        <div class="modal-actions"><button type="button" class="btn-ghost" id="close">知道了</button></div>`);
      m.root.querySelector('#close').onclick = m.close;
      return;
    }

    // 情况一：单据已处于「退单待审」
    if (detail.status === 'pending_return') {
      if (!isAdmin) {
        m.set(`<h3>${isPur ? '采购' : '销售'}退单 · ${esc(detail.bill_no)}</h3>
          <div class="form-note">该单据的退单申请已提交（申请人：<b>${esc(detail.return_requested_by || '')}</b> · ${esc((detail.return_requested_at || '').slice(0, 16))}），正在等待管理员审批，你无需重复操作。</div>
          <div class="modal-actions"><button type="button" class="btn-ghost" id="close">知道了</button></div>`);
        m.root.querySelector('#close').onclick = m.close;
        return;
      }
      // 管理员审批弹窗
      m.set(`<h3>${isPur ? '采购' : '销售'}退单审批 · ${esc(detail.bill_no)}</h3>
        <div class="form-note warn"><b>${esc(detail.return_requested_by || '')}</b> 于 ${esc((detail.return_requested_at || '').slice(0, 16))} 提交退单申请。审批通过后：① 回滚库存；② 释放已收/已付到预存；③ 不再计入应收/应付。</div>
        <p class="return-summary"><b>单据金额：</b>${yuan(detail.total_amount)} ｜ <b>约定定金：</b>${yuan(detail.deposit || 0)}</p>
        <div class="card-title" style="margin-top:8px">退货商品</div>
        <ul class="return-items">${itemsHtml || '<li>无明细</li>'}</ul>
        ${detail.return_reason ? `<div class="field" style="margin-top:8px"><label>申请原因</label><div class="muted">${esc(detail.return_reason)}</div></div>` : ''}
        <div class="field" style="margin-top:8px"><label>驳回原因（仅驳回时填写）</label><input id="ret-rej" placeholder="如：经核实无需退单"></div>
        <div class="modal-actions">
          <button type="button" class="btn-ghost" id="cancel">取消</button>
          <button type="button" class="btn-danger" id="reject">驳回</button>
          <button type="button" class="btn-primary" id="approve">通过审批并退单</button>
        </div>`);
      m.root.querySelector('#cancel').onclick = m.close;
      m.root.querySelector('#approve').onclick = async () => {
        const b = m.root.querySelector('#approve'); b.disabled = true;
        try { const r = await api('POST', `/api/${isPur ? 'purchases' : 'sales'}/${id}/return/approve`); toast('已通过审批，退单完成' + advTip(r)); m.close(); await refreshCache(); renderFinance(); }
        catch (e) { toast(e.message, true); b.disabled = false; }
      };
      m.root.querySelector('#reject').onclick = async () => {
        const reason = m.root.querySelector('#ret-rej').value;
        const b = m.root.querySelector('#reject'); b.disabled = true;
        try { await api('POST', `/api/${isPur ? 'purchases' : 'sales'}/${id}/return/reject`, { reason }); toast('已驳回，单据恢复正常'); m.close(); await refreshCache(); renderFinance(); }
        catch (e) { toast(e.message, true); b.disabled = false; }
      };
      return;
    }

    // 情况二：正常单据，发起退单
    const effect = isPur
      ? '采购退单将：① 库存<b>减少</b>上述商品（退给供应商）；② 该单已付金额先冲抵该供应商<b>其它未结清采购单</b>，剩余才转为<b>预付款余额</b>；③ 该单不再计入应付与采购统计。'
      : '销售退单将：① 库存<b>增加</b>上述商品（客户退货入库）；② 该单已收金额先冲抵该客户<b>其它未结清销售单</b>，剩余才转为<b>预收款余额</b>；③ 该单不再计入应收与销售统计。';
    const roleHint = isAdmin
      ? '你拥有<b>管理员</b>权限，确认后将<b>立即完成退单</b>。'
      : '你为<b>普通用户</b>，确认后单据将进入<b>退单待审</b>状态（锁定），需由<b>管理员审批</b>后才会真正完成退单。';
    m.set(`<h3>${isPur ? '采购' : '销售'}退单 · ${esc(detail.bill_no)}</h3>
      <div class="form-note">${effect}</div>
      <div class="form-note warn">${roleHint}</div>
      <p class="return-summary"><b>单据金额：</b>${yuan(detail.total_amount)} ｜ <b>约定定金：</b>${yuan(detail.deposit || 0)}</p>
      <div class="card-title" style="margin-top:8px">退货商品</div>
      <ul class="return-items">${itemsHtml || '<li>无明细</li>'}</ul>
      <div class="field" style="margin-top:8px"><label>退单原因（可选）</label><input id="ret-reason" placeholder="如：客户退货 / 采购错发"></div>
      <div class="modal-actions"><button type="button" class="btn-ghost" id="cancel">取消</button><button type="button" class="btn-danger" id="confirm">${isAdmin ? '确认退单' : '提交退单申请'}</button></div>`);
    m.root.querySelector('#cancel').onclick = m.close;
    m.root.querySelector('#confirm').onclick = async () => {
      const b = m.root.querySelector('#confirm'); b.disabled = true;
      try {
        const r = await api('POST', `/api/${isPur ? 'purchases' : 'sales'}/${id}/return`, { reason: m.root.querySelector('#ret-reason').value });
        if (r.executed) toast('已退单，库存与资金已回滚' + advTip(r));
        else toast('已提交退单申请，等待管理员审批');
        m.close(); await refreshCache(); renderFinance();
      } catch (e) { toast(e.message, true); b.disabled = false; }
    };
  }

  // 整单明细：商品明细 + 金额构成 + 备注修改 + （管理员）作废
  async function openDocModal(type, id) {
    const isPur = type === 'purchase';
    const path = isPur ? 'purchases' : 'sales';
    const m = modal('<h3>加载中…</h3>', 'modal-doc');
    let d;
    try { d = await api('GET', `/api/${path}/${id}`); } catch (e) { m.close(); return toast(e.message, true); }
    const party = isPur ? (d.supplier_name || '直采（未指定供应商）') : (d.customer_name || '散客（未指定客户）');
    const st = d.status === 'returned' ? '<span class="tag muted">已退单</span>'
      : d.status === 'pending_return' ? '<span class="tag pending">退单待审</span>'
        : '<span class="tag ok">生效中</span>';
    const isAdmin = state.user.role === 'admin';
    const items = d.items || [];
    const itemsHtml = items.length ? `<div class="table-wrap"><table><thead><tr>
        <th>商品</th><th>SKU</th><th class="num">数量</th><th class="num">单价</th><th class="num">小计</th>
        ${isPur ? '' : '<th class="num">成本</th><th class="num">利润</th>'}</tr></thead><tbody>
        ${items.map(it => `<tr><td>${esc(it.product_name || '-')}</td><td>${esc(it.sku || '-')}</td>
          <td class="num">${intf(it.qty)} ${esc(it.unit || '')}</td><td class="num">${yuan(it.price)}</td><td class="num">${yuan(it.subtotal)}</td>
          ${isPur ? '' : `<td class="num">${yuan(it.cost)}</td><td class="num ${it.profit < 0 ? 'danger' : ''}">${yuan(it.profit)}</td>`}</tr>`).join('')}
      </tbody></table></div>` : '<p class="empty">无明细</p>';

    m.set(`<h3>${isPur ? '采购入库单' : '销售出库单'} · ${esc(d.bill_no)} ${st}</h3>
      <div class="doc-meta">
        <div><span class="muted">${isPur ? '供应商' : '客户'}</span><b>${esc(party)}</b></div>
        <div><span class="muted">开单时间</span><b>${esc((d.created_at || '').replace('T', ' '))}</b></div>
        <div><span class="muted">开单人</span><b>${esc(d.operator || '-')}</b></div>
        <div><span class="muted">单据金额</span><b>${yuan(d.total_amount)}</b></div>
        <div><span class="muted">约定定金</span><b>${yuan(d.deposit || 0)}</b></div>
        ${isPur ? '' : `<div><span class="muted">预计利润</span><b class="${d.total_profit < 0 ? 'danger' : ''}">${yuan(d.total_profit || 0)}</b></div>`}
      </div>
      ${d.status === 'returned' ? `<div class="form-note">该单已于 ${esc((d.returned_at || '').slice(0, 16))} 退单${d.return_approved_by ? `（审批：${esc(d.return_approved_by)}）` : ''}${d.return_reason ? `，原因：${esc(d.return_reason)}` : ''}。</div>` : ''}
      <div class="card-title" style="margin-top:10px">商品明细 <span class="muted" style="font-weight:400">${items.length} 行</span></div>
      ${itemsHtml}
      <div class="field" style="margin-top:12px"><label>备注</label>
        <input id="doc-note" value="${esc(d.note || '')}" placeholder="给这张单加个说明（不影响金额）" maxlength="500"></div>
      <div class="modal-actions">
        <button type="button" class="btn-ghost" id="close">关闭</button>
        ${isAdmin && d.status !== 'returned' ? `<button type="button" class="btn-danger" id="void">作废此单</button>` : ''}
        <button type="button" class="btn-primary" id="save-note">保存备注</button>
      </div>
      <p class="modal-tip">作废 = 这张单压根不该存在（选错商品/数量、重复提交）：会回滚库存、撤销收付款分摊，并删除单据本身，留痕可在数据库 doc_voids 中查。真实发生的退货请用「退单」。</p>`);

    m.root.querySelector('#close').onclick = m.close;
    m.root.querySelector('#save-note').onclick = async (e) => {
      const b = e.currentTarget; b.disabled = true;
      try {
        await api('PUT', `/api/${path}/${id}/note`, { note: m.root.querySelector('#doc-note').value });
        toast('备注已保存'); m.close(); renderFinance();
      } catch (err) { toast(err.message, true); b.disabled = false; }
    };
    const vb = m.root.querySelector('#void');
    if (vb) vb.onclick = async () => {
      const reason = prompt(`作废 ${d.bill_no} 的原因（会记入留痕）：`, '');
      if (reason === null) return;
      if (!confirm(`确认作废 ${d.bill_no}？\n\n· ${isPur ? '库存会扣减本单商品数量' : '本单商品会退回库存'}\n· 该单的收付款分摊全部撤销（钱退回预付款/预收款）\n· 单据与明细将被删除，不可撤销`)) return;
      vb.disabled = true;
      try {
        await api('POST', `/api/${path}/${id}/void`, { reason });
        toast('已作废'); m.close(); await refreshCache(); renderFinance();
      } catch (err) { toast(err.message, true); vb.disabled = false; }
    };
  }

  // 收付流水账：按往来单位查看所有收付款明细 + 预付款/预收款余额 + 当前应付/应收
  function openLedgerModal(defType, defId) {
    const m = modal(`<h3>收付流水账</h3>
      <div class="form-row" style="margin-bottom:12px">
        <div class="field"><label>单位类型</label><select id="lg-type">
          <option value="supplier">供应商</option><option value="customer">客户</option></select></div>
        <div class="field"><label>往来单位</label><select id="lg-party"></select></div>
      </div>
      <div id="lg-body"><p class="empty">请选择往来单位</p></div>
      <div class="modal-actions"><button type="button" class="btn-ghost" id="lg-close">关闭</button></div>`);
    m.root.querySelector('#lg-close').onclick = m.close;
    const typeEl = m.root.querySelector('#lg-type');
    const partyEl = m.root.querySelector('#lg-party');
    const body = m.root.querySelector('#lg-body');

    async function loadParties() {
      const t = typeEl.value;
      const list = t === 'supplier' ? state.cache.suppliers : state.cache.customers;
      partyEl.innerHTML = list.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('') || '<option value="">（无）</option>';
      if (defId && t === defType) partyEl.value = defId;
    }
    async function loadLedger() {
      const pid = partyEl.value;
      if (!pid) { body.innerHTML = '<p class="empty">请选择往来单位</p>'; return; }
      const data = await api('GET', `/api/party-ledger?party_type=${typeEl.value}&party_id=${pid}`);
      const dirText = data.direction === 'pay' ? '应付/付款' : '应收/收款';
      const rows = data.transactions;
      const txRow = (t) => {
        const type = t.is_deposit ? '<span class="tag warn">定金</span>'
          : (t.direction === 'pay' ? '<span class="tag gray">付款</span>' : '<span class="tag good">收款</span>');
        const alloc = t.allocations.length
          ? t.allocations.map(a => `${esc(a.doc_no || (a.doc_type + a.doc_id))} ${yuan(a.amount)}`).join('，')
          : '<span class="muted">预付款/预收款（未分摊）</span>';
        const rest = r2(t.amount - t.alloc_total);
        const restCell = rest > 0.001 ? `<span class="tag primary">转预存 ${yuan(rest)}</span>` : '—';
        return `<tr><td>${esc((t.created_at || '').replace('T', ' '))}</td><td>${type}</td><td>${yuan(t.amount)}</td><td>${alloc}</td><td>${restCell}</td><td>${PAY_METHODS[t.method] || t.method}</td><td>${esc(t.note || '')}</td><td>${esc(t.operator || '')}</td></tr>`;
      };
      body.innerHTML = `
        <div class="grid cols-4" style="margin-bottom:12px">
          <div class="stat"><div class="label">${dirText}未结清</div><div class="value">${yuan(data.payable)}</div></div>
          <div class="stat accent"><div class="label">预付款/预收款余额</div><div class="value">${yuan(data.advance_balance)}</div></div>
          <div class="stat"><div class="label">累计收/付</div><div class="value">${yuan(data.direction === 'pay' ? data.summary.total_out : data.summary.total_in)}</div></div>
          <div class="stat"><div class="label">累计转预存</div><div class="value">${yuan(data.summary.to_advance)}</div></div>
        </div>
        <div class="card"><div class="card-title">${esc(data.party.name)} · 收付流水（共 ${rows.length} 笔）</div>
          <div class="table-wrap"><table><thead><tr><th>时间</th><th>类型</th><th class="num">金额</th><th>分摊单据</th><th>本笔转预存</th><th>方式</th><th>备注</th><th>操作人</th></tr></thead><tbody>
            ${rows.length ? rows.map(txRow).join('') : '<tr><td colspan="8" class="empty">暂无收付款记录</td></tr>'}
          </tbody></table></div>
        </div>`;
    }
    typeEl.addEventListener('change', async () => { await loadParties(); await loadLedger(); });
    partyEl.addEventListener('change', loadLedger);
    (async () => { if (defType) typeEl.value = defType; await loadParties(); await loadLedger(); })();
  }

  function advList(arr, kind) {
    if (!arr.length) return '<p class="empty">暂无' + (kind === 'supplier' ? '供应商预付款' : '客户预收款') + '</p>';
    return `<div class="table-wrap"><table><thead><tr><th>${kind === 'supplier' ? '供应商' : '客户'}</th><th class="num">预付款/预收款余额</th><th></th></tr></thead><tbody>
      ${arr.map(a => `<tr><td>${esc(a.name)}</td><td class="num">${yuan(a.balance)}</td><td class="ops"><button class="btn-ghost small" data-ledger="${kind}" data-id="${a.id}">流水</button></td></tr>`).join('')}
    </tbody></table></div>`;
  }

  function payRow(p) {
    const dir = p.is_deposit
      ? '<span class="tag warn">定金</span>'
      : (p.direction === 'pay'
        ? '<span class="tag gray">采购付款</span>'
        : '<span class="tag good">销售收款</span>');
    const allocList = p.allocations || [];
    const allocFull = allocList.map(a => `${a.doc_no || a.doc_type + a.doc_id} ${yuan(a.amount)}`).join('，');
    // 一张单的分摊常常有好几笔，整串铺开会把「金额 / 操作」两列挤出屏幕，
    // 因此只显示前两笔 + 「等 N 笔」，完整内容放在 title 里，鼠标悬停可看全。
    const alloc = allocList.length
      ? (allocList.length <= 2
        ? allocList.map(a => `${esc(a.doc_no || a.doc_type + a.doc_id)} ${yuan(a.amount)}`).join('，')
        : `${allocList.slice(0, 2).map(a => `${esc(a.doc_no || a.doc_type + a.doc_id)} ${yuan(a.amount)}`).join('，')} <span class="muted">等 ${allocList.length} 笔</span>`)
      : '<span class="muted">预付款/预收款（未分摊）</span>';
    const pa = p.pending_adjust;
    const adjTag = pa
      ? ` <span class="tag pending" title="${esc(pa.requested_by || '')} 申请于 ${esc((pa.requested_at || '').slice(0, 16))}">待审 ${yuan(pa.new_amount)}</span>`
      : '';
    const canAdjust = perm('userAdjustAmount');
    const adjustBtn = canAdjust
      ? `<button class="btn-ghost small" data-adj-pay="${p.id}" data-adj-amt="${p.amount}" title="调整这笔收付款的金额">调整</button>`
      : `<button class="btn-ghost small" disabled title="管理员已在系统配置中关闭普通用户的金额调整权限">调整</button>`;
    // 删除只给管理员：录错金额/方向、重复录入时用来彻底更正（会连带撤销分摊）
    const delBtn = state.user.role === 'admin' && !pa
      ? ` <button class="btn-danger small" data-del-pay="${p.id}" data-amt="${p.amount}" title="删除这笔收付款记录（连带撤销分摊）">删除</button>`
      : '';
    const ops = ((p.is_deposit ? '' : adjustBtn) + delBtn) || '<span class="muted">—</span>';
    return `<tr><td class="nowrap">${esc((p.created_at || '').replace('T', ' '))}</td><td>${dir}</td><td class="nowrap">${esc(p.party_name || '—')}</td><td class="alloc-cell" title="${esc(allocFull || '预付款/预收款（未分摊）')}">${alloc}</td><td class="num">${yuan(p.amount)}${adjTag}</td><td>${PAY_METHODS[p.method] || p.method}</td><td class="note-cell" title="${esc(p.note || '')}">${esc(p.note || '')}</td><td>${esc(p.operator || '')}</td><td class="ops">${ops}</td></tr>`;
  }

  // 金额调整申请卡片：管理员可审批，普通用户可查看自己的申请进度
  function adjustmentCard(list, isAdmin) {
    if (!list || !list.length) return '';
    const rows = list.map(a => {
      const dirTag = a.direction === 'pay' ? '<span class="tag gray">付款</span>' : '<span class="tag good">收款</span>';
      const diff = r2(a.new_amount - a.current_amount);
      const diffTag = diff > 0 ? `<span class="up">+${yuan(diff).slice(1)}</span>` : `<span class="down">-${yuan(Math.abs(diff)).slice(1)}</span>`;
      const ops = isAdmin
        ? `<button class="btn-primary small" data-adj-approve="${a.id}">通过</button> <button class="btn-danger small" data-adj-reject="${a.id}">驳回</button>`
        : '<span class="muted">等待管理员审批</span>';
      return `<tr>
        <td class="nowrap">${esc((a.requested_at || '').slice(0, 16))}</td>
        <td>${dirTag}</td>
        <td>${esc(a.party_name || '—')}</td>
        <td class="num">${yuan(a.current_amount)}</td>
        <td class="num"><b>${yuan(a.new_amount)}</b> ${diffTag}</td>
        <td class="num">${yuan(a.alloc)}</td>
        <td>${esc(a.reason || '—')}</td>
        <td>${esc(a.requested_by || '')}</td>
        <td class="ops">${ops}</td>
      </tr>`;
    }).join('');
    return `<div class="card" style="margin-top:16px">
      <div class="card-title">收付款金额调整${isAdmin ? '待审' : '申请进度'} <span class="tag pending">${list.length} 笔</span></div>
      <p class="muted" style="font-size:13px;margin:-8px 0 10px">${isAdmin ? '审批通过后金额立即生效；若新金额小于已分摊合计，超额分摊会被撤销，对应单据重新变为未结清。' : '提交的金额调整需管理员审批通过后才生效，审批前原金额保持不变。'}</p>
      <div class="table-wrap"><table><thead><tr><th>申请时间</th><th>方向</th><th>往来单位</th><th class="num">原金额</th><th class="num">调整为</th><th class="num">已分摊</th><th>原因</th><th>申请人</th><th>操作</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    </div>`;
  }

  // 调整收付款金额：管理员直接生效，普通用户提交待审申请
  function openAdjustPaymentModal(paymentId, currentAmount) {
    const isAdmin = state.user.role === 'admin';
    if (!perm('userAdjustAmount')) return toast('管理员已关闭普通用户的金额调整权限，如需修改请联系管理员', true);
    const m = modal(`<h3>调整收付款金额</h3>
      <div class="form-note">当前金额：<b>${yuan(currentAmount)}</b> · ${isAdmin ? '你是管理员，<b>确认后立即生效</b>。' : '提交后需<b>管理员审批</b>通过才生效，审批前金额不变。'}</div>
      <div class="field"><label>新金额 *</label><input id="adj-amount" type="number" step="0.01" min="0.01" value="${currentAmount}"></div>
      <div class="field"><label>调整原因</label><input id="adj-reason" placeholder="如：录入金额有误 / 实际到账金额不同"></div>
      <div class="form-note warn">新金额<b>小于</b>该笔已分摊合计时，超出部分会被撤销分摊，对应单据重新变为未结清；新金额<b>大于</b>原金额时，多出的部分会先冲抵该单位其它未结清单据，仍有剩余才计入预存余额。</div>
      <div class="modal-actions"><button type="button" class="btn-ghost" id="cancel">取消</button><button type="button" class="btn-primary" id="ok">${isAdmin ? '确认调整' : '提交审批'}</button></div>`);
    m.root.querySelector('#cancel').onclick = m.close;
    const btn = m.root.querySelector('#ok');
    btn.onclick = async () => {
      const amt = r2(parseFloat(m.root.querySelector('#adj-amount').value) || 0);
      if (!(amt > 0)) return toast('新金额必须大于 0', true);
      btn.disabled = true;
      try {
        const r = await api('POST', `/api/payments/${paymentId}/adjust`, { amount: amt, reason: m.root.querySelector('#adj-reason').value });
        m.close();
        if (r.executed) {
          let msg = `金额已调整为 ${yuan(r.amount)}`;
          if (r.trimmed > 0.001) msg += `；撤销分摊 ${yuan(r.trimmed)}`;
          toast(msg);
        } else {
          toast('已提交，等待管理员审批');
        }
        renderFinance();
      } catch (e) { toast(e.message, true); btn.disabled = false; }
    };
  }

  // 未关联往来单位的预存（无单据的纯预付款/预收款）——提供人工指定归属
  function orphanCard(list) {
    if (!list || !list.length) return '';
    // 指定归属 = 在两个往来账之间搬钱，服务端已限制为管理员，普通用户这里只做告知
    const canAssign = !!(state.user && state.user.role === 'admin');
    const rows = list.map(o => {
      const isPay = o.direction === 'pay';
      const opts = (isPay ? state.cache.suppliers : state.cache.customers)
        .map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('') || '<option value="">（无）</option>';
      return `<tr>
        <td class="nowrap">${esc((o.created_at || '').replace('T', ' '))}</td>
        <td><span class="tag ${isPay ? 'gray' : 'good'}">${isPay ? '付款' : '收款'}</span></td>
        <td class="num">${yuan(o.amount)}</td>
        <td class="num"><b>${yuan(o.balance)}</b></td>
        <td><select class="input-sm" data-orphan-party="${o.id}"${canAssign ? '' : ' disabled'}>${opts}</select></td>
        <td class="ops">${canAssign ? `<button class="btn-primary small" data-orphan-do="${o.id}" data-dir="${o.direction}">指定归属</button>` : '<span class="muted">需管理员操作</span>'}</td>
      </tr>`;
    }).join('');
    return `<div class="card" style="margin-top:16px">
      <div class="card-title">未关联往来单位的预收/预付款 <span class="tag danger">需指定</span></div>
      <p class="muted" style="font-size:13px;margin:-6px 0 10px">以下收付款没有关联供应商/客户，无法在后续交易中自动抵扣。请为它们指定归属单位。</p>
      <div class="table-wrap"><table><thead><tr><th>时间</th><th>类型</th><th class="num">金额</th><th class="num">未分摊(预存)</th><th>指定单位</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    </div>`;
  }

  // 记收付款：支持一付多票（分摊到多张单据），未分摊部分自动转预付款
  async function openPaymentModal(docType, docId) {
    // 单据缓存必须取「全部未结清」，不能复用收付款页那份按当月筛选过的列表：
    // 否则上个月的老欠单在分摊下拉里根本看不到，只能先记成预存再让系统按 FIFO 自动冲抵，
    // 用户想指定「这笔钱还哪张单」就做不到。这里显式把日期放宽到全量再覆盖缓存。
    try {
      const fs = await api('GET', '/api/finance/summary?p_from=1970-01-01&s_from=1970-01-01&p_to=2999-12-31&s_to=2999-12-31');
      state.cache.__purList = fs.purchase.list;
      state.cache.__salList = fs.sale.list;
    } catch (e) { /* 取不到就退回已有缓存 */ }
    const isCtx = docType && docId;            // 从单据按钮进入
    const ctxIsPur = isCtx && docType === 'purchase';
    const directionOpts = `<option value="pay">付给供应商</option><option value="receive">收客户款</option>`;
    const m = modal(`<h3>记收付款</h3>
      <form id="payf">
        <div class="form-row">
          <div class="field"><label>方向</label><select id="pay-dir" ${isCtx ? 'disabled' : ''}>${isCtx ? (ctxIsPur ? '<option value="pay">付给供应商</option>' : '<option value="receive">收客户款</option>') : directionOpts}</select></div>
          <div class="field"><label>往来单位</label>${isCtx ? `<input id="pay-party-name" value="${esc(ctxIsPur ? (state.cache.__purList.find(r => r.id == docId)?.partner || '') : (state.cache.__salList.find(r => r.id == docId)?.partner || ''))}" disabled>` : '<select id="pay-party"></select>'}</div>
        </div>
        <div class="form-row">
          <div class="field"><label>本次金额（${isCtx ? (ctxIsPur ? '付款' : '收款') : '付/收'}）</label><input id="pay-amount" type="number" step="0.01" min="0" value="0" required></div>
          <div class="field"><label>收付方式</label><select id="pay-method">${Object.entries(PAY_METHODS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
        </div>
        <div class="field"><label>备注</label><input id="pay-note" placeholder="如 现金/转账凭证号"></div>
        <div class="form-note" id="adv-banner" style="display:none"></div>
        <div class="alloc-box" id="alloc-box">
          <div class="alloc-head"><span>分摊到单据（一付可多票）</span><button type="button" class="btn-ghost small" id="add-alloc">+ 添加单据</button></div>
          <div id="alloc-rows"></div>
          <div class="alloc-sum">已分摊：<b id="alloc-sum">¥0.00</b> · 本次金额：<b id="pay-amt-label">¥0.00</b><span id="adv-amt" class="advance-amt"></span><span id="adv-hint" class="muted"></span></div>
        </div>
        <div class="modal-actions"><button type="button" class="btn-ghost" id="cancel">取消</button><button type="submit" class="btn-primary">确认提交</button></div>
      </form>`);
    m.root.querySelector('#cancel').onclick = m.close;

    const rowsBox = m.root.querySelector('#alloc-rows');
    const amountEl = m.root.querySelector('#pay-amount');
    const dirEl = m.root.querySelector('#pay-dir');
    const partyEl = isCtx ? null : m.root.querySelector('#pay-party');
    const typeOf = () => (dirEl.value === 'pay' ? 'purchase' : 'sale');

    function fillPartners() {
      if (!partyEl) return;
      const list = dirEl.value === 'pay' ? state.cache.suppliers : state.cache.customers;
      partyEl.innerHTML = list.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('') || '<option value="">（无往来单位）</option>';
    }
    // 当前往来的单位 id（上下文单据取其归属单位；否则取下拉选择）
    const currentPartyId = () => {
      if (isCtx) {
        const list = ctxIsPur ? (state.cache.__purList || []) : (state.cache.__salList || []);
        const rec = list.find(r => r.id == docId);
        return rec && rec.party_id ? String(rec.party_id) : null;
      }
      return partyEl && partyEl.value ? String(partyEl.value) : null;
    };
    // 只列「本单位」的未结清单据：混入别家单据会被后端拒绝，也容易误分摊；退单（已退单/退单待审）不出现在抵扣里
    const openDocs = () => {
      const t = typeOf();
      const list = t === 'purchase' ? (state.cache.__purList || []) : (state.cache.__salList || []);
      const pid = currentPartyId();
      return list.filter(r => r.outstanding > 0.001 && r.docStatus !== 'returned' && r.docStatus !== 'pending_return'
        && (pid ? String(r.party_id) === pid : r.party_id == null));
    };
    // 该单位已有的预存（预收款/预付款）：提交后后端会先按「单据先后」把预存冲抵掉未结清单据，
    // 所以这里先本地模拟一遍同样的顺序，抵扣后的余额才是「本次真正还需要收/付」的金额。
    let advBal = 0;
    let advHit = new Map();                      // docId -> 预存将抵扣的金额
    const netOut = (rec) => Math.max(0, r2((Number(rec && rec.outstanding) || 0) - (advHit.get(String(rec.id)) || 0)));
    async function loadAdvance() {
      advBal = 0; advHit = new Map();
      const pid = currentPartyId();
      const banner = m.root.querySelector('#adv-banner');
      if (pid) {
        try {
          const r = await api('GET', `/api/advance-balance?party_type=${dirEl.value === 'pay' ? 'supplier' : 'customer'}&party_id=${pid}`);
          advBal = r2(r.balance || 0);
        } catch (e) { advBal = 0; }
      }
      let left = advBal;
      openDocs().slice().sort((a, b) => Number(a.id) - Number(b.id)).forEach(d => {
        if (left <= 0.001) return;
        const use = r2(Math.min(left, r2(d.outstanding)));
        if (use > 0.001) { advHit.set(String(d.id), use); left = r2(left - use); }
      });
      if (banner) {
        if (advBal > 0.001) {
          const useTotal = r2(advBal - left);
          banner.style.display = '';
          banner.innerHTML = `该单位有${dirEl.value === 'pay' ? '预付款' : '预收款'}余额 <b>${yuan(advBal)}</b>，提交时系统会先按单据先后自动抵扣`
            + (useTotal > 0.001 ? `（本次可抵 ${yuan(useTotal)}，抵扣后${left > 0.001 ? `剩 ${yuan(left)}` : '预存款清零'}）` : '')
            + (useTotal > 0.001 ? `<br><button type="button" class="btn-ghost small" id="adv-apply" style="margin-top:6px">仅做抵扣（不记收付款）</button>` : '');
          const btn = banner.querySelector('#adv-apply');
          if (btn) btn.onclick = async () => {
            btn.disabled = true;
            try {
              const r = await api('POST', '/api/advance/apply', { party_type: dirEl.value === 'pay' ? 'supplier' : 'customer', party_id: pid });
              toast(r.applied > 0.001 ? `已用预存抵扣 ${yuan(r.applied)}` : '暂无需要抵扣的未结清单据');
              m.close(); renderFinance();
            } catch (e) { toast(e.message, true); btn.disabled = false; }
          };
        } else { banner.style.display = 'none'; banner.innerHTML = ''; }
      }
    }
    // 重建分摊行：列出该单位所有未结清单据（扣掉预存可抵部分），按本次金额依次自动分摊
    function rebuildRows() {
      rowsBox.innerHTML = '';
      const outs = openDocs().filter(r => netOut(r) > 0.001);
      if (!outs.length) {
        const hasAny = openDocs().length > 0;
        toast(hasAny
          ? `该单位的未结清单据已可由${dirEl.value === 'pay' ? '预付款' : '预收款'}全额抵扣，无需再收付款`
          : '该单位暂无未结清的' + (typeOf() === 'purchase' ? '采购单' : '销售单'));
        return;
      }
      // 只自动铺前 30 张：单据缓存现在是「全部历史未结清」，欠了几十上百笔的客户
      // 若全部铺开会把弹窗撑到几屏，反而找不到要操作的单据；其余可用「+ 添加单据」逐笔选
      const shown = outs.slice(0, 30);
      shown.forEach(r => addAllocRow(r.id, null, true));
      if (outs.length > shown.length) {
        toast(`另有 ${outs.length - shown.length} 张更早的未结清单据未展开，可点「+ 添加单据」逐笔选择`);
      }
      syncAutoRows();
    }
    const refreshForParty = async () => { await loadAdvance(); rebuildRows(); };
    if (partyEl) {
      fillPartners();
      dirEl.addEventListener('change', () => { fillPartners(); refreshForParty(); });
      partyEl.addEventListener('change', refreshForParty);
    }

    function refreshSum() {
      const amt = parseFloat(amountEl.value) || 0;
      let sum = 0;
      $$('.alloc-row', rowsBox).forEach(r => { sum += parseFloat(r.querySelector('.alloc-amt').value) || 0; });
      m.root.querySelector('#alloc-sum').textContent = yuan(sum);
      m.root.querySelector('#pay-amt-label').textContent = yuan(amt);
      const left = r2(amt - sum);
      const advEl = m.root.querySelector('#adv-amt');
      const hintEl = m.root.querySelector('#adv-hint');
      if (left > 0.001) {
        advEl.textContent = ` · 剩余 ${yuan(left)} 将记为${dirEl.value === 'pay' ? '预付款' : '预收款'}（可在后续${dirEl.value === 'pay' ? '采购' : '销售'}自动抵减）`;
        advEl.style.display = 'inline';
        hintEl.textContent = '';
      } else if (left < -0.001) {
        advEl.textContent = '';
        advEl.style.display = 'none';
        hintEl.textContent = ' · 分摊已超过本次金额！';
      } else {
        advEl.textContent = '';
        advEl.style.display = 'none';
        hintEl.textContent = '';
      }
    }

    function addAllocRow(preDocId, preOut) {
      const t = typeOf();
      const used = new Set($$('.alloc-row', rowsBox).map(r => r.querySelector('.alloc-doc').value));
      const pool = openDocs().filter(r => (!used.has(String(r.id)) || (preDocId != null && preDocId == r.id)) && netOut(r) > 0.001);
      const opts = pool.map(r => `<option value="${r.id}" data-out="${netOut(r)}" ${preDocId == r.id ? 'selected' : ''}>${esc(r.bill_no)} · ${esc(r.partner || '')} · 未${t === 'purchase' ? '付' : '收'}${yuan(netOut(r))}</option>`).join('');
      if (!opts) return toast('该单位所有未结清单据都已列出，没有可添加的单据', true);
      const row = document.createElement('div');
      row.className = 'alloc-row';
      row.innerHTML = `<select class="alloc-doc">${opts}</select><input class="alloc-amt" type="number" step="0.01" min="0" value="0" placeholder="分摊金额"><button type="button" class="del">×</button>`;
      row._auto = true;
      const docSel = row.querySelector('.alloc-doc');
      const amtInput = row.querySelector('.alloc-amt');
      docSel.addEventListener('change', () => { row._auto = true; syncAutoRows(); });
      amtInput.addEventListener('input', () => { row._auto = false; syncAutoRows(); });
      row.querySelector('.del').addEventListener('click', () => { row.remove(); refreshSum(); });
      rowsBox.appendChild(row);
      // preOut 为显式传入（如上下文单据）时尊重传入值；否则留 0，由 syncAutoRows 按本次金额自动分摊
      if (preOut != null) { amtInput.value = preOut; row._auto = true; }
      else { amtInput.value = 0; row._auto = true; }
    }

    // 本次金额变动（输入或失焦）时，自动行按总金额依次分摊（每行取 min(剩余, 该单据可用未结额)）
    function syncAutoRows() {
      const amt = parseFloat(amountEl.value) || 0;
      let rem = r2(amt);
      // 同一张单据可能出现在多行，累计已占用的额度要扣掉，避免同一单据被分摊两次而超额
      const usedByDoc = new Map();
      $$('.alloc-row', rowsBox).forEach(r => {
        if (r._auto) return;
        const k = r.querySelector('.alloc-doc').value;
        const v = r2(parseFloat(r.querySelector('.alloc-amt').value) || 0);
        usedByDoc.set(k, r2((usedByDoc.get(k) || 0) + v));
        rem = r2(rem - v);                  // 手动行先占用本次金额
      });
      rem = Math.max(0, rem);
      $$('.alloc-row', rowsBox).forEach(r => {
        if (!r._auto) return;
        const sel = r.querySelector('.alloc-doc');
        const out = parseFloat(sel.selectedOptions[0]?.dataset.out) || 0;
        const k = sel.value;
        const used = usedByDoc.get(k) || 0;
        const room = Math.max(0, r2(out - used));
        const v = r2(Math.min(rem, room));
        r.querySelector('.alloc-amt').value = (v > 0 ? v : 0);
        usedByDoc.set(k, r2(used + v));
        rem = r2(rem - v);
      });
      refreshSum();
    }
    amountEl.addEventListener('input', syncAutoRows);
    amountEl.addEventListener('blur', syncAutoRows);

    // 初始化分摊行（先取预存余额：抵扣模拟出来后，才知道本次「实际还需收/付」多少）
    if (isCtx) {
      const t = ctxIsPur ? 'purchase' : 'sale';
      const list = t === 'purchase' ? state.cache.__purList : state.cache.__salList;
      const rec = list.find(r => r.id == docId);
      if (rec) {
        await loadAdvance();
        const net = netOut(rec);
        // 预填的是「预存抵完之后的差额」：预存足够时这里就是 0，不用再重复收一遍钱
        amountEl.value = net;
        rowsBox.innerHTML = '';
        if (net > 0.001) addAllocRow(docId, net, true);
        // 同时列出该单位其他未结单据，便于查看超额自动分摊
        openDocs().filter(r => r.id != docId && netOut(r) > 0.001).forEach(r => addAllocRow(r.id, null, true));
        syncAutoRows();
      }
    } else if (partyEl) {
      await refreshForParty();
    } else {
      addAllocRow();
    }

    m.root.querySelector('#add-alloc').onclick = () => { addAllocRow(); syncAutoRows(); };
    m.root.querySelector('#payf').addEventListener('submit', async (e) => {
      e.preventDefault();
      const direction = dirEl.value;
      const amount = r2(amountEl.value);
      // 预存已经能把未结清单据抵完时，本次本来就不需要再收/付现金：
      // 直接引导「仅做抵扣」，而不是报「金额必须大于 0」让用户卡住
      if ((!amount || amount <= 0) && advBal > 0.001) {
        let pid = null;
        if (isCtx) {
          const rec = (ctxIsPur ? state.cache.__purList : state.cache.__salList).find(r => r.id == docId);
          pid = rec ? rec.party_id : null;
        } else if (partyEl && partyEl.value) pid = parseInt(partyEl.value);
        if (!pid) return toast('金额必须大于 0', true);
        if (!confirm(`本次无需收付现金：该单位有${direction === 'pay' ? '预付款' : '预收款'} ${yuan(advBal)}，可直接抵扣未结清单据。\n\n确定立即抵扣吗？`)) return;
        try {
          const r = await api('POST', '/api/advance/apply', { party_type: direction === 'pay' ? 'supplier' : 'customer', party_id: pid });
          toast(r.applied > 0.001 ? `已用预存抵扣 ${yuan(r.applied)}` : '暂无需要抵扣的未结清单据');
          m.close(); renderFinance();
        } catch (err) { toast(err.message, true); }
        return;
      }
      if (!amount || amount <= 0) return toast('金额必须大于 0', true);
      const allocations = [];
      const mergedAlloc = new Map();   // 合并同一单据的重复行，避免重复分摊导致单据被付超/收超
      $$('.alloc-row', rowsBox).forEach(r => {
        const did = parseInt(r.querySelector('.alloc-doc').value);
        const a = r2(r.querySelector('.alloc-amt').value);
        if (!did || !(a > 0)) return;
        const key = typeOf() + ':' + did;
        mergedAlloc.set(key, r2((mergedAlloc.get(key) || 0) + a));
      });
      mergedAlloc.forEach((amt2, key) => {
        const [dt, idStr] = key.split(':');
        allocations.push({ doc_type: dt, doc_id: parseInt(idStr), amount: amt2 });
      });
      let party_id = null, party_type = null;
      if (isCtx) {
        const t = ctxIsPur ? 'purchase' : 'sale';
        const rec = (t === 'purchase' ? state.cache.__purList : state.cache.__salList).find(r => r.id == docId);
        party_type = ctxIsPur ? 'supplier' : 'customer';
        party_id = rec ? rec.party_id : null;
      } else if (partyEl && partyEl.value) {
        party_type = direction === 'pay' ? 'supplier' : 'customer';
        party_id = parseInt(partyEl.value);
      }
      try {
        const r = await api('POST', '/api/payments', { direction, party_type, party_id, amount, method: m.root.querySelector('#pay-method').value, note: m.root.querySelector('#pay-note').value, allocations });
        let msg = '已记录收付款';
        if (r.advance_used > 0.001) msg += `；先用既有预存抵扣 ${yuan(r.advance_used)}`;
        if (allocations.length) msg += `（已分摊 ${allocations.length} 笔，合计 ${yuan(allocations.reduce((s, x) => s + x.amount, 0))}）`;
        if (r.rest_as_advance > 0.001) msg += `；剩余 ${yuan(r.rest_as_advance)} 转为预存`;
        toast(msg); m.close(); renderFinance();
      } catch (err) { toast(err.message, true); }
    });
  }

  // 用预付款/预收款抵扣某单据
  function openApplyAdvanceModal(docType, docId, available) {
    const isPur = docType === 'purchase';
    const list = isPur ? (state.cache.__purList || []) : (state.cache.__salList || []);
    const rec = list.find(r => r.id == docId);
    const outstanding = rec ? Math.max(0, r2(rec.outstanding)) : 0;
    const maxApply = Math.max(0, r2(Math.min(available, outstanding)));
    if (maxApply <= 0.001) {
      return toast(`该单据已结清（未${isPur ? '付' : '收'} ${yuan(outstanding)}），无法再抵扣`, true);
    }
    const m = modal(`<h3>用${isPur ? '预付款' : '预收款'}抵扣</h3>
      <p style="color:var(--text-soft);font-size:13px">
        可用${isPur ? '预付款' : '预收款'}余额：<b>${yuan(available)}</b> ·
        单据未${isPur ? '付' : '收'}：<b>${yuan(outstanding)}</b> ·
        本次最多可抵扣：<b class="ok">${yuan(maxApply)}</b>
      </p>
      <form id="af">
        <div class="field"><label>抵扣金额（不能超过单据未${isPur ? '付' : '收'}金额）</label><input name="amount" type="number" step="0.01" min="0" max="${maxApply}" value="${maxApply}" required></div>
        <div class="modal-actions"><button type="button" class="btn-ghost" id="cancel">取消</button><button type="submit" class="btn-primary">确认抵扣</button></div>
      </form>`);
    m.root.querySelector('#cancel').onclick = m.close;
    m.root.querySelector('#af').addEventListener('submit', async (e) => {
      e.preventDefault(); const f = e.target;
      const amt = r2(parseFloat(f.amount.value) || 0);
      if (amt <= 0) return toast('抵扣金额必须大于 0', true);
      if (amt > maxApply + 0.001) return toast(`抵扣金额不能超过 ${yuan(maxApply)}`, true);
      try {
        const r = await api('POST', '/api/payments/apply-advance', { doc_type: docType, doc_id: docId, amount: amt });
        toast(`已抵扣 ${yuan(r.applied != null ? r.applied : amt)}`); m.close(); renderFinance();
      } catch (err) { toast(err.message, true); }
    });
  }

  // ---------- 用户管理（仅管理员） ----------
  async function renderUsers() {
    if (state.user.role !== 'admin') { $('#content').innerHTML = '<p class="form-error">需要管理员权限</p>'; return; }
    $('#topbar-actions').innerHTML = `<button class="btn-primary" id="add-user">+ 新增用户</button>`;
    let users = [];
    try { users = await api('GET', '/api/users'); }
    catch (e) { return $('#content').innerHTML = `<p class="form-error">${e.message}</p>`; }
    const roleLabel = (r) => r === 'admin' ? '<span class="tag ok">管理员</span>' : '<span class="tag">普通用户</span>';
    $('#content').innerHTML = `
      <div class="card"><div class="card-title">用户列表 <span class="tag">${users.length} 人</span></div>
        <div class="table-wrap"><table><thead><tr><th>账号</th><th>显示名称</th><th>角色</th><th>创建时间</th><th>操作</th></tr></thead><tbody>
          ${users.length ? users.map(u => `<tr>
            <td>${esc(u.username)}</td>
            <td>${esc(u.display_name || u.username)}</td>
            <td>${roleLabel(u.role)}</td>
            <td class="muted">${esc((u.created_at || '').slice(0, 19))}</td>
            <td class="ops">
              <button class="btn-ghost small" data-edit="${u.id}">编辑</button>
              <button class="btn-ghost small" data-pwd="${u.id}">重置密码</button>
              ${u.id === state.user.id ? '<span class="muted">当前账号</span>' : `<button class="btn-danger small" data-del="${u.id}">删除</button>`}
            </td></tr>`).join('') : '<tr><td colspan="5" class="empty">暂无其他用户</td></tr>'}
        </tbody></table></div>
        <p class="muted" style="font-size:12px;margin-top:8px">普通用户发起退单时仅能「锁定」单据，需管理员审批通过后才真正完成退单。删除/降级前请确保至少保留一名管理员。</p>
      </div>`;
    $('#add-user').onclick = () => openUserModal();
    $$('#content [data-edit]').forEach(b => b.onclick = () => openUserModal(parseInt(b.dataset.edit)));
    $$('#content [data-pwd]').forEach(b => b.onclick = () => openResetPwdModal(parseInt(b.dataset.pwd)));
    $$('#content [data-del]').forEach(b => b.onclick = () => deleteUser(parseInt(b.dataset.del)));
  }

  async function openUserModal(id) {
    const isEdit = !!id;
    const m = modal('<div class="modal-head"><div class="avatar">👤</div><div><div class="mt">加载中…</div></div></div>', 'modal-user');
    let u = null;
    if (isEdit) {
      try { u = (await api('GET', '/api/users')).find(x => x.id === id) || null; } catch (e) { m.close(); return toast(e.message, true); }
    }
    const isAdmin = isEdit && u.role === 'admin';
    const pol = pwdPolicy();
    m.set(`
      <div class="modal-head">
        <div class="avatar">${isEdit ? '✏️' : '➕'}</div>
        <div><div class="mt">${isEdit ? '编辑用户' : '新增用户'}</div>
        <div class="ms">${isEdit ? '修改账号信息、角色或重置密码' : '创建一个可登录系统的账号'}</div></div>
      </div>
      <div class="form-row">
        <div class="field"><label>账号${isEdit ? '（不可修改）' : ''}</label><input id="u-name" value="${isEdit ? esc(u.username) : ''}" ${isEdit ? 'disabled' : ''} placeholder="2-20 位字母/数字/下划线"></div>
        <div class="field"><label>显示名称</label><input id="u-disp" value="${isEdit ? esc(u.display_name || '') : ''}" placeholder="如：张三"></div>
      </div>
      <div class="field"><label>角色权限</label>
        <div class="seg">
          <label><input type="radio" name="urole" value="user" ${!isAdmin ? 'checked' : ''}><span><b>👤 普通用户</b><small>录入单据、发起退单（需管理员审批）</small></span></label>
          <label><input type="radio" name="urole" value="admin" ${isAdmin ? 'checked' : ''}><span><b>🛡️ 管理员</b><small>用户管理、审批退单、全部权限</small></span></label>
        </div>
      </div>
      <div class="field"><label>密码${isEdit ? '（留空 = 不修改）' : `（至少 ${pol.minLen} 位）`}</label><input id="u-pwd" type="text" autocomplete="off" placeholder="${isEdit ? '留空则不修改' : '请输入登录密码'}">
        <div class="field-hint">${isEdit ? '不填写则保留原密码' : esc(pol.label + '：' + pol.hint)}</div></div>
      <div class="modal-actions"><button type="button" class="btn-ghost" id="cancel">取消</button><button type="button" class="btn-primary" id="save">${isEdit ? '保存修改' : '创建账号'}</button></div>`);
    m.root.querySelector('#cancel').onclick = m.close;
    m.root.querySelector('#save').onclick = async () => {
      const roleEl = m.root.querySelector('input[name="urole"]:checked');
      const body = {
        username: m.root.querySelector('#u-name').value.trim(),
        display_name: m.root.querySelector('#u-disp').value.trim(),
        role: roleEl ? roleEl.value : 'user',
        password: m.root.querySelector('#u-pwd').value
      };
      if (!isEdit && (!body.username || !body.password)) return toast('账号与密码必填', true);
      const b = m.root.querySelector('#save'); b.disabled = true;
      try {
        if (isEdit) await api('PUT', `/api/users/${id}`, body);
        else await api('POST', '/api/users', body);
        toast(isEdit ? '已保存' : '账号已创建'); m.close(); renderUsers();
      } catch (e) { toast(e.message, true); b.disabled = false; }
    };
  }

  function openResetPwdModal(id) {
    const pol = pwdPolicy();
    const m = modal(`<h3>重置密码</h3>
      <div class="field"><label>新密码（至少 ${pol.minLen} 位）</label><input id="rp" type="text" autocomplete="off" placeholder="请输入新密码">
        <div class="field-hint">${esc(pol.label)}：${esc(pol.hint)}</div></div>
      <div class="modal-actions"><button type="button" class="btn-ghost" id="cancel">取消</button><button type="button" class="btn-primary" id="ok">确定</button></div>`);
    m.root.querySelector('#cancel').onclick = m.close;
    m.root.querySelector('#ok').onclick = async () => {
      const pwd = m.root.querySelector('#rp').value;
      const b = m.root.querySelector('#ok'); b.disabled = true;
      try { await api('POST', `/api/users/${id}/reset-password`, { password: pwd }); toast('密码已重置'); m.close(); }
      catch (e) { toast(e.message, true); b.disabled = false; }
    };
  }

  async function deleteUser(id) {
    if (!confirm('确认删除该用户？删除后该账号将无法登录。')) return;
    try { await api('DELETE', `/api/users/${id}`); toast('已删除'); renderUsers(); }
    catch (e) { toast(e.message, true); }
  }

  // ---------- 工具 ----------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  boot();
})();
