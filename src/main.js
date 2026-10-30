/**
 * ncm-daily — 网易云日推同步插件 for Songloft（v0.2.0）
 *
 * 功能：
 *  - 每日定时拉取网易云「每日推荐」，逐首解析播放地址（内置解灰），dedupKey 幂等入库并刷新歌单
 *  - 插件页扫码登录；后台轮询扫码状态（页面不开也能落 cookie）
 *  - 登录过期自动检测：生成二维码 → 经 MP NcmQr 插件推送企微【图片】
 *    多轮自动续发（默认 3 轮）后停止，改由企业微信回复「登录」关键词触发重新推送
 *  - 文字通知走 MP UrlNotify 插件
 */

const PLUGIN_VERSION = '0.2.0';

const DEFAULT_CONFIG = {
  ncmBase: 'http://192.168.123.176:3000',
  notifyUrl: 'http://192.168.123.176:3004/api/v1/plugin/UrlNotify/send',
  notifyApikey: '',
  qrPushUrl: 'http://192.168.123.176:3004/api/v1/plugin/NcmQr/qr',
  qrPushApikey: '',
  publicSecret: '',
  syncHour: 7,
  playlistName: '每日推荐',
  bitrate: 320000,
  loginCheckIntervalMin: 30,
  qrMaxRounds: 3,
  notifyOnSuccess: true
};

const SKEY = {
  config: 'ncmDaily.config',
  cookie: 'ncmDaily.cookie',
  pendingLogin: 'ncmDaily.pendingLogin',
  lastRunDate: 'ncmDaily.lastRunDate',
  lastSync: 'ncmDaily.lastSync'
};

const CONFIG_FIELDS = ['ncmBase', 'notifyUrl', 'notifyApikey', 'qrPushUrl', 'qrPushApikey', 'publicSecret',
  'syncHour', 'playlistName', 'bitrate', 'loginCheckIntervalMin', 'qrMaxRounds', 'notifyOnSuccess'];

let config = Object.assign({}, DEFAULT_CONFIG);
const state = { syncing: false, pending: null, syncAfterLogin: false };
let loginCache = { ok: null, profile: null, at: 0 };
let scheduleTimer = null;
let loginCheckTimer = null;
let loginPollTimer = null;

/* ================= 工具 ================= */

function log(msg) { songloft.log.info('[ncm-daily] ' + msg); }
function logWarn(msg) { songloft.log.warn('[ncm-daily] ' + msg); }

async function storageGet(key, fallback) {
  try {
    const raw = await songloft.storage.get(key);
    if (raw === null || raw === undefined) return fallback;
    if (typeof raw !== 'string') return raw;
    try { return JSON.parse(raw); } catch (e) { return fallback; }
  } catch (e) {
    logWarn('storage 读取失败 ' + key + ': ' + e.message);
    return fallback;
  }
}

async function storageSet(key, value) {
  await songloft.storage.set(key, JSON.stringify(value));
}

async function storageDel(key) {
  try { await songloft.storage.delete(key); } catch (e) { logWarn('storage 删除失败 ' + key + ': ' + e.message); }
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function jsonResponse(data, status) {
  return {
    statusCode: status || 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  };
}

function parseBody(req) {
  try {
    let b = req.body;
    if (!b) return {};
    if (typeof b === 'string') return JSON.parse(b);
    if (b instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(b));
    if (typeof b === 'object') return b;
    return {};
  } catch (e) { return {}; }
}

function parseQuery(qs) {
  const out = {};
  if (!qs || typeof qs !== 'string') return out;
  const parts = qs.split('&');
  for (let i = 0; i < parts.length; i++) {
    const pair = parts[i];
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = eq < 0 ? pair : pair.slice(0, eq);
    const v = eq < 0 ? '' : pair.slice(eq + 1);
    try { out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, '%20')); }
    catch (e) { out[k] = v; }
  }
  return out;
}

function httpJson(url, opts, timeoutMs) {
  const o = opts || {};
  const headers = Object.assign({}, o.headers || {});
  headers['X-Fetch-Timeout-Ms'] = String(timeoutMs || 15000);
  return fetch(url, { method: o.method || 'GET', headers: headers, body: o.body })
    .then(function (res) { return res.json(); });
}

/* ================= NCM 客户端 ================= */

function ncmBase() {
  return String(config.ncmBase || '').replace(/\/+$/, '');
}

async function ncmGet(path, withCookie) {
  const headers = {};
  if (withCookie) {
    const ck = await storageGet(SKEY.cookie, '');
    if (ck) headers.Cookie = ck;
  }
  return httpJson(ncmBase() + path, { headers: headers }, 15000);
}

