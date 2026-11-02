/**
 * ncm-daily — 网易云日推同步插件 for Songloft（v0.5.0）
 *
 * 登录方式（v0.4.0 起已移除扫码登录）：
 *  1. 手机号 + 短信验证码：插件请求网易云发送短信验证码，并通过 MoviePilot 的
 *     NcmQr 插件把「请在企微回复 /code 验证码」推送到企业微信；在企业微信发送
 *     /code 123456，NcmQr 会把验证码转回本插件完成登录
 *  2. 手动 Cookie：粘贴 music.163.com 的完整 Cookie（含 MUSIC_U）
 *
 * Cookie 保活（v0.5.0 新增）：
 *  按 cookieRefreshIntervalMin 周期调用 /login/refresh 续期登录态，保存返回的
 *  最新 Cookie（与原 Cookie 字段合并）；登录检查发现失效时也先尝试续期，
 *  续期失败才清空 Cookie 走短信验证码兜底
 *
 * 功能：每日定时拉取网易云「每日推荐」，逐首解析播放地址（内置解灰），
 *      dedupKey 幂等入库并刷新歌单
 */

const PLUGIN_VERSION = '0.5.0';

const DEFAULT_CONFIG = {
  ncmBase: 'http://192.168.123.176:3000',
  mpNotifyUrl: 'http://192.168.123.176:3004/api/v1/plugin/NcmQr/notify',
  mpNotifyApikey: '',
  publicSecret: '',
  phone: '',
  syncHour: 7,
  playlistName: '每日推荐',
  bitrate: 320000,
  loginCheckIntervalMin: 30,
  cookieRefreshIntervalMin: 360,
  notifyOnSuccess: true
};

const SKEY = {
  config: 'ncmDaily.config',
  cookie: 'ncmDaily.cookie',
  codeSentAt: 'ncmDaily.codeSentAt',
  lastRunDate: 'ncmDaily.lastRunDate',
  lastSync: 'ncmDaily.lastSync',
  lastRefreshAt: 'ncmDaily.lastRefreshAt'
};

const CONFIG_FIELDS = ['ncmBase', 'mpNotifyUrl', 'mpNotifyApikey', 'publicSecret', 'phone',
  'syncHour', 'playlistName', 'bitrate', 'loginCheckIntervalMin', 'cookieRefreshIntervalMin', 'notifyOnSuccess'];

// 短信验证码有效期约 5 分钟；60 秒内不重复请求
const CODE_TTL_MS = 5 * 60 * 1000;
const CODE_RESEND_MS = 60 * 1000;

let config = Object.assign({}, DEFAULT_CONFIG);
const state = { syncing: false, syncAfterLogin: false };
let loginCache = { ok: null, profile: null, at: 0 };
let scheduleTimer = null;
let loginCheckTimer = null;

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
  if (!qs) return out;
  if (typeof qs === 'object') {
    for (const k in qs) {
      if (Object.prototype.hasOwnProperty.call(qs, k)) out[k] = String(qs[k]);
    }
    return out;
  }
  if (typeof qs !== 'string') return out;
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

/**
 * 规范化手动粘贴的 Cookie：
 *  - 支持整段 `Cookie: MUSIC_U=...; __csrf=...`
 *  - 支持多行粘贴（去掉换行）
 *  - 只贴了 MUSIC_U 的值时自动补前缀
 */
