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

const PLUGIN_VERSION = '0.3.0';

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
  recentKeys: 'ncmDaily.recentKeys',
  lastRunDate: 'ncmDaily.lastRunDate',
  lastSync: 'ncmDaily.lastSync'
};

const CONFIG_FIELDS = ['ncmBase', 'notifyUrl', 'notifyApikey', 'qrPushUrl', 'qrPushApikey', 'publicSecret',
  'syncHour', 'playlistName', 'bitrate', 'loginCheckIntervalMin', 'qrMaxRounds', 'notifyOnSuccess'];

let config = Object.assign({}, DEFAULT_CONFIG);
const state = { syncing: false, pending: null, recent: [], syncAfterLogin: false };
let loginCache = { ok: null, profile: null, at: 0 };
let scheduleTimer = null;
let loginCheckTimer = null;
let loginPollTimer = null;
let pollSeen = {}; // key -> 上次轮询 code（变化才记日志，防刷屏）

/* ================= 日志（宿主日志 + 插件页内置日志缓冲） ================= */

const LOG_BUF_MAX = 300;
const logBuf = [];

function pushLog(level, msg) {
  const t = new Date();
  const line = t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate()) +
    ' ' + pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ':' + pad2(t.getSeconds()) +
    ' [' + level + '] ' + msg;
  logBuf.push(line);
  if (logBuf.length > LOG_BUF_MAX) logBuf.splice(0, logBuf.length - LOG_BUF_MAX);
}

function log(msg) { pushLog('INFO', msg); songloft.log.info('[ncm-daily] ' + msg); }
function logWarn(msg) { pushLog('WARN', msg); songloft.log.warn('[ncm-daily] ' + msg); }

function snippet(obj) {
  try {
    const s = JSON.stringify(obj);
    return s && s.length > 300 ? s.slice(0, 300) + '…' : String(s);
  } catch (e) { return String(obj); }
}

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