function extractProfile(r) {
  if (!r || typeof r !== 'object') return null;
  let profile = null;
  if (r.data && typeof r.data === 'object') {
    if (r.data.profile) profile = r.data.profile;
    else if (r.data.data && r.data.data.profile) profile = r.data.data.profile;
  }
  if (profile && profile.userId) return profile;
  return null;
}

async function getLoginStatus(force) {
  const now = Date.now();
  if (!force && loginCache.at && loginCache.ok !== null && now - loginCache.at < 60000) {
    return { ok: loginCache.ok, profile: loginCache.profile };
  }
  const r = await ncmGet('/login/status', true);
  const profile = extractProfile(r);
  const out = { ok: !!profile, profile: profile ? { userId: profile.userId, nickname: profile.nickname || '', avatarUrl: profile.avatarUrl || '' } : null };
  loginCache = { ok: out.ok, profile: out.profile, at: now };
  return out;
}

async function createQr() {
  const kr = await ncmGet('/login/qr/key', false);
  let unikey = null;
  if (kr && kr.data) {
    if (kr.data.unikey) unikey = kr.data.unikey;
    else if (kr.data.data && kr.data.data.unikey) unikey = kr.data.data.unikey;
  }
  if (!unikey) throw new Error('获取扫码 key 失败（ncmBase 不可达或接口异常）');
  const cr = await ncmGet('/login/qr/create?key=' + encodeURIComponent(unikey) + '&qrimg=true', false);
  let qrimg = null, qrurl = null;
  if (cr && cr.data) { qrimg = cr.data.qrimg || null; qrurl = cr.data.qrurl || null; }
  if (!qrimg) throw new Error('获取二维码图片失败');
  return { key: unikey, qrimg: qrimg, qrurl: qrurl };
}

async function checkQr(key) {
  const r = await ncmGet('/login/qr/check?key=' + encodeURIComponent(key), false);
  const code = r && typeof r.code === 'number' ? r.code : 0;
  let cookie = null;
  if (code === 803 && r && typeof r.cookie === 'string') cookie = r.cookie;
  return { code: code, cookie: cookie };
}

async function getDailySongs() {
  const r = await ncmGet('/recommend/songs', true);
  const d = r && r.data ? r.data : r;
  const songs = d && d.dailySongs ? d.dailySongs : null;
  if (!songs || !songs.length) throw new Error('日推列表为空（登录可能已过期）');
  return songs;
}

async function resolveSongUrl(id) {
  const br = Number(config.bitrate) > 0 ? Number(config.bitrate) : 320000;
  const r = await ncmGet('/song/url?id=' + encodeURIComponent(id) + '&br=' + br, true);
  const data = r && r.data ? r.data : null;
  const item = data && data.length ? data[0] : null;
  if (!item) return { url: null, trial: false };
  return { url: item.url || null, trial: !!item.freeTrialInfo };
}

/* ================= MP 通知（文字 / 二维码图片） ================= */

async function notifyMP(title, text) {
  const base = String(config.notifyUrl || '').trim();
  const key = String(config.notifyApikey || '').trim();
  if (!base || !key) { log('通知跳过：未配置通知接口或 APIKEY'); return; }
  const sep = base.indexOf('?') >= 0 ? '&' : '?';
  try {
    await httpJson(base + sep + 'apikey=' + encodeURIComponent(key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title, text: text })
    }, 10000);
    log('通知已发送: ' + title);
  } catch (e) {
    logWarn('通知发送失败: ' + e.message);
  }
}

async function pushQrImage(text) {
  const p = state.pending;
  if (!p) return false;
  const base = String(config.qrPushUrl || '').trim();
  const key = String(config.qrPushApikey || '').trim();
  if (!base || !key) { log('二维码推送跳过：未配置二维码推送接口或 APIKEY'); return false; }
  const sep = base.indexOf('?') >= 0 ? '&' : '?';
  try {
    const r = await httpJson(base + sep + 'apikey=' + encodeURIComponent(key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: p.qrimg, text: text })
    }, 15000);
    if (r && r.result === false) {
      logWarn('二维码推送被拒: ' + (r.message || '未知原因'));
      return false;
    }
    log('二维码已推送企微' + (text ? ': ' + text : ''));
    return true;
  } catch (e) {
    logWarn('二维码推送失败: ' + e.message);
    return false;
  }
}

/* ================= 登录流程状态机（后端驱动） ================= */

function qrMaxRounds() {
  const n = Number(config.qrMaxRounds);
  return n > 0 ? n : 3;
}

