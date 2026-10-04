# 文章消息

曲别针 → 文章：向上展开 Markdown 编辑区，底部附件、表情和发送按钮仍在原位置。
使用 imzbf/md-editor-rt 7.1.0、React 19.2.4，通过 `article-editor/package-lock.json` 锁定构建依赖。
运行 `npm ci`、`npm run build` 生成站内编辑器 JS/CSS；编辑器 JS 仅首次打开文章时加载。
md-editor-rt、React、Markdown 解析器、工具栏图标和代码高亮均打包为本站资源，客户端不从 GitHub 或公共 CDN 下载依赖。
关闭未使用扩展的默认 CDN 加载地址；公式、图表、图片裁剪和代码美化保持关闭。
构建时自动更新编辑器 JS/CSS 的 SHA-256 版本链接，版本与文件匹配时允许浏览器缓存一年；未带版本或版本过旧的资源仍不缓存。
服务器上的 Caddy 使用 gzip/zstd 压缩传输，更新后会生成新版本链接，客户端自动获取新资源。
中文工具栏支持标题、强调、引用、列表、任务列表、代码、链接、表格和实时预览。
Enter 换行，Ctrl/Command + Enter 发送。草稿以账号和对话稳定 ID 分开保存在当前浏览器。

`POST /api/articles/send` 参数 `to`、`text`、`id`（32 位随机十六进制请求 ID）。
继续要求登录、当前目录版本和同源 Origin；关系锁中检查双方拉黑状态并写入消息。
文章正文上限 100000 Unicode 字符、262144 UTF-8 字节，普通文字消息限制不变。
正文和文章元数据作为同一消息行落盘并 force；请求重试根据 ID 返回原消息。
编辑、撤回、收藏、消息搜索、通知和已读复用已有消息接口；编辑保留 Markdown 缩进。
接收方点击文章卡片在页面内阅读，DOMPurify 清洗 HTML，编辑器及高亮均本地提供资源。
文章图片仅允许同源或 PNG/JPEG/WebP/GIF data URL；不执行正文中的脚本、表单、样式或 iframe。
第三方版权说明见 `/article-notices.txt`。

新程序继续读取全部旧记录；旧程序不认识 article 类型，产生文章后应使用支持此类型的程序恢复。
