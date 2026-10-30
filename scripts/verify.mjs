/**
 * ncm-daily v0.3.0 自测：mock songloft 宿主 + fetch，验证登录轮询链路
 * 1. 模块加载 + onInit（无 pending 时轮询空转）
 * 2. /api/login/start 生成 KEY1 并登记 recentKeys
 * 3. /public/qr 生成 KEY2 覆盖 pending（模拟另一入口新建一轮）
 * 4. 用户扫旧码 KEY1 → 轮询捕获 803+cookie → 登录成功（v0.3.0 核心修复）
 * 5. cookie 落 storage、pending/recent 清空、/api/status 显示已登录
 * 6. data 包裹形状的 803 也能解析（防御性 checkQr）
 * 7. /api/logs 与 ?clear=1
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
let keySeq = 0;
const checkScript = {};
let statusCookieSeen = '';

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

function jsonResp(o) { return Promise.resolve({ json: async function () { return o; } }); }

const fetchUrls = [];
globalThis.fetch = async function (url, opts) {
  const u = String(url);
  fetchUrls.push(u);
  if (u.includes('/login/qr/key')) return jsonResp({ data: { unikey: 'KEY' + (++keySeq) } });
  if (u.includes('/login/qr/create')) return jsonResp({ data: { code: 200, qrimg: 'data:image/png;base64,QUJD', qrurl: 'ncm://qr' } });
  if (u.includes('/login/qr/check')) {
    ok(u.includes('_t='), 'check 带 _t 防缓存参数');
    const key = /key=([^&]+)/.exec(u)[1];
    const seq = checkScript[key] || [];
    return jsonResp(seq.length ? seq.shift() : { code: 801, message: '等待扫码' });
  }
  if (u.includes('/login/status')) {
    statusCookieSeen = (opts && opts.headers && opts.headers.Cookie) || '';
    return jsonResp(/MUSIC_U/.test(statusCookieSeen)
      ? { data: { code: 200, profile: { userId: 42, nickname: '测试用户' } } }
      : { data: { code: 301 } });
  }
  if (u.includes('/recommend/songs')) return jsonResp({ data: { dailySongs: [{ id: 1, name: '歌', ar: [{ name: '歌手' }], al: {}, dt: 1000 }] } });
  if (u.includes('/song/url')) return jsonResp({ data: [{ url: 'http://x/1.mp3' }] });
  if (u.includes('plugin/')) return jsonResp({});
  throw new Error('unexpected ' + u);
};

/* ---------- 加载插件 ---------- */
const src = readFileSync(join(ROOT, 'src', 'main.js'), 'utf8');
vm.runInThisContext(src, { filename: 'main.js' });
ok(typeof globalThis.onInit === 'function' && typeof globalThis.onHTTPRequest === 'function', '模块加载，onInit/onHTTPRequest 就绪');

await globalThis.onInit();
// setInterval 回调是同步包装，必须直接 await 内部的 async 函数
const pollFn = globalThis.pollPendingLogin;
ok(typeof pollFn === 'function', 'pollPendingLogin 函数可直取（onInit 注册 3s 登录轮询定时器）');

await pollFn();
ok(true, '无 pending/recent 时轮询空转不报错');

async function http(method, path, body) {
  const idx = path.indexOf('?');
  return globalThis.onHTTPRequest({
    method: method,
    path: idx < 0 ? path : path.slice(0, idx),
    query: idx < 0 ? '' : path.slice(idx + 1),
    body: body || null
  });
}

/* 配置回调密钥，供 /public/qr 使用 */
let r = await http('POST', '/api/config', JSON.stringify({ publicSecret: 'S' }));
ok(r.body.includes('"ok":true'), '配置保存（回调密钥）');

/* 1. 页面生成第一张码 KEY1 */
r = await http('POST', '/api/login/start', '{}');
const KEY1 = JSON.parse(r.body).pending.key;
ok(KEY1 === 'KEY1', 'login/start 生成 KEY1，round=1');
const recent1 = JSON.parse(store.get('ncmDaily.recentKeys'));
ok(recent1.length === 1 && recent1[0].key === 'KEY1', 'KEY1 已登记进 recentKeys');

