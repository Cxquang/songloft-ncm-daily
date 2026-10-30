/**
 * ncm-daily v0.4.0 自测：mock songloft 宿主 + fetch，验证「手机号短信验证码 + Cookie」登录链路
 * 1. 模块加载 + onInit（定时器就绪，未配置手机号给出告警）
 * 2. POST /api/config 保存手机号 / 回调密钥 / NcmQr 通知接口
 * 3. POST /api/login/send-code：请求 /captcha/sent + 推送企微提示（NcmQr /notify）
 * 4. GET /public/send-code 密钥错误 → 403；正确密钥 → 60 秒内复用不发短信
 * 5. GET /public/code 密钥错误 → 403；企业微信 /code 转发的验证码 → /login/cellphone → cookie 落库并通过 /login/status 校验
 * 6. 非法验证码格式 → 400；错误验证码 → 400 且 cookie 回滚
 * 7. POST /api/login/cookie 手动 Cookie 登录
 * 8. /api/status 版本与手机号脱敏；/api/logout 清空 cookie；/api/logs 与 ?clear=1
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
function ok(cond, label) {
  if (!cond) { console.error('FAIL: ' + label); process.exit(1); }
  pass++;
  console.log('[' + pass + '] OK: ' + label);
}

/* ---------- mock 宿主 ---------- */
const store = new Map();
const intervals = [];

globalThis.setInterval = function (fn, ms) { intervals.push({ fn: fn, ms: ms }); return intervals.length; };
globalThis.clearInterval = function () { };

globalThis.songloft = {
  log: { info: function () { }, warn: function () { } },
  storage: {
    get: async function (k) { return store.has(k) ? store.get(k) : null; },
    set: async function (k, v) { store.set(k, v); },
    delete: async function (k) { store.delete(k); }
  },
  songs: { create: async function (arr) { return arr.map(function (_s, i) { return { id: 's' + i }; }); } },
  playlists: {
    list: async function () { return []; },
    create: async function (p) { return { id: 'pl1', name: p.name }; },
    getSongs: async function () { return []; },
    addSongs: async function () { },
    removeSongs: async function () { }
  }
};

/* ---------- mock fetch ---------- */
function resp(payload, setCookie) {
  return {
    ok: true,
    status: 200,
    headers: {
      getSetCookie: function () { return setCookie ? [setCookie] : []; },
      get: function (n) { return n.toLowerCase() === 'set-cookie' ? (setCookie || '') : ''; }
    },
    json: async function () { return payload; }
  };
}

const captchaCalls = [];
const notifyCalls = [];
let statusCookieSeen = '';
let loginAttempts = [];

globalThis.fetch = async function (url, opts) {
  const u = String(url);
  const headers = (opts && opts.headers) || {};
  if (u.includes('/captcha/sent')) {
    captchaCalls.push(u);
    ok(u.includes('_t='), '/captcha/sent 带 _t 防缓存参数');
    ok(u.includes('ctcode=86') && u.includes('phone=13800138000'), '/captcha/sent 手机号与国家码正确');
    return resp({ code: 200, data: { code: 200 } });
  }
  if (u.includes('/login/cellphone')) {
    const captcha = /captcha=([^&]+)/.exec(u)[1];
    loginAttempts.push(captcha);
    if (captcha === '123456') {
      return resp({ code: 200, cookie: 'MUSIC_U=FAKE_MAIN_COOKIE; __csrf=abc' },
        'MUSIC_U=FAKE_MAIN_COOKIE; Path=/; Domain=music.163.com');
    }
    return resp({ code: 503, message: '验证码错误或已过期' });
  }
  if (u.includes('/login/status')) {
    statusCookieSeen = headers.Cookie || '';
    return resp(/MUSIC_U=FAKE_MAIN_COOKIE|MUSIC_U=MANUAL_COOKIE/.test(statusCookieSeen)
      ? { data: { code: 200, profile: { userId: 42, nickname: '测试用户' } } }
      : { data: { code: 301 } });
  }
  if (u.includes('/recommend/songs')) return resp({ data: { dailySongs: [{ id: 1, name: '歌', ar: [{ name: '歌手' }], al: {}, dt: 1000 }] } });
  if (u.includes('/song/url')) return resp({ data: [{ url: 'http://x/1.mp3' }] });
  if (u.includes('/api/v1/plugin/NcmQr/notify')) {
    notifyCalls.push({ url: u, body: JSON.parse((opts && opts.body) || '{}') });
    return resp({ result: true });
  }
  throw new Error('unexpected ' + u);
};

/* ---------- 加载插件 ---------- */
const src = readFileSync(join(ROOT, 'src', 'main.js'), 'utf8');
vm.runInThisContext(src, { filename: 'main.js' });
ok(typeof globalThis.onInit === 'function', '模块加载：onInit 已注册');
ok(typeof globalThis.onHTTPRequest === 'function', '模块加载：onHTTPRequest 已注册');

async function call(method, path, opts) {
  const o = opts || {};
  const res = await globalThis.onHTTPRequest({
    method: method,
    path: path,
    query: o.query || '',
    body: o.body ? JSON.stringify(o.body) : ''
  });
  return { status: res.statusCode, data: JSON.parse(res.body) };
}

await globalThis.onInit();
ok(intervals.length === 2, 'onInit：启动调度(60s) + 登录检查定时器');
ok(store.get('ncmDaily.config') === undefined, 'onInit：无历史配置时不写 storage');

