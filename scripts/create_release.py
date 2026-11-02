import json
import subprocess
import urllib.request

ZIP = r"C:\Users\Administrator\AppData\Roaming\TRAE SOLO CN\ModularData\ai-agent\work-mode-projects\6ae1b7a7227b78d82cd002ec\ncm-daily\Release\ncm-daily-v0.5.0.jsplugin.zip"
PROXY = "http://127.0.0.1:1080"
API = "https://api.github.com/repos/Cxquang/songloft-ncm-daily/releases"

cred = subprocess.run(["git", "credential", "fill"], input="url=https://github.com\n",
                      capture_output=True, text=True).stdout
token = None
for line in cred.splitlines():
    if line.startswith("password="):
        token = line[len("password="):].strip()
assert token, "no token from git credential"

opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": PROXY, "https": PROXY}))
headers = {"Authorization": "Bearer " + token, "User-Agent": "release-script",
           "Content-Type": "application/json; charset=utf-8"}

notes = (
    "Cookie 自动续期保活（解决 Cookie 隔天失效、浏览器却仍在线的问题）：\n\n"
    "- 新增配置 cookieRefreshIntervalMin（默认 360 分钟，0 = 关闭）：按间隔调用 /login/refresh 续期登录态\n"
    "- 返回的最新 Cookie 与原 Cookie 字段合并后保存（不丢原有字段），/login/status 校验失败自动回滚\n"
    "- lastRefreshAt 持久化，插件重启后到期立即补跑；新登录后跳过本轮续期\n"
    "- 登录检查发现失效时先自动续期，成功即恢复，失败才清空 Cookie 走短信验证码兜底\n"
    "- 新增 POST /api/login/refresh 与插件页「立即续期」按钮；状态卡片展示上次/下次续期时间\n"
)

body = json.dumps({"tag_name": "v0.5.0", "name": "ncm-daily v0.5.0", "body": notes}).encode("utf-8")
req = urllib.request.Request(API, data=body, headers=headers, method="POST")
resp = json.loads(opener.open(req, timeout=60).read())
print("Release created:", resp["html_url"], "id=", resp["id"])

with open(ZIP, "rb") as f:
    data = f.read()
up_headers = dict(headers)
up_headers["Content-Type"] = "application/zip"
up_url = "https://uploads.github.com/repos/Cxquang/songloft-ncm-daily/releases/%d/assets?name=ncm-daily-v0.5.0.jsplugin.zip" % resp["id"]
req2 = urllib.request.Request(up_url, data=data, headers=up_headers, method="POST")
asset = json.loads(opener.open(req2, timeout=120).read())
print("Asset uploaded:", asset["browser_download_url"])