function normalizeCookieInput(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  const m = /(?:^|[\s;])cookie\s*:\s*([\s\S]+)$/i.exec(s);
  if (m) s = m[1].trim();
  s = s.replace(/[\r\n\t]+/g, ' ');
  s = s.replace(/^[`'"]+/, '').replace(/[`'"]+$/, '');
  s = s.trim().replace(/;+\s*$/, '');
  if (s.indexOf('=') < 0 && /^[A-Za-z0-9%._~+\/-]{16,}$/.test(s)) s = 'MUSIC_U=' + s;
  return s;
}

function httpJson(url, opts, timeoutMs) {
  const o = opts || {};
  const headers = Object.assign({}, o.headers || {});
  headers['X-Fetch-Timeout-Ms'] = String(timeoutMs || 15000);
  return fetch(url, { method: o.method || 'GET', headers: headers, body: o.body })
    .then(function (res) { return res.json(); });
}

/**
 * 兼容顶层 {code} 与包一层 data 的响应形状
 */
function bodyOf(r) {
  if (!r || typeof r !== 'object') return {};
  if (typeof r.code === 'number') return r;
  if (r.data && typeof r.data === 'object') return r.data;
  return r;
}

/**
 * 登录接口的 cookie 也可能只出现在 Set-Cookie 响应头里
 */
function cookieFromHeaders(res) {
  try {
    if (!res || !res.headers) return '';
    let raw = '';
    if (typeof res.headers.getSetCookie === 'function') {
      const arr = res.headers.getSetCookie();
      if (arr && arr.length) raw = arr.join('; ');
    }
    if (!raw && typeof res.headers.get === 'function') raw = res.headers.get('set-cookie') || '';
    if (!raw) return '';
    return raw.split(/,(?=[^;=]+=)/).map(function (x) {
      return x.split(';')[0].trim();
    }).filter(Boolean).join('; ');
  } catch (e) {
    return '';
  }
}

/* ================= 手机号工具 ================= */

function phoneInfo() {
  const raw = String(config.phone || '').replace(/[\s-]/g, '');
  if (!raw) throw new Error('未配置手机号，请先在插件「设置」里填写');
  let cc = '86';
  let num = raw;
  if (raw.charAt(0) === '+') {
    const m = /^\+(\d{1,4})(\d{6,15})$/.exec(raw);
    if (!m) throw new Error('手机号格式不正确');
    cc = m[1];
    num = m[2];
  }
  if (!/^\d{6,15}$/.test(num)) throw new Error('手机号格式不正确（示例 13800138000 或 +8613800138000）');
  return { cc: cc, phone: num };
}

function maskPhone(num) {
  const s = String(num || '');
  return s.length >= 7 ? s.slice(0, 3) + '****' + s.slice(-4) : s;
}

function phoneMaskedSafe() {
  try { return maskPhone(phoneInfo().phone); } catch (e) { return ''; }
}

function checkSecret(value) {
  return !!config.publicSecret && String(value || '') === String(config.publicSecret);
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
  // NCM API 对所有 GET 且 200 的响应按完整 URL 缓存 2 分钟（apicache），
  // 命中缓存不会真正请求网易云：/login/status 会拿到登录前的「未登录」，
  // 所以每次 URL 必须唯一。
  const sep = path.indexOf('?') >= 0 ? '&' : '?';
  return httpJson(ncmBase() + path + sep + '_t=' + Date.now(), { headers: headers }, 15000);
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
  const out = {
    ok: !!profile,
    profile: profile ? { userId: profile.userId, nickname: profile.nickname || '', avatarUrl: profile.avatarUrl || '' } : null
  };
  loginCache = { ok: out.ok, profile: out.profile, at: now };
  return out;
}

/* ================= 短信验证码登录 ================= */

/**
 * 请求网易云发送短信验证码。
 * 60 秒内不重复请求（force=true 时跳过该保护，由网易云返回「发送频繁」）。
 */
async function requestSmsCode(force) {
  const p = phoneInfo();
  const now = Date.now();
  const last = Number(await storageGet(SKEY.codeSentAt, 0)) || 0;
  if (!force && last && now - last < CODE_RESEND_MS) {
    return { reused: true, phone: p.phone, masked: maskPhone(p.phone), at: last };
  }
  const r = await ncmGet('/captcha/sent?phone=' + encodeURIComponent(p.phone) +
    '&ctcode=' + encodeURIComponent(p.cc) + '&timestamp=' + now, false);
  const b = bodyOf(r);
  const code = Number(b.code);
  if (code !== 200) {
    throw new Error('网易云发送验证码失败：' + (b.message || b.msg || b.error || ('code=' + code)));
  }
  await storageSet(SKEY.codeSentAt, now);
  return { reused: false, phone: p.phone, masked: maskPhone(p.phone), at: now };
}

async function loginByCode(rawCode) {
  const code = String(rawCode == null ? '' : rawCode).trim();
  if (!/^\d{4,8}$/.test(code)) throw new Error('验证码应为 4-8 位数字');
  const p = phoneInfo();
  const url = ncmBase() + '/login/cellphone?phone=' + encodeURIComponent(p.phone) +
    '&captcha=' + encodeURIComponent(code) +
    '&countrycode=' + encodeURIComponent(p.cc) + '&_t=' + Date.now();
  const res = await fetch(url, { method: 'POST', headers: { 'X-Fetch-Timeout-Ms': '15000' } });
  let body = {};
  try { body = await res.json(); } catch (e) { throw new Error('登录接口返回非 JSON（HTTP ' + res.status + '）'); }
  const b = bodyOf(body);
  let cookie = typeof b.cookie === 'string' ? b.cookie : '';
  if (!cookie && typeof body.cookie === 'string') cookie = body.cookie;
  if (!cookie) cookie = cookieFromHeaders(res);
  const codeNum = b.code === undefined ? body.code : b.code;
  if (Number(codeNum) !== 200 || !cookie) {
    const msg = b.message || b.msg || body.message || body.msg;
    throw new Error('验证码登录失败：' + (msg ||
      ('code=' + (codeNum === undefined ? '?' : codeNum) + (cookie ? '' : '，响应未包含 cookie'))));
  }
  return saveLogin(cookie, '验证码', true);
}

/**
 * 保存 cookie 并用 /login/status 校验，校验失败自动回滚
 */
async function saveLogin(cookie, how, notify) {
  const prev = await storageGet(SKEY.cookie, '');
  await storageSet(SKEY.cookie, cookie);
  loginCache = { ok: null, profile: null, at: 0 };
  let st = null;
  try { st = await getLoginStatus(true); } catch (e) { logWarn('登录后状态校验异常: ' + e.message); }
  if (!st || !st.ok) {
    await storageSet(SKEY.cookie, prev || '');
    loginCache = { ok: null, profile: null, at: 0 };
    throw new Error('cookie 校验未通过：验证码可能已过期，或网易云拒绝了本次登录');
  }
  const name = st.profile && st.profile.nickname ? st.profile.nickname : '';
  log(how + '登录成功' + (name ? '：' + name : '') + '（cookie 长度 ' + String(cookie).length + '）');
  await storageSet(SKEY.lastRefreshAt, Date.now()); // 新登录的 cookie 无需立即续期
  if (notify) await notifyMP('网易云登录成功', '已通过' + how + '登录' + (name ? '：' + name : '') + '。');
  if (state.syncAfterLogin) {
    state.syncAfterLogin = false;
    dailySync('relogin').catch(function (e) { logWarn('重登后自动同步失败: ' + e.message); });
  }
  return st.profile;
}

/* ================= MP 通知（经 NcmQr 转发企业微信） ================= */

async function notifyMP(title, text) {
  const base = String(config.mpNotifyUrl || '').trim();
  const key = String(config.mpNotifyApikey || '').trim();
  if (!base || !key) {
    log('通知跳过：未配置 NcmQr 通知接口或 APIKEY');
    return false;
  }
  const sep = base.indexOf('?') >= 0 ? '&' : '?';
  try {
    const r = await httpJson(base + sep + 'apikey=' + encodeURIComponent(key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title, text: text })
    }, 15000);
    if (r && r.result === false) {
      logWarn('通知推送被拒: ' + (r.message || '未知原因'));
      return false;
    }
    log('通知已推送企业微信: ' + title);
    return true;
  } catch (e) {
    logWarn('通知推送失败: ' + e.message);
    return false;
  }
}

