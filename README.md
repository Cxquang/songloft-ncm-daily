# songloft-ncm-daily（网易云日推）

Songloft 插件：每日自动同步网易云音乐的「每日推荐」到 Songloft 曲库与歌单，配合 miot 插件即可对小爱音箱说「播放歌单每日推荐」。

登录方式（v0.4.0 起已移除扫码登录）：**手机号短信验证码**（经 MoviePilot NcmQr 插件转发企业微信 `/code` 指令）或**手动 Cookie**。

## 功能

- 每日定时（默认 7 点）拉取网易云日推 30 首，逐首解析播放地址（走 NCM API 内置解灰，VIP 歌可播），入库为外链歌曲（`dedupKey = ncm:{网易id}`，幂等更新）
- 自动全量刷新「每日推荐」歌单（先清后加）
- 手机号验证码登录：插件页点「发送验证码」→ 网易云向配置的手机号发短信 → 同时经 NcmQr 推送企业微信提示 → 在企业微信回复 `/code 123456` 即完成登录；也可直接在插件页手动填入验证码
- Cookie 登录：粘贴 `music.163.com` 的完整 Cookie（含 `MUSIC_U`），保存时用 `/login/status` 校验
- **Cookie 自动续期保活（v0.5.0）**：按配置间隔（默认 6 小时）自动调用 `/login/refresh` 续期登录态，把返回的最新 Cookie 与原 Cookie 合并后保存并校验，失败自动回滚；插件页也可点「立即续期」手动执行
- 登录过期自动检测：按间隔校验 cookie，失效时**先自动尝试续期**，续期失败才请求短信验证码并推送企微提示（后台也生效，页面不开同样能登录）
- 同步日报/失败清单推送（经 NcmQr 文字通知）
- 支持手动「立即同步」；重登成功后自动补跑当天同步

## 依赖

