# songloft-ncm-daily（网易云日推）

Songloft 插件：每日自动同步网易云音乐的「每日推荐」到 Songloft 曲库与歌单，配合 miot 插件即可对小爱音箱说「播放歌单每日推荐」。

## 功能

- 每日定时（默认 7 点）拉取网易云日推 30 首，逐首解析播放地址（走 NCM API 内置解灰，VIP 歌可播），入库为外链歌曲（`dedupKey = ncm:{网易id}`，幂等更新）
- 自动全量刷新「每日推荐」歌单（先清后加）
- 插件页扫码登录（**网易云音乐 App** 扫一扫，也支持保存二维码后用 App「扫一扫 → 相册」识别）
- 后台轮询扫码状态：页面不开也能在扫码后自动落 cookie
- 登录过期自动检测：生成二维码经 MP NcmQr 插件推送**企微图片**，过期自动续发（默认 3 轮）后停止，改由企微回复「登录」关键词触发
- 同步日报/失败清单推送（UrlNotify 文字通道）
- 支持手动「立即同步」；重登成功后自动补跑当天同步

## 依赖

| 组件 | 说明 |
|---|---|
| [moefurina/ncm-api](https://hub.docker.com/r/moefurina/ncm-api) | 网易云 API 容器，默认端口 3000，`ENABLE_GENERAL_UNBLOCK=true` |
| MoviePilot + UrlNotify 插件 | 文字通知借道（可选） |
| MoviePilot + NcmQr 插件 | 登录二维码企微图片推送 + 「登录」关键词响应（可选） |
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
| notifyUrl | MP 文字通知接口（UrlNotify） | http://192.168.123.176:3004/api/v1/plugin/UrlNotify/send |
| notifyApikey | UrlNotify 的 apikey | 空（不通知） |
| qrPushUrl | MP 二维码推送接口（NcmQr） | http://192.168.123.176:3004/api/v1/plugin/NcmQr/qr |
| qrPushApikey | MP 的 API_TOKEN | 空（不推图） |
| publicSecret | 回调密钥，与 NcmQr 配置一致（免 JWT 端点鉴权） | 空（关键词取码不可用） |
| qrMaxRounds | 二维码自动推送轮数 | 3 |
| syncHour | 每日同步时间（小时，0-23） | 7 |
| playlistName | 目标歌单名 | 每日推荐 |
| bitrate | 音质码率 | 320000 |
| loginCheckIntervalMin | 登录状态检查间隔（分钟） | 30 |
| notifyOnSuccess | 同步成功是否也通知 | true |

## 使用

1. 打开插件页 → 扫码登录（网易云音乐 App）
2. 点「立即同步」验证一遍全链路
3. 之后每天定点自动同步；登录过期会收到通知，回插件页扫码即可

## 工作原理

- 入库走宿主 `songloft.songs.create`（免 JWT，自动关联本插件），同一 `dedupKey` 重复入库为 UPSERT 更新
- 播放地址在每日同步时解析（外链模式，起播快）；当天播放使用当日解析的 URL
- 登录流程为后端驱动的状态机：每 3 秒轮询 `/login/qr/check`，803 落 cookie、800 续发新码（最多 `qrMaxRounds` 轮），前端页面只读状态
- 二维码推送链路：ncm-daily → POST 图给 NcmQr（apikey）→ `media/upload`（经企微代理出口）→ 企微图片消息；关键词「登录」→ NcmQr 反向调免 JWT 端点 `/public/qr`（publicPaths + 密钥鉴权）取新码
- 同步失败/登录过期均会发 MP 通知，未配置时仅记录日志

## 已知限制

- 网易云扫码 cookie 有效期数周不等，无法自动续期，过期后需扫码
- 扫码确认必须由网易云音乐 App 完成（App 扫一扫，或相册识别）；微信扫码是否等效待复测定案，保底路径为网易 App 相册识别
- 同步时解灰失败的歌会缺席当天歌单（失败清单见插件页与日报）

## 发布新版本流程

1. 改 `package.json` / `src/main.js` / `static/index.html` 中的版本号
2. 改 `plugin.json` 的 `download_url`（指向新版本 zip 文件名）
3. `npm run build` 构建（会自动回写 entryHash / zipHash 到 plugin.json）
4. 提交推送代码；在 GitHub 创建 Release `v{version}` 并附上 `Release/` 下新 zip
5. 插件源 `registry.json` 无需改动（固定指向 main 分支的 plugin.json），已安装用户即可在市场检测到更新

## License

MIT