function publicPending(p) {
  return { key: p.key, qrimg: p.qrimg, round: p.round, maxRounds: qrMaxRounds(), createdAt: p.createdAt };
}

/**
 * 开始一次登录流程
 * reason: 'page'（插件页，静默，多轮不推企微）| 'expiry'（过期事件，首张推企微）
 *        | 'keyword'（企微关键词触发，首张由 MP 自己发送，后续轮次自动推企微）
 */
async function beginRelogin(reason) {
  const q = await createQr();
  const p = { key: q.key, qrimg: q.qrimg, qrurl: q.qrurl, createdAt: Date.now(), round: 1, push: reason !== 'page' };
  state.pending = p;
  await storageSet(SKEY.pendingLogin, p);
  log('开始登录流程(' + reason + ') 第1/' + qrMaxRounds() + '轮');
  if (reason === 'expiry') {
    const sent = await pushQrImage('网易云登录已过期，请扫码续期（2分钟内有效）');
    if (!sent) await notifyMP('网易云登录已过期', '二维码图片推送未配置或失败，请打开 Songloft「网易云日推」插件页面扫码。');
  }
  return p;
}

async function pollPendingLogin() {
  const p = state.pending;
  if (!p) return;
  try {
    const r = await checkQr(p.key);
    if (r.code === 803 && r.cookie) { await onLoginSuccess(r.cookie); return; }
    if (r.code === 800) { await onQrExpired(); }
  } catch (e) {
    logWarn('登录轮询异常: ' + e.message);
  }
}

async function onLoginSuccess(cookie) {
  await storageSet(SKEY.cookie, cookie);
  state.pending = null;
  await storageDel(SKEY.pendingLogin);
  loginCache = { ok: null, profile: null, at: 0 };
  let name = '';
  try {
    const st = await getLoginStatus(true);
    if (st.profile) name = st.profile.nickname || '';
  } catch (e) { /* 昵称获取失败不影响流程 */ }
  log('扫码登录成功 ' + name);
  await notifyMP('网易云登录成功', '已重新登录' + (name ? '：' + name : '') + '。');
  if (state.syncAfterLogin) {
    state.syncAfterLogin = false;
    dailySync('relogin').catch(function (e) { logWarn('重登后自动同步失败: ' + e.message); });
  }
}

async function onQrExpired() {
  const p = state.pending;
  if (!p) return;
  const max = qrMaxRounds();
  if (p.round < max) {
    let q;
    try { q = await createQr(); } catch (e) { logWarn('续期二维码生成失败: ' + e.message); return; }
    p.key = q.key; p.qrimg = q.qrimg; p.qrurl = q.qrurl;
    p.createdAt = Date.now(); p.round++;
    state.pending = p;
    await storageSet(SKEY.pendingLogin, p);
    log('二维码过期，续发第 ' + p.round + '/' + max + ' 轮');
    if (p.push) {
      const sent = await pushQrImage('二维码已过期，重新发送（第 ' + p.round + '/' + max + ' 轮，2分钟内有效）');
      if (!sent) await notifyMP('二维码过期提醒', '请打开 Songloft 插件页面扫码（图片推送未配置或失败）。');
    }
  } else {
    state.pending = null;
    await storageDel(SKEY.pendingLogin);
    log('连续 ' + max + ' 轮未完成登录，停止自动推送');
    if (p.push) {
      await notifyMP('已停止推送二维码', '连续 ' + max + ' 轮未完成登录。需要登录时，在企业微信回复「登录」获取新二维码。');
    }
  }
}

/* ================= 每日同步 ================= */