/* 2. 另一入口（NcmQr 关键词/扫码页）生成 KEY2，覆盖 pending */
r = await http('GET', '/public/qr?secret=S');
if (!r.body.includes('"qrimg"')) { console.error('DEBUG /public/qr resp:', r.statusCode, r.body); }
ok(r.body.includes('"qrimg"'), '/public/qr 返回新码 KEY2');
const pend2 = JSON.parse(store.get('ncmDaily.pendingLogin'));
ok(pend2.key === 'KEY2', 'pending 已被 KEY2 覆盖');
ok(JSON.parse(store.get('ncmDaily.recentKeys')).length === 2, 'recentKeys=[KEY1,KEY2]');

/* 3. 用户扫的是企微里的旧码 KEY1：KEY2 还在等待，KEY1 已确认 */
checkScript['KEY1'] = [{ code: 803, cookie: 'MUSIC_U=abc123; __csrf=xyz', message: '授权登录成功' }];
await pollFn();
if (!store.has('ncmDaily.cookie')) {
  console.error('DEBUG fetch calls:', JSON.stringify(fetchUrls, null, 1));
  console.error('DEBUG store keys:', [...store.keys()]);
}
const cookieNow = JSON.parse(store.get('ncmDaily.cookie'));
ok(cookieNow === 'MUSIC_U=abc123; __csrf=xyz', '扫旧码 KEY1 也捕获到 cookie 并落 storage（v0.3.0 核心修复）');
ok(!store.has('ncmDaily.pendingLogin'), '登录成功后 pending 已清除');
ok(JSON.parse(store.get('ncmDaily.recentKeys')).length === 0, 'recentKeys 已清空');
ok(/MUSIC_U/.test(statusCookieSeen), '登录成功后用新 cookie 调 /login/status 校验通过');

/* 4. /api/status 显示已登录 + 昵称 */
r = await http('GET', '/api/status');
const st = JSON.parse(r.body);
ok(st.login.ok === true && st.login.profile.nickname === '测试用户', '/api/status 显示已登录（测试用户）');
ok(st.pending === null, '登录后不再有 pending');
ok(st.version === '0.3.0', '版本号 0.3.0');

/* 5. 日志端点 */
r = await http('GET', '/api/logs');
const logs1 = JSON.parse(r.body).lines;
ok(logs1.some(function (l) { return l.includes('扫码状态[近期码]: 授权成功'); }), '日志记录了「近期码授权成功」');
ok(logs1.some(function (l) { return l.includes('扫码登录成功：测试用户'); }), '日志记录了「扫码登录成功」');
ok(logs1.some(function (l) { return l.includes('开始登录流程(page)'); }), '日志记录了登录流程开始');

/* 6. data 包裹形状的 803（防御性解析） */
r = await http('POST', '/api/login/start', '{}');
const KEY3 = JSON.parse(r.body).pending.key;
checkScript[KEY3] = [{ data: { code: 803, cookie: 'MUSIC_U=wrapped99', message: '授权登录成功' } }];
await pollFn();
ok(JSON.parse(store.get('ncmDaily.cookie')) === 'MUSIC_U=wrapped99', 'data 包裹形状的 803 也能解析出 cookie');

/* 7. cookie 数组形状 */
r = await http('POST', '/api/login/start', '{}');
const KEY4 = JSON.parse(r.body).pending.key;
checkScript[KEY4] = [{ code: 803, cookie: ['MUSIC_U=arr1', '__csrf=arr2'] }];
await pollFn();
ok(JSON.parse(store.get('ncmDaily.cookie')) === 'MUSIC_U=arr1; __csrf=arr2', 'cookie 数组形状被 join 为分号串');

/* 8. 清空日志 */
r = await http('GET', '/api/logs?clear=1');
const logs2 = JSON.parse(r.body).lines;
ok(logs2.length === 1 && logs2[0].includes('日志已清空'), '?clear=1 清空日志');

console.log('\nALL ' + pass + ' CHECKS PASSED');