function htmlResponse(html, status) {
  return {
    statusCode: status || 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    body: html
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
  if (qs.charAt(0) === '?') qs = qs.slice(1);
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
  // 带时间戳参数防中间层 HTTP 缓存（3 秒一次的相同 URL 可能被缓存住 801）
  const r = await ncmGet('/login/qr/check?key=' + encodeURIComponent(key) + '&_t=' + Date.now(), false);
  // 防御性解析：兼容顶层 {code,cookie} 与包一层 data 的响应形状
  let body = r;
  if (r && r.data && typeof r.data === 'object' && typeof r.data.code === 'number') body = r.data;
  const code = body && typeof body.code === 'number' ? body.code : 0;
  let cookie = null;
  if (code === 803) {
    let raw = body && body.cookie !== undefined ? body.cookie : (r && r.cookie);
    if (typeof raw === 'string' && raw) cookie = raw;
    else if (Array.isArray(raw) && raw.length) {
      cookie = raw.filter(function (x) { return typeof x === 'string' && x; }).join('; ');
    }
  }
  const message = body && body.message ? String(body.message) : '';
  return { code: code, cookie: cookie, message: message };
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

const QR_CODE_NAMES = { 800: '二维码已过期', 801: '等待扫码', 802: '已扫码，等待手机确认', 803: '授权成功' };

// 近 10 分钟内生成的所有 unikey 都参与轮询：用户扫企微里稍早的一张码也能落 cookie
const RECENT_KEY_TTL_MS = 10 * 60 * 1000;

function pruneRecent() {
  const now = Date.now();
  state.recent = (state.recent || []).filter(function (k) {
    return k && k.key && k.createdAt && (now - k.createdAt) < RECENT_KEY_TTL_MS;
  });
}

async function registerRecentKey(key) {
  if (!key) return;
  pruneRecent();
  for (let i = 0; i < state.recent.length; i++) {
    if (state.recent[i].key === key) return;
  }
  state.recent.push({ key: key, createdAt: Date.now() });
  try { await storageSet(SKEY.recentKeys, state.recent); } catch (e) { }
}

function publicPending(p) {
  return { key: p.key, qrimg: p.qrimg, round: p.round, maxRounds: qrMaxRounds(), createdAt: p.createdAt, lastCheck: p.lastCheck || null };
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
  await registerRecentKey(q.key);
  log('开始登录流程(' + reason + ') 第1/' + qrMaxRounds() + '轮，key=' + String(q.key).slice(0, 8) + '…');
  if (reason === 'expiry') {
    const sent = await pushQrImage('网易云登录已过期，请扫码续期（2分钟内有效）');
    if (!sent) await notifyMP('网易云登录已过期', '二维码图片推送未配置或失败，请打开 Songloft「网易云日推」插件页面扫码。');
  }
  return p;
}

async function pollPendingLogin() {
  let p = state.pending;
  if (!p || !p.key) {
    // storage 为准：HTTP 处理与定时器可能不在同一 JS 上下文，内存 pending 会丢失
    p = await storageGet(SKEY.pendingLogin, null);
    if (p && p.key) {
      state.pending = p;
      log('从存储恢复进行中的登录流程，key=' + String(p.key).slice(0, 8) + '…');
    } else {
      p = null;
    }
  }
  if (!state.recent || !state.recent.length) {
    const rk = await storageGet(SKEY.recentKeys, null);
    if (Array.isArray(rk) && rk.length) { state.recent = rk; pruneRecent(); }
  }
  pruneRecent();
  if (!p && !state.recent.length) return;

  const keys = [];
  if (p && p.key) keys.push(p.key);
  for (let i = 0; i < state.recent.length; i++) {
    const k = state.recent[i] && state.recent[i].key;
    if (k && keys.indexOf(k) < 0) keys.push(k);
  }

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    let r;
    try {
      r = await checkQr(key);
    } catch (e) {
      logWarn('登录轮询异常(key=' + String(key).slice(0, 8) + '…): ' + e.message);
      continue;
    }
    const isCurrent = !!(p && key === p.key);
    const name = QR_CODE_NAMES[r.code] || ('code=' + r.code);
    if (pollSeen[key] !== r.code) {
      pollSeen[key] = r.code;
      log('扫码状态[' + (isCurrent ? '当前码' : '近期码') + ']: ' + name + (r.message ? ' - ' + r.message : ''));
    }
    if (isCurrent) p.lastCheck = { code: r.code, at: Date.now(), message: r.message || name };

    if (r.code === 803) {
      if (r.cookie) { await onLoginSuccess(r.cookie); return; }
      logWarn('扫码已授权(803)但未解析到 cookie，响应: ' + snippet({ code: r.code, message: r.message }));
      continue;
    }
    if (r.code === 800) {
      const before = state.recent.length;
      state.recent = state.recent.filter(function (k) { return k.key !== key; });
      if (state.recent.length !== before) {
        try { await storageSet(SKEY.recentKeys, state.recent); } catch (e) { }
      }
      if (isCurrent) await onQrExpired();
    }
  }
}

async function onLoginSuccess(cookie) {
  await storageSet(SKEY.cookie, cookie);
  state.pending = null;
  await storageDel(SKEY.pendingLogin);
  state.recent = [];
  pollSeen = {};
  try { await storageSet(SKEY.recentKeys, []); } catch (e) { }
  loginCache = { ok: null, profile: null, at: 0 };
  let name = '';
  let stOk = false;
  try {
    const st = await getLoginStatus(true);
    stOk = !!st.ok;
    if (st.profile) name = st.profile.nickname || '';
  } catch (e) {
    logWarn('登录后状态校验异常: ' + e.message);
  }
  if (stOk) {
    log('扫码登录成功' + (name ? '：' + name : '') + '（cookie 已保存，长度 ' + String(cookie).length + '）');
  } else {
    logWarn('cookie 已保存，但 /login/status 校验未通过——cookie 可能不完整或 NCM API 版本不匹配');
  }
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
    await registerRecentKey(q.key);
    log('二维码过期，续发第 ' + p.round + '/' + max + ' 轮，key=' + String(q.key).slice(0, 8) + '…');
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
  let pending = state.pending;
  if (!pending || !pending.key) {
    // storage 兜底：页面/接口与后台定时器可能不在同一 JS 上下文
    const sp = await storageGet(SKEY.pendingLogin, null);
    if (sp && sp.key) { state.pending = sp; pending = sp; }
  }
  return jsonResponse({
    version: PLUGIN_VERSION,
    syncing: state.syncing,
    login: { ok: st.ok, profile: st.profile },
    pending: pending ? publicPending(pending) : null,
    lastSync: lastSync,
    config: config
  });
});

