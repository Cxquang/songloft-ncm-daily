/**
 * ncm-daily 插件前端（v0.3.0）
 * 后端是唯一轮询者：前端只读 /api/status 渲染二维码与状态
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
  var lastQrKey = null;

  function renderLogin(login) {
    var el = $('login-status');
    if (login && login.ok && login.profile) {
      var p = login.profile;
      var html = '<span class="badge ok">已登录</span> ' + esc(p.nickname || ('用户 ' + p.userId));
      if (p.avatarUrl) html = '<img class="avatar" src="' + esc(p.avatarUrl) + '" alt="">' + html;
      el.innerHTML = html;
    } else {
      el.innerHTML = '<span class="badge bad">未登录</span> 请扫码登录后再使用';
    }
  }

  function qrStateText(p) {
    var lc = p.lastCheck;
    if (!lc || typeof lc.code !== 'number') return '等待扫码…';
    if (lc.code === 802) return '✓ 已扫码，请在手机上点击确认';
    if (lc.code === 803) return '✓ 授权成功，正在保存登录状态…';
    if (lc.code === 800) return '二维码已过期，等待自动续发…';
    return '等待扫码…';
  }

  function renderPending(p, login) {
    var card = $('card-qr');
    if (login && login.ok && !p) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    if (p) {
      if (p.key !== lastQrKey) {
        $('qr-img').src = p.qrimg;
        lastQrKey = p.key;
      }
      $('qr-state').textContent = qrStateText(p);
      $('qr-round').textContent = '第 ' + p.round + ' / ' + p.maxRounds + ' 轮 · 过期自动续发';
    } else {
      $('qr-round').textContent = '';
      $('qr-state').textContent = '点击「刷新二维码」生成登录二维码';
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
      el.innerHTML = '上次同步 <b>' + esc(time) + '</b>：<span class="badge bad">登录已过期</span> 二维码已推送';
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

  function refreshStatus() {
    return apiGet('/api/status').then(function (s) {
      $('ver').textContent = 'v' + s.version;
      $('btn-sync').disabled = !!s.syncing;
      $('btn-sync').textContent = s.syncing ? '同步中…' : '立即同步';
      renderLogin(s.login);
      renderPending(s.pending, s.login);
      renderLastSync(s.lastSync);
      return s;
    }).catch(function (e) {
      $('sync-status').textContent = '加载失败: ' + e.message;
      return null;
    });
  }

  function startStatusLoop() {
    if (statusTimer) return;
    statusTimer = setInterval(function () {
      refreshStatus().then(function (s) {
        if (s && s.login && s.login.ok && !s.pending) stopStatusLoop();
      });
    }, 3000);
  }

  function stopStatusLoop() {
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
  }

  /* ---------- 登录 ---------- */
  function startLogin() {
    $('qr-state').textContent = '正在生成二维码…';
    apiPost('/api/login/start', {}).then(function () {
      return refreshStatus();
    }).then(function () {
      startStatusLoop();
    }).catch(function (e) {
      $('qr-state').textContent = '生成失败: ' + e.message;
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
          renderPending(s.pending, s.login);
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
    $('cfg-notifyUrl').value = cfg.notifyUrl || '';
    $('cfg-notifyApikey').value = cfg.notifyApikey || '';
    $('cfg-qrPushUrl').value = cfg.qrPushUrl || '';
    $('cfg-qrPushApikey').value = cfg.qrPushApikey || '';
    $('cfg-publicSecret').value = cfg.publicSecret || '';
    $('cfg-syncHour').value = cfg.syncHour;
    $('cfg-playlistName').value = cfg.playlistName || '';
    $('cfg-bitrate').value = String(cfg.bitrate || 320000);
    $('cfg-loginCheckIntervalMin').value = cfg.loginCheckIntervalMin || 30;
    $('cfg-qrMaxRounds').value = cfg.qrMaxRounds || 3;
    $('cfg-notifyOnSuccess').checked = !!cfg.notifyOnSuccess;
  }

  function saveConfig() {
    var body = {
      ncmBase: $('cfg-ncmBase').value.trim(),
      notifyUrl: $('cfg-notifyUrl').value.trim(),
      notifyApikey: $('cfg-notifyApikey').value.trim(),
      qrPushUrl: $('cfg-qrPushUrl').value.trim(),
      qrPushApikey: $('cfg-qrPushApikey').value.trim(),
      publicSecret: $('cfg-publicSecret').value.trim(),
      syncHour: Number($('cfg-syncHour').value) || 0,
      playlistName: $('cfg-playlistName').value.trim() || '每日推荐',
      bitrate: Number($('cfg-bitrate').value) || 320000,
      loginCheckIntervalMin: Number($('cfg-loginCheckIntervalMin').value) || 30,
      qrMaxRounds: Number($('cfg-qrMaxRounds').value) || 3,
      notifyOnSuccess: $('cfg-notifyOnSuccess').checked
    };
    apiPost('/api/config', body).then(function () {
      $('save-state').textContent = '已保存';
      setTimeout(function () { $('save-state').textContent = ''; }, 2000);
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

  /* ---------- 绑定 ---------- */
  document.addEventListener('DOMContentLoaded', function () {
    $('btn-sync').addEventListener('click', runSync);
    $('btn-logout').addEventListener('click', function () {
      apiPost('/api/logout', {}).then(function () {
        lastQrKey = null;
        return refreshStatus();
      }).then(function () {
        startLogin();
      }).catch(function () { });
    });
    $('btn-refresh-qr').addEventListener('click', startLogin);
    $('btn-save').addEventListener('click', saveConfig);
    $('btn-log-refresh').addEventListener('click', refreshLogs);
    $('btn-log-clear').addEventListener('click', clearLogs);

    refreshStatus().then(function (s) {
      if (s) {
        fillForm(s.config);
        if ((!s.login || !s.login.ok)) {
          if (!s.pending) startLogin();
          startStatusLoop();
        }
      }
    });
    refreshLogs();
    startLogLoop();
  });
})();