| 组件 | 说明 |
|---|---|
| [moefurina/ncm-api](https://hub.docker.com/r/moefurina/ncm-api) | 网易云 API 容器，默认端口 3000，`ENABLE_GENERAL_UNBLOCK=true` |
| MoviePilot + [NcmQr 插件](https://github.com/Cxquang/MoviePilot-Plugins) | 文字通知推送 + `/code` 指令转发（可选，但验证码登录链路依赖它） |
| Songloft 宿主 | ≥ 2.11.0 |

## 安装

- 方式一（插件源在线安装）：Songloft Web → 插件市场 → 添加插件源，填入：
  ```text
  https://raw.githubusercontent.com/Cxquang/songloft-ncm-daily/main/registry.json
  ```
  即可在市场中搜索「网易云日推」安装与后续更新
- 方式二（手动）：从 [GitHub Releases](../../releases) 下载 `ncm-daily-v{version}.jsplugin.zip`，Songloft Web → 插件管理 → 上传该 zip
- 方式三（源码构建）：`npm run build`（需 Node ≥ 18）→ 产物 `Release/ncm-daily-v{version}.jsplugin.zip`

## 配置

插件页「设置」中配置：

| 配置项 | 说明 | 默认 |
|---|---|---|
| ncmBase | NCM API 地址 | http://192.168.123.176:3000 |
| phone | 网易云账号手机号（收短信验证码，支持 `13800138000` 或 `+8613800138000`） | 空（不填无法验证码登录） |
| publicSecret | 回调密钥，与 NcmQr 插件配置一致（`/public/*` 免 JWT 端点鉴权） | 空（企微 `/code` 不可用） |
| mpNotifyUrl | NcmQr 文字通知接口 | http://192.168.123.176:3004/api/v1/plugin/NcmQr/notify |
| mpNotifyApikey | MoviePilot 的 API_TOKEN | 空（不通知） |
| syncHour | 每日同步时间（小时，0-23） | 7 |
| playlistName | 目标歌单名 | 每日推荐 |
| bitrate | 音质码率 | 320000 |
| loginCheckIntervalMin | 登录状态检查间隔（分钟） | 30 |
| cookieRefreshIntervalMin | Cookie 自动续期间隔（分钟，0 = 关闭）：周期调用 `/login/refresh` 并保存返回的最新 Cookie | 360 |
| notifyOnSuccess | 同步成功是否也通知 | true |

> 从旧版本升级时，`qrPushUrl / qrPushApikey` 会自动迁移为 `mpNotifyUrl / mpNotifyApikey`（把结尾 `/qr` 换成 `/notify`），无需重新填写。

## 使用

1. 在「设置」里填好手机号、回调密钥与 NcmQr 通知接口/APIKEY 并保存
2. 登录二选一：
   - **验证码**：点「发送验证码」→ 收到短信后，在企业微信回复 `/code 123456`，或直接在插件页输入验证码点「登录」
   - **Cookie**：粘贴 `music.163.com` 的完整 Cookie（至少含 `MUSIC_U`）→「保存并校验」
3. 点「立即同步」验证一遍全链路，之后每天定点自动同步；登录过期会自动推送验证码提示

## 登录链路

```text
插件/定时检查发现未登录
  → GET /captcha/sent（网易云向手机号发短信验证码）
  → POST NcmQr /notify（“请在企业微信回复 /code 验证码”）
  → 企业微信发送 /code 123456
  → NcmQr 调 ncm-daily /public/code?secret=...&code=123456
  → POST /login/cellphone（拿到 cookie）
  → GET /login/status 校验通过后落库，失败自动回滚
```

## 日志与排障

- **插件页自带「运行日志」卡片**：每 5 秒自动刷新，验证码发送、企微推送、`/code` 转发登录、Cookie 校验、同步结果全部可见；右上「清空」按钮可重置
- **宿主日志**：Docker 部署执行 `docker logs -f songloft`，插件日志以 `[ncm-daily]` 前缀输出；飞牛 fnOS 应用商店版在「应用管理 → SongLoft」界面查看容器日志
- 企微 `/code` 无响应时依次检查：手机号是否已配置、`publicSecret` 是否与 NcmQr 一致、NcmQr 的 `ncm_base` 是否指向本插件入口、验证码是否超过 5 分钟

## v0.5.0 变更

Cookie 登录态经常「隔天失效」而浏览器仍在线（网易按 cookie + IP + 使用行为做风控，且服务端会滚动续期会话），本版本新增 **Cookie 自动续期保活**：

- 新增配置 `cookieRefreshIntervalMin`（默认 360 分钟，0 = 关闭）：按间隔调用网易云 `/login/refresh`，把返回的最新 Cookie 与原 Cookie **字段合并**后保存（不丢 `_ntes_nuid` 等原有字段），再用 `/login/status` 校验，校验失败自动回滚原 Cookie
- 续期时间戳 `lastRefreshAt` 持久化，插件重启后到期立即补跑；新登录成功后自动跳过本轮续期
- 登录检查发现失效时先自动续期一次，成功即恢复登录态，失败才清空 Cookie 走短信验证码兜底
- 新增 `POST /api/login/refresh` 与插件页「立即续期」按钮；`/api/status` 新增 `cookieRefresh` 状态（间隔 / 上次 / 下次），状态卡片实时展示
- 失败时保留原 Cookie 等待下个周期，避免对 `/login/refresh` 高频重试触发风控

## v0.4.0 变更

扫码登录（`/login/qr/*`）经验证在网络环境下不可用，整体改为手机号短信验证码登录，并移除全部扫码相关代码：

- 新增 `POST /api/login/send-code`（页面发送验证码并推送企微提示）、`POST /api/login/code`（页面手动填验证码）
- 新增免 JWT 端点 `GET/POST /public/send-code`、`/public/code?secret=`，供 NcmQr 在企业微信 `/code` 指令后转发验证
- 登录成功用 `/login/status` 校验，失败自动回滚上一份 cookie；60 秒内不重复请求短信
- 登录失效自动请求验证码并推送企微（替代原二维码续发轮询）
- 配置项 `qrPushUrl / qrPushApikey / qrMaxRounds` 移除，改为 `phone / mpNotifyUrl / mpNotifyApikey`，旧配置自动迁移
- 保留手动 Cookie 登录；自测 40 项通过

## v0.3.2 及更早

历史版本为扫码 + Cookie 登录（v0.3.0 修复旧二维码轮询、v0.3.1 防 NCM API 缓存、v0.3.2 增加 Cookie 兜底），详见 git 历史。

## 工作原理

- 入库走宿主 `songloft.songs.create`（免 JWT，自动关联本插件），同一 `dedupKey` 重复入库为 UPSERT 更新
- 播放地址在每日同步时解析（外链模式，起播快）；当天播放使用当日解析的 URL
- NCM API 对所有 GET 200 响应按完整 URL 缓存 2 分钟，因此所有请求统一追加 `_t` 时间戳防缓存
- 同步失败/登录过期均会发 NcmQr 文字通知，未配置时仅记录日志

## 已知限制

- 网易云短信验证码有效期约 5 分钟，过期需重新发送
- 验证码登录要求 NcmQr 与 ncm-daily 双向可达（NcmQr 能访问 ncm-daily 的 `/public/*`）
- 同步时解灰失败的歌会缺席当天歌单（失败清单见插件页与日报）

## 发布新版本流程

1. 改 `package.json` / `src/main.js` / `static/index.html` 中的版本号
2. 改 `plugin.json` 的 `download_url`（指向新版本 zip 文件名）
3. `npm run build` 构建（会自动回写 entryHash / zipHash 到 plugin.json）
4. 提交推送代码；在 GitHub 创建 Release `v{version}` 并附上 `Release/` 下新 zip
5. 插件源 `registry.json` 无需改动（固定指向 main 分支的 plugin.json），已安装用户即可在市场检测到更新

## License

MIT