// 插件页内置日志（Songloft 宿主日志不便于查看时，插件页面直接看运行日志）
router.get('/api/logs', async function (req) {
  const q = parseQuery(req.query);
  if (q.clear) {
    logBuf.length = 0;
    pushLog('INFO', '日志已清空');
  }
  return jsonResponse({ ok: true, lines: logBuf.slice() });
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

// 免 JWT 端点：二维码 HTML 页（企微图片推送失败时的回退链接，手机点开即可看到二维码）
// 复用正在进行中的 pending（与企微推送的是同一张码）；无 pending 或已过 TTL 时新建一轮
router.get('/public/qr-page', async function (req) {
  const q = parseQuery(req.query);
  if (!config.publicSecret || String(q.secret || '') !== String(config.publicSecret)) {
    return htmlResponse('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
      '<body style="font-family:sans-serif;text-align:center;padding:48px 16px;color:#666">链接无效或已失效，请重新获取。</body></html>', 403);
  }
  const PENDING_TTL_MS = 110 * 1000; // 网易 unikey 有效期约 2 分钟，110s 内认为仍可扫
  let p = state.pending;
  if (!p || !p.createdAt || (Date.now() - p.createdAt) > PENDING_TTL_MS) {
    try { p = await beginRelogin('keyword'); }
    catch (e) { return htmlResponse('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
      '<body style="font-family:sans-serif;text-align:center;padding:48px 16px;color:#666">二维码获取失败：' + String(e.message) + '</body></html>', 500); }
  }
  const img = String(p.qrimg || '');
  const html = '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>网易云登录二维码</title></head>' +
    '<body style="margin:0;background:#f5f5f5;font-family:system-ui,-apple-system,sans-serif;text-align:center;color:#333">' +
    '<div style="max-width:420px;margin:0 auto;padding:28px 16px">' +
    '<h3 style="margin:0 0 6px">网易云音乐 · 登录二维码</h3>' +
    '<p style="margin:0 0 18px;color:#888;font-size:13px">第 ' + Number(p.round) + '/' + qrMaxRounds() + ' 轮 · 约 2 分钟内有效</p>' +
    (img ? '<img src="' + img + '" alt="二维码" style="width:100%;max-width:340px;background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08)"/>' : '<p>二维码数据缺失</p>') +
    '<p style="margin:16px 0 4px;font-size:14px;font-weight:600">怎么扫？</p>' +
    '<p style="margin:0 0 4px;font-size:13px;color:#666">方式一：长按二维码 → 保存到相册 → 网易云 App「扫一扫」→ 相册识别</p>' +
    '<p style="margin:0;font-size:13px;color:#666">方式二：用另一台设备直接扫屏幕上的二维码</p>' +
    '<p style="margin:18px 0 0;font-size:12px;color:#aaa">若提示二维码已过期：重新点开本链接，或在企业微信回复「登录」</p>' +
    '</div></body></html>';
  return htmlResponse(html);
});

router.post('/api/logout', async function () {
  await storageSet(SKEY.cookie, '');
  await storageDel(SKEY.pendingLogin);
  state.pending = null;
  state.recent = [];
  pollSeen = {};
  try { await storageSet(SKEY.recentKeys, []); } catch (e) { }
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
  const rk = await storageGet(SKEY.recentKeys, null);
  state.recent = Array.isArray(rk) ? rk : [];
  pruneRecent();
  scheduleTimer = setInterval(function () { checkSchedule(); }, 60000);
  rebuildLoginTimer();
  loginPollTimer = setInterval(function () { pollPendingLogin(); }, 3000);
  log('v' + PLUGIN_VERSION + ' 已启动（ncm=' + ncmBase() + '，同步时间 ' + config.syncHour + ' 点）');
  if (state.pending) log('恢复未完成的登录流程，key=' + String(state.pending.key).slice(0, 8) + '…，继续轮询扫码状态');
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