function codeInstruction(masked) {
  return '验证码已发送到 ' + masked + '。请在企业微信回复：/code 短信里的验证码（例如 /code 123456），5 分钟内有效。\n' +
    '也可以打开 Songloft「网易云日推」插件页面手动填写验证码，或用 Cookie 登录。';
}

/**
 * 登录失效时自动请求验证码并推送企微提示
 */
async function beginCodeLogin(reason) {
  try {
    const info = await requestSmsCode(false);
    log('短信验证码已发送到 ' + info.masked + (info.reused ? '（60 秒内复用）' : '') + '，触发: ' + reason);
    await notifyMP('网易云登录验证码', codeInstruction(info.masked));
    return { ok: true, phoneMasked: info.masked, sentAt: info.at };
  } catch (e) {
    logWarn('自动发送短信验证码失败: ' + e.message);
    await notifyMP('网易云登录需要验证码',
      '自动发送验证码失败：' + e.message + '\n请打开 Songloft「网易云日推」插件页点「发送验证码」重试，或用 Cookie 登录。');
    return { ok: false, error: e.message };
  }
}

/* ================= Cookie 自动续期 ================= */

/**
 * 合并 Cookie：newStr 的字段覆盖 oldStr 同名字段，oldStr 独有字段保留。
 * /login/refresh 返回的 cookie 不一定带全手动粘贴时的字段（如 _ntes_nuid、NMTID），
 * 直接整体替换会丢字段，合并更稳。
 */