async function dailySync(trigger) {
  if (state.syncing) return { ok: false, reason: 'busy', msg: '同步进行中' };
  state.syncing = true;
  const startedAt = Date.now();
  try {
    const st = await getLoginStatus(true);
    if (!st.ok) {
      state.syncAfterLogin = true;
      await beginRelogin('expiry');
      const r1 = { ok: false, reason: 'login', date: new Date().toISOString(), trigger: trigger };
      await storageSet(SKEY.lastSync, r1);
      return r1;
    }

    const songs = await getDailySongs();
    const addedIds = [];
    const failed = [];

    for (let i = 0; i < songs.length; i++) {
      const s = songs[i];
      const title = s.name || ('未知名歌曲' + s.id);
      const artist = (s.ar || []).map(function (a) { return a && a.name; }).filter(Boolean).join('、');
      const label = title + (artist ? ' - ' + artist : '');
      try {
        const u = await resolveSongUrl(s.id);
        if (!u.url || u.trial) {
          failed.push({ title: label, reason: u.trial ? '仅试听片段' : '未获取到播放地址' });
          continue;
        }
        const input = {
          title: title,
          artist: artist,
          album: (s.al && s.al.name) || '',
          coverUrl: (s.al && s.al.picUrl) || '',
          duration: s.dt ? Math.round(s.dt / 1000) : 0,
          url: u.url,
          dedupKey: 'ncm:' + s.id
        };
        const created = await songloft.songs.create([input]);
        const arr = (created && (Array.isArray(created) ? created : (created.songs || created.items || []))) || [];
        if (arr.length && arr[0] && arr[0].id) {
          addedIds.push(arr[0].id);
        } else {
          throw new Error('入库返回为空');
        }
      } catch (e) {
        failed.push({ title: label, reason: e.message });
      }
    }

    // 歌单重建：宿主无整体替换接口，先清空再全加
    let pl = null;
    const plsRaw = await songloft.playlists.list();
    const pls = (plsRaw && (Array.isArray(plsRaw) ? plsRaw : (plsRaw.playlists || []))) || [];
    for (let i = 0; i < pls.length; i++) {
      if (pls[i] && pls[i].name === config.playlistName) { pl = pls[i]; break; }
    }
    if (!pl) pl = await songloft.playlists.create({ name: config.playlistName });

    const existingRaw = await songloft.playlists.getSongs(pl.id, { limit: 100000, offset: 0 });
    const existing = (existingRaw && (Array.isArray(existingRaw) ? existingRaw : (existingRaw.songs || existingRaw.items || []))) || [];
    if (existing.length) {
      const oldIds = existing.map(function (x) { return x.id; });
      await songloft.playlists.removeSongs(pl.id, oldIds);
    }
    if (addedIds.length) await songloft.playlists.addSongs(pl.id, addedIds);

    const result = {
      ok: true,
      date: new Date().toISOString(),
      trigger: trigger,
      total: songs.length,
      added: addedIds.length,
      failed: failed,
      tookMs: Date.now() - startedAt
    };
    await storageSet(SKEY.lastSync, result);
    await storageSet(SKEY.lastRunDate, todayStr());

    if (config.notifyOnSuccess || failed.length) {
      let text = '入库 ' + addedIds.length + '/' + songs.length + ' 首，歌单「' + config.playlistName + '」已刷新。';
      if (failed.length) {
        const shown = failed.slice(0, 5).map(function (f) { return f.title + '（' + f.reason + '）'; }).join('；');
        text += ' 失败 ' + failed.length + ' 首：' + shown + (failed.length > 5 ? ' 等' : '') + '。';
      }
      await notifyMP('网易云日推同步完成', text);
    }
    log('同步完成: ' + addedIds.length + '/' + songs.length + ' 首');
    return result;
  } catch (e) {
    logWarn('同步异常: ' + e.message);
    const r2 = { ok: false, reason: 'error', error: e.message, date: new Date().toISOString(), trigger: trigger };
    await storageSet(SKEY.lastSync, r2);
    await notifyMP('网易云日推同步异常', String(e.message));
    return r2;
  } finally {
    state.syncing = false;
  }
}

/* ================= 调度与监控 ================= */

async function checkSchedule() {
  try {
    const last = await storageGet(SKEY.lastRunDate, '');
    const hour = new Date().getHours();
    if (hour === Number(config.syncHour) && last !== todayStr()) {
      await storageSet(SKEY.lastRunDate, todayStr()); // 先占位，防止重入
      log('到达每日同步时间，开始同步');
      dailySync('schedule').catch(function (e) { logWarn('定时同步失败: ' + e.message); });
    }
  } catch (e) {
    logWarn('调度检查异常: ' + e.message);
  }
}

async function checkLoginPeriodic() {
  try {
    const ck = await storageGet(SKEY.cookie, '');
    if (!ck) return;
    const st = await getLoginStatus(true);
    if (!st.ok) {
      logWarn('检测到网易云登录失效');
      await storageSet(SKEY.cookie, '');
      loginCache = { ok: null, profile: null, at: 0 };
      await beginRelogin('expiry');
    }
  } catch (e) {
    logWarn('登录状态检查异常: ' + e.message);
  }
}

function rebuildLoginTimer() {
  if (loginCheckTimer) { clearInterval(loginCheckTimer); loginCheckTimer = null; }
  const m = Number(config.loginCheckIntervalMin) > 0 ? Number(config.loginCheckIntervalMin) : 30;
  loginCheckTimer = setInterval(function () { checkLoginPeriodic(); }, m * 60000);
}

