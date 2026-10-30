import json
import subprocess
import urllib.request

ZIP = r"C:\Users\Administrator\AppData\Roaming\TRAE SOLO CN\ModularData\ai-agent\work-mode-projects\6ae1b7a7227b78d82cd002ec\ncm-daily\Release\ncm-daily-v0.4.0.jsplugin.zip"
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
    "扫码登录经验证失效，整体改为手机号短信验证码登录：\n\n"
    "- 移除全部二维码登录逻辑（/login/qr/*、二维码推送与轮询）\n"
    "- 新增发送验证码接口并发起企微提示（经 NcmQr /notify）\n"
    "- 免 JWT 端点 /public/code、/public/send-code：企微 /code 123456 直达登录\n"
    "- 登录后 /login/status 校验，失败自动回滚；60 秒内不重复发短信\n"
    "- 保留手动 Cookie 登录；旧 qrPush* 配置自动迁移到 mpNotify*\n"
)

body = json.dumps({"tag_name": "v0.4.0", "name": "ncm-daily v0.4.0", "body": notes}).encode("utf-8")
req = urllib.request.Request(API, data=body, headers=headers, method="POST")
resp = json.loads(opener.open(req, timeout=60).read())
print("Release created:", resp["html_url"], "id=", resp["id"])

with open(ZIP, "rb") as f:
    data = f.read()
up_headers = dict(headers)
up_headers["Content-Type"] = "application/zip"
up_url = "https://uploads.github.com/repos/Cxquang/songloft-ncm-daily/releases/%d/assets?name=ncm-daily-v0.4.0.jsplugin.zip" % resp["id"]
req2 = urllib.request.Request(up_url, data=data, headers=up_headers, method="POST")
asset = json.loads(opener.open(req2, timeout=120).read())
print("Asset uploaded:", asset["browser_download_url"])