function mergeCookies(oldStr, newStr) {
  const out = {};
  const eat = function (s) {
    String(s || '').split(';').forEach(function (kv) {
      const eq = kv.indexOf('=');
      if (eq <= 0) return;
      out[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
    });
  };
  eat(oldStr);
  eat(newStr);
  return Object.keys(out).map(function (k) { return k + '=' + out[k]; }).join('; ');
}

/**
 * 调用 /login/refresh 续期登录态：成功则把返回的最新 cookie 与原 cookie 合并后保存，
 * 再用 /login/status 校验，校验失败回滚原 cookie。
 * 任何失败都保留原 cookie，交由登录检查逻辑兜底。
 */
async function refreshLoginCookie() {
  const prev = await storageGet(SKEY.cookie, '');
  if (!prev) return { ok: false, message: '尚未登录，没有可续期的 Cookie' };
  const res = await fetch(ncmBase() + '/login/refresh?_t=' + Date.now(), {
    method: 'POST',
    headers: { 'X-Fetch-Timeout-Ms': '15000', Cookie: prev }
  });
  let body = {};
  try { body = await res.json(); }
  catch (e) {
    logWarn('Cookie 续期返回非 JSON（HTTP ' + res.status + '）');
    return { ok: false, message: '续期接口返回异常（HTTP ' + res.status + '）' };
  }
  const b = bodyOf(body);
  let fresh = typeof b.cookie === 'string' ? b.cookie : '';
  if (!fresh && typeof body.cookie === 'string') fresh = body.cookie;
  if (!fresh) fresh = cookieFromHeaders(res);
  const codeNum = b.code === undefined ? body.code : b.code;
  if (Number(codeNum) !== 200 || !fresh) {
    const msg = '续期未成功（code=' + (codeNum === undefined ? '?' : codeNum) +
      (fresh ? '' : '，响应未包含 cookie') + '）';
    logWarn('Cookie ' + msg + '，保留原 Cookie 等待登录检查兜底');
    return { ok: false, message: msg };
  }
  const merged = mergeCookies(prev, fresh);
  await storageSet(SKEY.cookie, merged);
  loginCache = { ok: null, profile: null, at: 0 };
  let st = null;
  try { st = await getLoginStatus(true); } catch (e) { logWarn('续期后状态校验异常: ' + e.message); }
  if (st && st.ok) {
    await storageSet(SKEY.lastRefreshAt, Date.now());
    log('Cookie 续期成功，最新 Cookie 已保存（长度 ' + merged.length + '）');
    return { ok: true, message: '续期成功，最新 Cookie 已保存' };
  }
  await storageSet(SKEY.cookie, prev);
  loginCache = { ok: null, profile: null, at: 0 };
  logWarn('续期后校验未通过，已回滚原 Cookie');
  return { ok: false, message: '新 Cookie 校验未通过，已回滚原 Cookie' };
}

/* ================= 每日同步 ================= */

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

async function dailySync(trigger) {
  if (state.syncing) return { ok: false, reason: 'busy', msg: '同步进行中' };
  state.syncing = true;
  const startedAt = Date.now();
  try {
    const st = await getLoginStatus(true);
    if (!st.ok) {
      state.syncAfterLogin = true;
      await beginCodeLogin('expiry');
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

async function checkCookieRefresh() {
  try {
    const intervalMin = Number(config.cookieRefreshIntervalMin) || 0;
    if (intervalMin <= 0) return;
    const ck = await storageGet(SKEY.cookie, '');
    if (!ck) return;
    const last = Number(await storageGet(SKEY.lastRefreshAt, 0)) || 0;
    if (Date.now() - last < intervalMin * 60000) return;
    await storageSet(SKEY.lastRefreshAt, Date.now()); // 先占位：失败也等下个周期，避免对 /login/refresh 高频重试触发风控
    const r = await refreshLoginCookie();
    if (!r.ok) logWarn('定时 Cookie 续期未成功：' + r.message);
  } catch (e) {
    logWarn('Cookie 续期检查异常: ' + e.message);
  }
}

async function checkLoginPeriodic() {
  try {
    const ck = await storageGet(SKEY.cookie, '');
    if (!ck) return;
    const st = await getLoginStatus(true);
    if (!st.ok) {
      logWarn('检测到网易云登录失效，先尝试续期 Cookie');
      let refreshed = false;
      try { refreshed = (await refreshLoginCookie()).ok; }
      catch (e) { logWarn('续期尝试异常: ' + e.message); }
      if (refreshed) {
        log('Cookie 续期成功，登录态已恢复，无需重新登录');
        return;
      }
      await storageSet(SKEY.cookie, '');
      loginCache = { ok: null, profile: null, at: 0 };
      await beginCodeLogin('expiry');
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
  const sentAt = Number(await storageGet(SKEY.codeSentAt, 0)) || 0;
  const lastRefreshAt = Number(await storageGet(SKEY.lastRefreshAt, 0)) || 0;
  const refreshInterval = Number(config.cookieRefreshIntervalMin) || 0;
  return jsonResponse({
    version: PLUGIN_VERSION,
    syncing: state.syncing,
    login: { ok: st.ok, profile: st.profile },
    phone: {
      masked: phoneMaskedSafe(),
      codeSentAt: sentAt,
      codeExpireAt: sentAt ? sentAt + CODE_TTL_MS : 0
    },
    lastSync: lastSync,
    cookieRefresh: {
      intervalMin: refreshInterval,
      lastAt: lastRefreshAt,
      nextAt: lastRefreshAt > 0 && refreshInterval > 0 ? lastRefreshAt + refreshInterval * 60000 : 0
    },
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
  config.cookieRefreshIntervalMin = Math.max(0, Number(config.cookieRefreshIntervalMin) || 0);
  config.notifyOnSuccess = !!config.notifyOnSuccess;
  config.phone = String(config.phone || '').trim();
  await storageSet(SKEY.config, config);
  rebuildLoginTimer();
  log('配置已更新（手机号 ' + (phoneMaskedSafe() || '未配置') + '）');
  return jsonResponse({ ok: true, config: config });
});

// 页面点击「发送验证码」：请求短信 + 同时推送企微提示
router.post('/api/login/send-code', async function (req) {
  try {
    const info = await requestSmsCode(true);
    log('已请求短信验证码（' + info.masked + '）');
    await notifyMP('网易云登录验证码', codeInstruction(info.masked));
    return jsonResponse({
      ok: true, phoneMasked: info.masked, sentAt: info.at,
      message: '验证码已发送到 ' + info.masked + '，请查收短信'
    });
  } catch (e) {
    logWarn('请求短信验证码失败: ' + e.message);
    return jsonResponse({ ok: false, error: e.message }, 400);
  }
});

// 页面手动提交验证码
router.post('/api/login/code', async function (req) {
  const body = parseBody(req);
  try {
    const profile = await loginByCode(body.code);
    return jsonResponse({ ok: true, login: { ok: true, profile: profile } });
  } catch (e) {
    logWarn('验证码登录失败: ' + e.message);
    return jsonResponse({ ok: false, error: e.message }, 400);
  }
});

// 手动 Cookie 登录
router.post('/api/login/cookie', async function (req) {
  const body = parseBody(req);
  const cookie = normalizeCookieInput(body.cookie);
  if (!cookie) return jsonResponse({ ok: false, error: 'cookie 为空' }, 400);
  if (!/(?:^|;\s*)MUSIC_U=/.test(cookie)) {
    return jsonResponse({ ok: false, error: '未找到 MUSIC_U，请粘贴 music.163.com 的完整 Cookie' }, 400);
  }
  try {
    const profile = await saveLogin(cookie, 'Cookie', true);
    return jsonResponse({ ok: true, login: { ok: true, profile: profile } });
  } catch (e) {
    logWarn('手动 Cookie 登录失败: ' + e.message);
    return jsonResponse({ ok: false, error: e.message }, 400);
  }
});

// 手动立即续期：调用 /login/refresh 并保存最新 Cookie（与定时续期同一套逻辑）
router.post('/api/login/refresh', async function () {
  try {
    await storageSet(SKEY.lastRefreshAt, Date.now()); // 占位：失败也等下个周期再试
    const r = await refreshLoginCookie();
    if (r.ok) return jsonResponse({ ok: true, message: r.message });
    return jsonResponse({ ok: false, error: r.message }, 400);
  } catch (e) {
    logWarn('手动 Cookie 续期异常: ' + e.message);
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
});

/* ---------- 免 JWT 端点：供 MP NcmQr 插件转发验证码 ---------- */

async function handlePublicSendCode(req) {
  const q = parseQuery(req.query);
  if (!checkSecret(q.secret)) return jsonResponse({ ok: false, error: 'secret mismatch' }, 403);
  try {
    const info = await requestSmsCode(false);
    log('NcmQr 请求短信验证码（' + info.masked + (info.reused ? '，60 秒内复用' : '') + '）');
    return jsonResponse({
      ok: true, phoneMasked: info.masked, sentAt: info.at,
      message: '验证码已发送到 ' + info.masked + '，请查看短信后发送 /code 验证码'
    });
  } catch (e) {
    logWarn('NcmQr 请求短信验证码失败: ' + e.message);
    return jsonResponse({ ok: false, error: e.message }, 400);
  }
}

async function handlePublicCode(req) {
  const q = parseQuery(req.query);
  if (!checkSecret(q.secret)) return jsonResponse({ ok: false, error: 'secret mismatch' }, 403);
  const body = parseBody(req);
  const code = q.code || body.code;
  try {
    const profile = await loginByCode(code);
    log('NcmQr 转发验证码登录成功');
    return jsonResponse({
      ok: true,
      login: { ok: true, profile: profile },
      message: '登录成功'
    });
  } catch (e) {
    logWarn('NcmQr 转发验证码登录失败: ' + e.message);
    return jsonResponse({ ok: false, error: e.message }, 400);
  }
}

router.get('/public/send-code', handlePublicSendCode);
router.post('/public/send-code', handlePublicSendCode);
router.get('/public/code', handlePublicCode);
router.post('/public/code', handlePublicCode);

router.post('/api/logout', async function () {
  await storageSet(SKEY.cookie, '');
  await storageDel(SKEY.codeSentAt);
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

function migrateConfig(saved) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, saved || {});
  // 旧版二维码推送配置迁移到 NcmQr 通知接口
  if (!cfg.mpNotifyUrl && saved && saved.qrPushUrl) {
    cfg.mpNotifyUrl = String(saved.qrPushUrl).replace(/\/qr(\?.*)?$/, '/notify');
  }
  if (!cfg.mpNotifyApikey && saved && saved.qrPushApikey) {
    cfg.mpNotifyApikey = String(saved.qrPushApikey);
  }
  return cfg;
}

globalThis.onInit = async function () {
  const saved = await storageGet(SKEY.config, null);
  if (saved && typeof saved === 'object') config = migrateConfig(saved);
  scheduleTimer = setInterval(function () { checkSchedule(); checkCookieRefresh(); }, 60000);
  rebuildLoginTimer();
  const ri = Number(config.cookieRefreshIntervalMin) || 0;
  log('v' + PLUGIN_VERSION + ' 已启动（ncm=' + ncmBase() + '，同步时间 ' + config.syncHour +
    ' 点，Cookie 续期' + (ri > 0 ? '每 ' + ri + ' 分钟' : '已关闭') + '）');
  if (!config.phone) logWarn('未配置手机号：登录失效时无法自动发送短信验证码，请在插件设置里填写');
  if (!config.publicSecret) logWarn('未配置回调密钥：企业微信 /code 指令将无法把验证码转回插件');
};

globalThis.onDeinit = async function () {
  if (scheduleTimer) { clearInterval(scheduleTimer); scheduleTimer = null; }
  if (loginCheckTimer) { clearInterval(loginCheckTimer); loginCheckTimer = null; }
  log('插件已卸载');
};

globalThis.onHTTPRequest = async function (req) {
  return router.handle(req);
};