/* ---------- 保存配置 ---------- */
let r = await call('POST', '/api/config', {
  body: {
    ncmBase: 'http://ncm.example.com:3000',
    phone: '13800138000',
    publicSecret: 'ncm-secret-123',
    mpNotifyUrl: 'http://mp.example.com:3004/api/v1/plugin/NcmQr/notify',
    mpNotifyApikey: 'MP_TOKEN',
    syncHour: 7,
    playlistName: '每日推荐',
    bitrate: 320000,
    loginCheckIntervalMin: 30,
    notifyOnSuccess: false
  }
});
ok(r.status === 200 && r.data.ok, 'POST /api/config：保存成功');
ok(r.data.config.phone === '13800138000', 'POST /api/config：手机号已保存');

/* ---------- 页面发送验证码 ---------- */
r = await call('POST', '/api/login/send-code');
ok(r.status === 200 && r.data.ok, 'POST /api/login/send-code：短信验证码已请求');
ok(captchaCalls.length === 1, '/captcha/sent 只请求一次');
ok(r.data.phoneMasked === '138****8000', '/api/login/send-code：返回脱敏手机号');
ok(notifyCalls.length === 1, '发送验证码后推送 1 条企微提示');
ok(notifyCalls[0].body.text.includes('/code 123456'), '企微提示包含 /code 指令用法');
ok(notifyCalls[0].url.includes('apikey=MP_TOKEN'), 'NcmQr 通知接口携带 apikey');
ok(Number(store.get('ncmDaily.codeSentAt')) > 0, 'codeSentAt 已落库');

/* ---------- 免 JWT 端点：密钥校验 ---------- */
r = await call('GET', '/public/send-code', { query: 'secret=wrong' });
ok(r.status === 403 && /secret/.test(r.data.error), '/public/send-code 密钥错误返回 403');

r = await call('GET', '/public/send-code', { query: 'secret=ncm-secret-123' });
ok(r.status === 200 && r.data.ok, '/public/send-code 密钥正确返回成功');
ok(captchaCalls.length === 1, '/public/send-code：60 秒内复用，不重复请求短信');

r = await call('GET', '/public/code', { query: 'secret=wrong&code=123456' });
ok(r.status === 403, '/public/code 密钥错误返回 403');

/* ---------- 企业微信 /code 转发登录 ---------- */
r = await call('GET', '/public/code', { query: 'secret=ncm-secret-123&code=123456' });
ok(r.status === 200 && r.data.ok, '/public/code：验证码登录成功');
ok(r.data.login.profile.nickname === '测试用户', '/public/code：返回网易云昵称');
ok(String(store.get('ncmDaily.cookie')).indexOf('MUSIC_U=') >= 0, '登录成功：cookie 已落库');
ok(notifyCalls.length === 2, '登录成功后再推 1 条企微通知');
ok(notifyCalls[1].body.title === '网易云登录成功', '登录成功通知标题正确');

/* ---------- 状态与非法验证码 ---------- */
r = await call('GET', '/api/status');
ok(r.status === 200 && r.data.version === '0.4.0', '/api/status：版本 0.4.0');
ok(r.data.login.ok === true, '/api/status：显示已登录');
ok(r.data.phone.masked === '138****8000', '/api/status：手机号脱敏');
ok(r.data.phone.codeExpireAt > r.data.phone.codeSentAt, '/api/status：验证码有效期已计算');
ok(r.data.config.mpNotifyUrl.indexOf('/notify') > 0, '/api/status：配置包含 NcmQr 通知接口');

r = await call('POST', '/api/login/code', { body: { code: 'abc' } });
ok(r.status === 400 && /4-8 位数字/.test(r.data.error), '非法验证码格式返回 400');

r = await call('POST', '/api/login/code', { body: { code: '999999' } });
ok(r.status === 400 && /验证码登录失败/.test(r.data.error), '错误验证码返回 400');
ok(String(store.get('ncmDaily.cookie')).indexOf('MUSIC_U=FAKE_MAIN_COOKIE') >= 0, '登录失败后 cookie 回滚为上一份有效 cookie');

/* ---------- 手动 Cookie 登录 ---------- */
r = await call('POST', '/api/login/cookie', { body: { cookie: 'MUSIC_U=MANUAL_COOKIE' } });
ok(r.status === 200 && r.data.ok, 'POST /api/login/cookie：手动 Cookie 登录成功');
ok(String(store.get('ncmDaily.cookie')).indexOf('MUSIC_U=MANUAL_COOKIE') >= 0, '手动 Cookie 已落库');

r = await call('POST', '/api/login/cookie', { body: { cookie: 'foo=bar' } });
ok(r.status === 400 && /MUSIC_U/.test(r.data.error), '不含 MUSIC_U 的 Cookie 被拒绝');

/* ---------- 日志与退出 ---------- */
r = await call('GET', '/api/logs');
ok(r.status === 200 && Array.isArray(r.data.lines) && r.data.lines.length > 0, '/api/logs：可读取运行日志');

r = await call('GET', '/api/logs', { query: 'clear=1' });
ok(r.data.lines.length === 1, '/api/logs?clear=1：日志已清空只留提示');

r = await call('POST', '/api/logout');
ok(r.status === 200 && r.data.ok, 'POST /api/logout：退出成功');

r = await call('GET', '/api/status');
ok(r.data.login.ok === false, '退出后 /api/status：显示未登录');

r = await call('GET', '/api/sync/run', {});
ok(r.status === 404, 'GET /api/sync/run：方法不匹配返回 404');

console.log('\n全部 ' + pass + ' 项自测通过（ncm-daily v0.4.0）');