/* ================= HTTP 路由 ================= */

function createRouter() {
  const routes = [];
  return {
    get: function (path, handler) { routes.push({ m: 'GET', p: path, h: handler }); },
    post: function (path, handler) { routes.push({ m: 'POST', p: path, h: handler }); },
    handle: async function (req) {
      for (let i = 0; i < routes.length; i++) {
        const r = routes[i];
        if (r.m === req.method && r.p === req.path) {
          try { return await r.h(req); }
          catch (e) {
            logWarn('端点 ' + req.path + ' 异常: ' + e.message);
            return jsonResponse({ error: e.message }, 500);
          }
        }
      }
      return jsonResponse({ error: 'Not Found' }, 404);
    }
  };
}

const router = createRouter();

router.get('/api/status', async function () {
  const st = await getLoginStatus(false);
  const lastSync = await storageGet(SKEY.lastSync, null);
  return jsonResponse({
    version: PLUGIN_VERSION,
    syncing: state.syncing,
    login: { ok: st.ok, profile: st.profile },
    pending: state.pending ? publicPending(state.pending) : null,
    lastSync: lastSync,
    config: config
  });
});

router.get('/api/config', async function () {
  return jsonResponse({ ok: true, config: config });
});

router.post('/api/config', async function (req) {
  const body = parseBody(req);
  for (let i = 0; i < CONFIG_FIELDS.length; i++) {
    const f = CONFIG_FIELDS[i];
    if (Object.prototype.hasOwnProperty.call(body, f)) {
      config[f] = body[f];
    }
  }
  config.syncHour = Number(config.syncHour) || 0;
  config.bitrate = Number(config.bitrate) || 320000;
  config.loginCheckIntervalMin = Number(config.loginCheckIntervalMin) || 30;
  config.qrMaxRounds = Number(config.qrMaxRounds) || 3;
  config.notifyOnSuccess = !!config.notifyOnSuccess;
  await storageSet(SKEY.config, config);
  rebuildLoginTimer();
  log('配置已更新');
  return jsonResponse({ ok: true, config: config });
});

router.post('/api/login/start', async function () {
  const p = await beginRelogin('page');
  return jsonResponse({ ok: true, pending: publicPending(p) });
});

// 免 JWT 端点（publicPaths），供 MP NcmQr 插件在收到「登录」关键词时调用取新码
router.get('/public/qr', async function (req) {
  const q = parseQuery(req.query);
  if (!config.publicSecret || String(q.secret || '') !== String(config.publicSecret)) {
    return jsonResponse({ ok: false, error: 'secret mismatch' }, 403);
  }
  const p = await beginRelogin('keyword');
  return jsonResponse({ ok: true, qrimg: p.qrimg, round: p.round, maxRounds: qrMaxRounds() });
});

router.post('/api/logout', async function () {
  await storageSet(SKEY.cookie, '');
  await storageDel(SKEY.pendingLogin);
  state.pending = null;
  loginCache = { ok: null, profile: null, at: 0 };
  log('已退出登录');
  return jsonResponse({ ok: true });
});

router.post('/api/sync/run', async function () {
  if (state.syncing) return jsonResponse({ ok: false, msg: '同步进行中' });
  dailySync('manual').catch(function (e) { logWarn('手动同步失败: ' + e.message); });
  return jsonResponse({ ok: true, started: true });
});

/* ================= 生命周期 ================= */

globalThis.onInit = async function () {
  const saved = await storageGet(SKEY.config, null);
  if (saved && typeof saved === 'object') config = Object.assign({}, DEFAULT_CONFIG, saved);
  state.pending = await storageGet(SKEY.pendingLogin, null);
  if (state.pending && !state.pending.key) state.pending = null;
  scheduleTimer = setInterval(function () { checkSchedule(); }, 60000);
  rebuildLoginTimer();
  loginPollTimer = setInterval(function () { pollPendingLogin(); }, 3000);
  log('v' + PLUGIN_VERSION + ' 已启动（ncm=' + ncmBase() + '，同步时间 ' + config.syncHour + ' 点）');
};

globalThis.onDeinit = async function () {
  if (scheduleTimer) { clearInterval(scheduleTimer); scheduleTimer = null; }
  if (loginCheckTimer) { clearInterval(loginCheckTimer); loginCheckTimer = null; }
  if (loginPollTimer) { clearInterval(loginPollTimer); loginPollTimer = null; }
  log('插件已卸载');
};

globalThis.onHTTPRequest = async function (req) {
  return router.handle(req);
};
