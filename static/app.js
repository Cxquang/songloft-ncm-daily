/**
 * ncm-daily 插件前端（v0.5.0）
 * 登录方式：手机号短信验证码（企微 /code 指令转发）或手动 Cookie
 * Cookie 保活：按间隔自动调 /login/refresh 续期（可手动「立即续期」）
 * 后端是唯一登录方：前端只读 /api/status 渲染状态
 * 兼容宿主注入的 SongloftPlugin 桥；无桥时回退原生 fetch + Bearer token
 */
(function () {
  'use strict';

  var hasSDK = typeof SongloftPlugin !== 'undefined' && SongloftPlugin !== null;

  function token() {
    try {
      var q = new URLSearchParams(location.search).get('access_token');
      if (q) return q;
      if (hasSDK && SongloftPlugin.getAuthToken) return SongloftPlugin.getAuthToken() || '';
    } catch (e) { /* ignore */ }
    return '';
  }

  function pluginBasePath() {
    var marker = '/api/v1/jsplugin/';
    var index = window.location.pathname.indexOf(marker);
    if (index < 0) return '';
    return marker + window.location.pathname.slice(index + marker.length).split('/')[0];
  }

  function apiGet(path) {
    if (hasSDK && SongloftPlugin.apiGet) return SongloftPlugin.apiGet(path);
    return rawFetch('GET', path, null);
  }

  function apiPost(path, body) {
    if (hasSDK && SongloftPlugin.apiPost) return SongloftPlugin.apiPost(path, body || {});
    return rawFetch('POST', path, body || {});
  }

  function rawFetch(method, path, body) {
    var base = pluginBasePath();
    var t = token();
    var headers = { 'Content-Type': 'application/json' };
    if (t) headers.Authorization = 'Bearer ' + t;
    return fetch(base + path, {
      method: method,
      headers: headers,
      body: method === 'GET' ? undefined : JSON.stringify(body || {})
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok || data && data.error) throw new Error((data && data.error) || ('HTTP ' + res.status));
        return data;
      });
    });
  }

  /* ---------- DOM ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- 状态渲染 ---------- */
  var statusTimer = null;
  var syncPollTimer = null;
  var lastSyncState = null;

  function renderLogin(login) {
    var el = $('login-status');
    if (login && login.ok && login.profile) {
      var p = login.profile;
      var html = '<span class="badge ok">已登录</span> ' + esc(p.nickname || ('用户 ' + p.userId));
      if (p.avatarUrl) html = '<img class="avatar" src="' + esc(p.avatarUrl) + '" alt="">' + html;
      el.innerHTML = html;
    } else {
      el.innerHTML = '<span class="badge bad">未登录</span> 请用手机号验证码或 Cookie 登录';
    }
  }

  function renderPhone(phone) {
    phone = phone || {};
    $('phone-label').textContent = phone.masked ? ('手机号 ' + phone.masked) : '未配置手机号（请先在设置里填写）';
    if (phone.codeSentAt && phone.codeExpireAt) {
      var left = Math.round((phone.codeExpireAt - Date.now()) / 1000);
      $('code-meta').textContent = left > 0
        ? '验证码已于 ' + new Date(phone.codeSentAt).toLocaleTimeString('zh-CN') + ' 发送，约 ' + Math.ceil(left / 60) + ' 分钟内有效'
        : '上次验证码已过期（' + new Date(phone.codeSentAt).toLocaleTimeString('zh-CN') + '），可重新发送';
    } else {
      $('code-meta').textContent = '';
    }
  }

  function renderLastSync(lastSync) {
    var el = $('sync-status');
    var card = $('card-failed');
    if (!lastSync) { el.innerHTML = '尚未同步过'; card.style.display = 'none'; return; }
    var d = new Date(lastSync.date);
    var time = d.toLocaleString('zh-CN');
    if (lastSync.ok) {
      el.innerHTML = '上次同步 <b>' + esc(time) + '</b>（' + esc(lastSync.trigger === 'manual' ? '手动' : (lastSync.trigger === 'relogin' ? '重登后自动' : '定时')) + '）：入库 <b>' +
        esc(lastSync.added) + '/' + esc(lastSync.total) + '</b> 首';
    } else if (lastSync.reason === 'login') {
      el.innerHTML = '上次同步 <b>' + esc(time) + '</b>：<span class="badge bad">登录已过期</span> 验证码提示已推送';
    } else {
      el.innerHTML = '上次同步 <b>' + esc(time) + '</b>：<span class="badge bad">异常</span> ' + esc(lastSync.error || '');
    }
    if (lastSync.failed && lastSync.failed.length) {
      var list = $('failed-list');
      list.innerHTML = '';
      lastSync.failed.forEach(function (f) {
        var li = document.createElement('li');
        li.textContent = f.title + '（' + f.reason + '）';
        list.appendChild(li);
      });
      card.style.display = '';
    } else {
      card.style.display = 'none';
    }
  }

  function renderCookieRefresh(cr) {
    var el = $('refresh-status');
    if (!cr) { el.innerHTML = ''; return; }
    var interval = Number(cr.intervalMin) || 0;
    if (interval <= 0) { el.innerHTML = 'Cookie 自动续期：<span class="badge bad">已关闭</span>'; return; }
    var human = interval % 60 === 0 ? (interval / 60) + ' 小时' : interval + ' 分钟';
    if (!cr.lastAt) { el.innerHTML = 'Cookie 自动续期：每 ' + esc(human) + '（尚未执行过）'; return; }
    var next = cr.nextAt && cr.nextAt > Date.now() ? '，下次约 ' + esc(new Date(cr.nextAt).toLocaleString('zh-CN')) : '，待执行';
    el.innerHTML = 'Cookie 自动续期：每 ' + esc(human) + '，上次 ' +
      esc(new Date(cr.lastAt).toLocaleString('zh-CN')) + next;
  }

  function refreshStatus() {
    return apiGet('/api/status').then(function (s) {
      $('ver').textContent = 'v' + s.version;
      $('btn-sync').disabled = !!s.syncing;
      $('btn-sync').textContent = s.syncing ? '同步中…' : '立即同步';
      renderLogin(s.login);
      renderPhone(s.phone);
      renderLastSync(s.lastSync);
      renderCookieRefresh(s.cookieRefresh);
      var wasLogged = lastSyncState === true;
      lastSyncState = !!(s.login && s.login.ok);
      if (lastSyncState) $('code-state').textContent = '已登录，如需切换账号可先退出登录';
      else if (wasLogged) $('code-state').textContent = '登录状态已失效，请重新获取验证码';
      return s;
    }).catch(function (e) {
      $('sync-status').textContent = '加载失败: ' + e.message;
      return null;
    });
  }

  // 每 3 秒轮询：捕获「企微 /code」侧完成的登录
  function startStatusLoop() {
    if (statusTimer) return;
    statusTimer = setInterval(function () {
      refreshStatus().then(function (s) {
        if (s && s.login && s.login.ok) {
          stopStatusLoop();
          refreshLogs();
        }
      });
    }, 3000);
  }

  function stopStatusLoop() {
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
  }

  /* ---------- 验证码登录 ---------- */
  function sendCode() {
    var tip = $('code-state');
    tip.textContent = '请求中…';
    apiPost('/api/login/send-code', {}).then(function (r) {
      tip.textContent = r.message || '验证码已发送';
      return refreshStatus();
    }).then(function () {
      startStatusLoop();
      refreshLogs();
    }).catch(function (e) {
      tip.textContent = '发送失败: ' + e.message;
      refreshLogs();
    });
  }

  function loginByCode() {
    var input = $('code-input');
    var code = String(input.value || '').trim();
    var tip = $('code-state');
    if (!/^\d{4,8}$/.test(code)) { tip.textContent = '请输入 4-8 位数字验证码'; return; }
    tip.textContent = '登录中…';
    apiPost('/api/login/code', { code: code }).then(function (r) {
      var name = r.login && r.login.profile && r.login.profile.nickname;
      tip.textContent = '登录成功' + (name ? '：' + name : '');
      input.value = '';
      stopStatusLoop();
      return refreshStatus();
    }).then(function () {
      refreshLogs();
    }).catch(function (e) {
      tip.textContent = '登录失败: ' + e.message;
      refreshLogs();
    });
  }

  /* ---------- 同步 ---------- */
  function runSync() {
    apiPost('/api/sync/run', {}).then(function (r) {
      if (!r.ok) { $('sync-status').textContent = r.msg || '无法启动'; return; }
      $('btn-sync').disabled = true;
      $('btn-sync').textContent = '同步中…';
      if (syncPollTimer) clearInterval(syncPollTimer);
      syncPollTimer = setInterval(function () {
        apiGet('/api/status').then(function (s) {
          renderLogin(s.login);
          if (!s.syncing) {
            clearInterval(syncPollTimer); syncPollTimer = null;
            refreshStatus();
          }
        }).catch(function () { /* ignore */ });
      }, 2000);
    }).catch(function (e) {
      $('sync-status').textContent = '启动失败: ' + e.message;
    });
  }

  /* ---------- 配置 ---------- */
  function fillForm(cfg) {
    $('cfg-ncmBase').value = cfg.ncmBase || '';
    $('cfg-phone').value = cfg.phone || '';
    $('cfg-publicSecret').value = cfg.publicSecret || '';
    $('cfg-mpNotifyUrl').value = cfg.mpNotifyUrl || '';
    $('cfg-mpNotifyApikey').value = cfg.mpNotifyApikey || '';
    $('cfg-syncHour').value = cfg.syncHour;
    $('cfg-playlistName').value = cfg.playlistName || '';
    $('cfg-bitrate').value = String(cfg.bitrate || 320000);
    $('cfg-loginCheckIntervalMin').value = cfg.loginCheckIntervalMin || 30;
    var cri = Number(cfg.cookieRefreshIntervalMin);
    $('cfg-cookieRefreshIntervalMin').value = (isFinite(cri) && cri >= 0) ? cri : 360;
    $('cfg-notifyOnSuccess').checked = !!cfg.notifyOnSuccess;
  }

  function saveConfig() {
    var body = {
      ncmBase: $('cfg-ncmBase').value.trim(),
      phone: $('cfg-phone').value.trim(),
      publicSecret: $('cfg-publicSecret').value.trim(),
      mpNotifyUrl: $('cfg-mpNotifyUrl').value.trim(),
      mpNotifyApikey: $('cfg-mpNotifyApikey').value.trim(),
      syncHour: Number($('cfg-syncHour').value) || 0,
      playlistName: $('cfg-playlistName').value.trim() || '每日推荐',
      bitrate: Number($('cfg-bitrate').value) || 320000,
      loginCheckIntervalMin: Number($('cfg-loginCheckIntervalMin').value) || 30,
      cookieRefreshIntervalMin: Math.max(0, Number($('cfg-cookieRefreshIntervalMin').value) || 0),
      notifyOnSuccess: $('cfg-notifyOnSuccess').checked
    };
    apiPost('/api/config', body).then(function () {
      $('save-state').textContent = '已保存';
      setTimeout(function () { $('save-state').textContent = ''; }, 2000);
      return refreshStatus();
    }).catch(function (e) {
      $('save-state').textContent = '保存失败: ' + e.message;
    });
  }

  /* ---------- 日志 ---------- */
  var logTimer = null;

  function refreshLogs() {
    return apiGet('/api/logs').then(function (r) {
      var el = $('log-view');
      var lines = r.lines || [];
      el.textContent = lines.length ? lines.join('\n') : '（暂无日志）';
      el.scrollTop = el.scrollHeight;
    }).catch(function () { /* 忽略：日志接口异常不影响页面 */ });
  }

  function startLogLoop() {
    if (logTimer) return;
    logTimer = setInterval(refreshLogs, 5000);
  }

  function clearLogs() {
    apiGet('/api/logs?clear=1').then(refreshLogs).catch(function () { });
  }

  /* ---------- 手动 Cookie 登录与续期 ---------- */
  function saveCookie() {
    var v = $('cookie-input').value.trim();
    var tip = $('cookie-state');
    if (!v) { tip.textContent = '请先粘贴 Cookie'; return; }
    tip.textContent = '校验中…';
    apiPost('/api/login/cookie', { cookie: v }).then(function (r) {
      tip.textContent = '已保存并通过校验' + (r.login && r.login.profile && r.login.profile.nickname ? '：' + r.login.profile.nickname : '');
      $('cookie-input').value = '';
      stopStatusLoop();
      return refreshStatus();
    }).then(function () {
      refreshLogs();
    }).catch(function (e) {
      tip.textContent = '失败: ' + e.message;
    });
  }

  function refreshCookie() {
    var tip = $('cookie-state');
    tip.textContent = '续期中…';
    apiPost('/api/login/refresh', {}).then(function (r) {
      tip.textContent = r.message || '续期成功';
      return refreshStatus();
    }).then(function () {
      refreshLogs();
    }).catch(function (e) {
      tip.textContent = '续期失败: ' + e.message;
      refreshLogs();
    });
  }

  /* ---------- 绑定 ---------- */
  document.addEventListener('DOMContentLoaded', function () {
    $('btn-sync').addEventListener('click', runSync);
    $('btn-logout').addEventListener('click', function () {
      apiPost('/api/logout', {}).then(function () {
        $('code-state').textContent = '';
        return refreshStatus();
      }).catch(function () { });
    });
    $('btn-send-code').addEventListener('click', sendCode);
    $('btn-login-code').addEventListener('click', loginByCode);
    $('code-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') loginByCode();
    });
    $('btn-save-cookie').addEventListener('click', saveCookie);
    $('btn-refresh-cookie').addEventListener('click', refreshCookie);
    $('btn-save').addEventListener('click', saveConfig);
    $('btn-log-refresh').addEventListener('click', refreshLogs);
    $('btn-log-clear').addEventListener('click', clearLogs);

    refreshStatus().then(function (s) {
      if (s) fillForm(s.config);
      if (s && !(s.login && s.login.ok)) startStatusLoop();
    });
    refreshLogs();
    startLogLoop();
  });
})();
