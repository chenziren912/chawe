# chawe

一个可以自行部署的聊天网站，使用 Java 17 后端、原生 JavaScript 界面及磨玻璃蓝色主题。项目采用 MIT 许可证。

## 功能

- 账号注册、登录、多账号切换、联系人备注、用户资料、头像与拉黑。
- 私聊、群聊、收藏夹、群成员及管理员管理、权限、话题和独立邀请链接。
- 文字、图片、视频、文件、普通语音、每位接收者只能播放一次的语音及 Markdown 文章。
- 消息编辑、撤回、已读对钩、表情回应、置顶、聊天内搜索和历史分页。
- 输入状态：点击输入框或输入文字后，私聊和群聊显示正在输入；最后一次操作后 3 秒到期。
- 浏览器 Web Push：同一浏览器设备 15 秒最多提醒一次，多个未读消息合并，旧未读也计入。
- 浏览器媒体缓存、原生文件下载、动画、磨玻璃、透明度及自定义滚动条设置。

图片上限 20 MiB，视频上限 100 MiB / 10 分钟，文件上限 200 MiB。已发送的普通附件不会定时删除；一次性语音遵循播放后的失效规则。

## 运行要求

- Linux 或 WSL，JDK 17 或更新版本。Windows 可以编译，服务器运行需要 POSIX 文件权限。
- FFmpeg 的 `/usr/bin/ffprobe`，用于验证视频时长。
- Caddy 或其他 HTTPS 反向代理，以及自己的域名。服务只监听 `127.0.0.1`。
- Node.js / npm 仅在重新构建 Markdown 编辑器时需要；仓库已包含站内编辑器资源。

## 编译

```sh
git clone https://github.com/chenziren912/chawe.git
cd chawe
sh build.sh
```

Windows 可使用 `./build.ps1`。产物为 `build/chawe.jar`；后端只使用 JDK 标准库。

需要重新生成文章编辑器时：

```sh
cd article-editor
npm ci
npm run build
cd ..
```

编辑器依赖版本固定在 lockfile 中，构建后生成本站 JS/CSS、许可证声明和资源版本链接。浏览器从自己的服务器加载这些文件。

文章支持 `$...$` 行内公式与 `$$...$$` 独立公式，工具栏也可插入公式。KaTeX 和公式字体随编辑器打包。代码块可指定语言（如 `cpp`、`python`、`java`），提供语法高亮、行号、复制及水平滚动；编辑预览和发送后的文章使用同一套渲染配置。

## 配置与启动

```sh
mkdir -p "$PWD/data"
export CHAWE_DATA_DIR="$PWD/data"
export CHAWE_WEB_DIR="$PWD/web"
export CHAWE_PUBLIC_ORIGIN="https://chat.example.org"
export CHAWE_PORT="8080"
java -jar build/chawe.jar
```

`CHAWE_PUBLIC_ORIGIN` 必须是 HTTPS 地址，不带结尾斜杠，并与浏览器访问的 Origin 一致。数据目录应仅供服务账户读写。

可选配置 `CHAWE_RECOMMENDED_GROUP_ID` 为一个公开群的固定 ID，登录用户的会话列表下方会显示尚未加入的“群聊推荐”，点击“加入”直接入群。已加入时隐藏推荐。推荐区右上角可关闭推荐，在“通用设置 → 显示群聊推荐”中可重新开启；此偏好按账号保存在当前浏览器。不配置时不显示推荐；群被删除或改成私密后停止推荐。推荐列表只公开群名、头像、人数及当前账号是否已加入。

将 [deploy/examples/Caddyfile](deploy/examples/Caddyfile) 中的域名替换为自己的域名，配置 Caddy 将 HTTPS 请求转发到 `127.0.0.1:8080`。
长期运行可以参考 [deploy/examples/chawe.service](deploy/examples/chawe.service)：创建 `chawe` 系统用户，程序与网页放到 `/opt/chawe`，数据放到 `/var/lib/chawe`，修改域名后安装 systemd 服务。服务器更新时应保留旧程序及数据的恢复副本。

登录页内的用户协议和隐私文案沿用原项目，位于 `web/index.html`；`policies/` 保存其 Markdown 版本。部署自己的站点时需按实际运营者、联系渠道和数据处理方式更新这些文案。

## 项目结构

| 路径 | 内容 |
| --- | --- |
| `src/chawe/` | HTTP 服务、账号、聊天、附件、群聊、通知和短暂输入状态 |
| `web/` | 登录页、聊天界面、Service Worker、媒体缓存及自托管编辑器 |
| `article-editor/` | md-editor-rt 编辑器源码、依赖和构建脚本 |
| `deploy/examples/` | 可自行修改的 systemd / Caddy 配置模板 |
| `policies/` | 原站点协议和隐私文案 |

详细功能说明：[群聊与置顶](GROUPS-PINS.md)、[文章](ARTICLE.md)、[语音](VOICE.md)、[表情回应](REACTIONS.md)、[输入状态](TYPING.md)。

## 数据与许可证

运行数据、账号、会话、上传文件、推送订阅、密钥、本地构建和临时发布目录不进入 Git 仓库。密码使用带随机盐的 PBKDF2-HMAC-SHA256；消息及附件保存在自部署服务器上，目前没有端到端加密。

项目代码采用 [MIT](LICENSE)，第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 `web/article-notices.txt`。Chawe 是独立项目。
