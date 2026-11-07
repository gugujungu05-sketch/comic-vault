# ComicVault · 漫画库

一套**支持多用户的漫画社区**：把散落的图片、压缩包、PDF 整理成一话一话，存进私人书架、读得舒服、分享出去只要一条链接；也可以发布到公共书库让大家一起补全，在广场讨论交流。

单端口部署，前后端一体，**数据全部落在你自己的磁盘上**。邮箱注册登录后各账号数据彼此隔离；第一个注册的账号自动接管已有漫画。

> **在线入口**：<https://gugujungu05-sketch.github.io/comic-vault/> —— 这是应用的官网主页：检测到你电脑上正在运行漫画库软件时可以直接跳进去用，也提供各端安装包的下载直达。完整的多用户网站（登录、上传、广场）由软件内置的本地服务或自部署的服务端提供。

---

## 功能一览

### 📥 导入与分话

| 能力 | 说明 |
|---|---|
| 图片多选与排序 | JPG / PNG / WebP / GIF / BMP / AVIF / TIFF；一次选多个文件后，导入框里可**拖拽、上移/下移、删除、按名称重排、整体反转**，最终页序严格按你排好的顺序落盘 |
| 文件夹拖拽 | 直接把整个目录拖进书架，保留目录结构 |
| ZIP / CBZ | 浏览器端解压，自动读取 `ComicInfo.xml` |
| RAR / CBR / 7Z / CB7 | 服务端 7-Zip WASM 引擎解压，大包不占浏览器内存 |
| ACE / ARJ / LZH / CAB / ISO 等 | 同一引擎一并支持 |
| PDF | 按页渲染成图片，可选渲染清晰度 |
| 服务器本地目录 | 已在本机的漫画无需上传，填路径直接入库 |

**四种分话模式**：按目录结构 · 按固定页数 · 按文件名中的编号 · 全部归为单话。分好后每话都能改名、增删、上下移排序。

导入框新增**排序面板**：默认按文件名自然排序（与落盘顺序一致）；一旦拖拽或点 ↑/↓，立即切换为「自定义顺序」，此后分话与写入都严格按列表顺序执行，可随时点「恢复智能排序」还原。多选图片、压缩包、PDF 混选时同样生效。

### 📖 阅读器

- **三种版式**：单页 / 双页对开 / 连续滚动（条漫）
- **阅读方向**：LTR / RTL 日漫模式，方向键自动适配
- **四种适配**：适应屏幕 / 适应宽度 / 适应高度 / 原始尺寸，外加 0.4–4× 无级缩放
- **画面滤镜**：护眼（暖色）/ 反色 / 黑白，配亮度与对比度滑块
- **智能双页**：自动识别跨页大图（宽 > 高）让它独占一屏，杜绝对开错位
- **页面编辑**：直接在阅读器里旋转、拖框裁剪（切白边），可批量应用到本章或整本
- 目录跳转、页面缩略图导航、进度自动记忆、预加载、全屏、UI 自动隐藏

### 🔗 分享

- 一键生成**直达链接** `/s/<token>`，扫码或点开即读
- **二维码**：弹窗内直接显示，可保存 PNG
- **按话分享**：只挑几话生成「试读链接」，访客看不到其余内容，导出同样受限
- **访问控制**：访问密码、有效期（1/7/30/90 天）、「仅在线阅读 / 允许下载」开关
- **访问记录**：最近 200 条阅读与下载日志（时间、IP、事件），可一键清空
- **一键吊销**：旧链接立即失效并生成新链接

### 💾 导出

**CBZ**（含 `ComicInfo.xml`，YACReader / Tachiyomi / Panels 通用）、**ZIP**、**PDF**（按原图比例排版）、**EPUB**（固定版式）。支持整本导出或勾选指定话，访客在分享页同样可下载。

### 🗂 书架

搜索、标签筛选、收藏、四种排序、网格/列表切换、统计面板、任意位置拖文件即弹出导入、创建副本。

### 👥 账号与社区

- **登录**：邮箱 + 密码，或邮箱验证码（配 SMTP 或 Resend 发真实邮件，未配置时页面直接显示开发验证码）。会话用 httpOnly Cookie。
- **邮箱验证与找回密码**：注册不强制验证邮箱，可直接开始用；之后在「设置 → 邮箱验证」补做验证。已验证邮箱才可用于忘记密码时收码重置密码；未配置真实发信时找回功能自动禁用，避免明文验证码被冒用。
- **数据隔离**：每本漫画属于一个账号，私密漫画别人打不开；公开漫画别人可看，可单独关闭下载权限。
- **私密也能分享**：分享链接 `/s/<token>` 无需登录，即使是私密漫画，拿到链接的人也能直接阅读。
- **用户主页**：展示昵称、简介、公开漫画与广场动态，可修改资料和头像。
- **公共书库**：所有登录用户都能上传新话、加标签、加多个别名、加多个封面并设为当前显示；**删除按逐条归属**——谁上传的话 / 谁添加的条目，只有本人能删，创建者也删不了别人那一条。
- **广场**：按分区发帖、附带漫画或分享链接、图片/视频/文件/表情包、点赞、评论；只能删自己发的帖和评论、自己添加的表情包。详见下节。
- **自动备份**：数据库原子写入，每 10 分钟留快照，损坏时自动从最新快照恢复。

### 💬 广场分区与富媒体

- **8 个分区**：全部 · 综合讨论 · 漫画推荐 · 求书求助 · 剧情吐槽 · 资源分享 · 斗图表情 · 闲聊灌水。发帖时选分区，顶部点分区即可筛选，每个分区实时显示帖子数；旧帖自动归入「综合讨论」。
- **富媒体附件**：图片、视频、音频、普通文件一次最多选 12 个（单个 ≤ 60MB）。图片渲染成九宫格，视频/音频在线播放，文件按中文原名下载；`html / js / svg` 等脚本类文件一律拒绝，附件地址统一走 `/api/plaza/media/:file`。
- **表情包**：内置 Unicode 表情 + 自定义图片表情包。在「图片表情包」标签页上传图片、填名称和标签即可添加；**只能删除自己添加的那一条**。
- **打字自动搜索**：输入时按末尾关键词（含末 2/3/4 字模糊匹配）同时搜内置表情与自定义表情包，候选条一键插入并替换触发词；发帖框与评论框都支持。候选条右侧「关闭自动搜索」可随时关掉，偏好存浏览器 `localStorage`（键 `cv-emoji-auto`），再点输入框旁开关即可重新开启。
- 正文与评论里的表情包以 `[emoji:<文件>]` 标记存储，前端渲染成图片，纯文本接口也不会丢内容。

### 🔎 发现、动态、公告与软件下载（v2.2）

- **公共书库分类与排行**：11 个预设分类（含「全部」）按数量实时统计；热门 / 浏览 / 点赞 / 下载 / 新书 5 种排行榜，热门分综合浏览量、点赞、下载、话数、页数与新鲜度计算。
- **搜索**：公共书库支持书名、别名、作者、简介、标签的关键词搜索与 5 种排序；广场支持正文、作者、评论、附件名、附带漫画的全文搜索。
- **上传记录与动态流**：公共书库右侧时间线显示谁在何时给哪本漫画加了哪一话、多少页；首页动态流汇总公告、新书、上传、广场新帖，公告置顶。
- **公告权限**：只单独授予一个账号（`publicUser.canAnnounce`）。默认自动授予最早的管理员；也可用环境变量 `CV_ANNOUNCER_EMAIL` 指定邮箱。只能删除自己发布的公告，服务端二次鉴权。
- **软件下载页 `/downloads`**：显示网站地址、当前服务端/客户端版本、更新说明、Windows 便携版/绿色版、Linux AppImage、Android APK（站内可直接下载）与资料库 zip 链接。
- **软件设置与自动更新**：桌面软件「文件 → 切换服务器…」窗口新增网站地址复制/打开、检查更新、打开下载页；手机 App 右下角 ⚙ 菜单可查看网站地址、切换服务器、检查更新。启动时静默检查客户端新版本（同版本只提示一次），网页 / PWA 内容随服务器实时更新，永远无需手动升级。
- **合规批量导入**：公共书库「批量导入」接受用户粘贴的 JSON 清单，必须勾选「确认拥有合法授权」；图片直链仅允许公开 http/https，拒绝内网地址与超大文件。**本站不爬取、不搬运任何第三方网站的受版权保护内容**。
- **示例漫画**：首次启动在后台生成 6 本本站自制示例漫画（代码绘制，可自由阅读），让分类 / 排行 / 搜索立刻有内容；完整生成后才入库，删除后不会重新生成。可用 `CV_DISABLE_SAMPLES=1` 关闭。

---

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式（前端热更新 + 后端服务）
npm run dev

# 生产模式
npm run build && npm start
```

启动后访问 **http://localhost:8787**（端口可用 `PORT` 环境变量覆盖）。

---

## 桌面软件 / 安装为应用（与网站数据互通）

四种用法看到的是**同一份数据**：浏览器网页、安装到设备的应用、独立的桌面软件、手机 App，都连接同一个服务器、使用同一个邮箱账号。任意一端新建、改名、换封面或删除漫画，其它端刷新即同步；网站里分享的**私密漫画**链接，在软件里也能直接打开。数据保存在服务器，不占用本机空间，也不需要手动同步。

### 方式一：浏览器里一键「安装为应用」

打开网站 → **设置 → 桌面软件与数据互通 → 安装到本机**（或用浏览器菜单的「安装应用 / 添加到主屏幕」）。安装后有独立图标与窗口、没有地址栏；手机添加到主屏幕后可全屏使用。

站点提供动态 `manifest.webmanifest` 与 Service Worker。托管环境会自动把访问凭据写进启动地址、图标和快捷方式，避免安装后打开白屏；`sw.js` 只缓存界面外壳，`/api/` 数据请求永不缓存，保证各端看到的始终是实时数据。

### 方式二：独立桌面软件（Windows / macOS / Linux）

| 系统 | 一键启动 |
|---|---|
| Windows | 双击 `启动桌面软件.bat` |
| macOS / Linux | 双击 `启动桌面软件.command` |

首次运行会自动安装运行库。打包成 exe / dmg / AppImage 安装包的方法见 [`desktop/README.md`](desktop/README.md)。

**现成成品**（本次已打包好，放在工作区根目录，双击即用，无需先跑脚本）：

| 文件 | 适用 |
|---|---|
| `漫画库-便携版.exe` | Windows，单文件免安装，可放 U 盘 |
| `漫画库-Windows绿色版.zip` | Windows，解压后双击 `漫画库 ComicVault.exe` |
| `漫画库 ComicVault-1.0.0.AppImage` | Linux，加可执行权限后运行 |
| `漫画库-Android.apk` | Android 6.0+，见方式三 |

软件提供独立窗口、原生菜单（返回首页 / 刷新 / 切换服务器 / 在浏览器中打开 / 关于）、窗口大小记忆、系统下载、断网时的可重试错误页（不白屏），登录状态长期保留。

**切换服务器**：菜单 **文件 → 切换服务器…**（`Ctrl/Cmd + ,`）。默认连线上网站，也可填 `http://localhost:8787`（本机先运行 `npm start`）或任意自托管地址；托管地址记得带 `?sharecode=...`。

> 软件的登录 Cookie 与系统浏览器相互独立，所以第一次打开软件需要用**同一个邮箱账号登录一次**；登录之后数据与网站完全一致。

### 方式三：手机软件（Android / iPhone）

**Android**：把工作区根目录的 `漫画库-Android.apk` 传到手机，点击安装（系统提示「未知来源」时允许），首次打开用**同一个邮箱账号登录一次**即可。Android 6.0 及以上可用。

**iPhone / iPad**：Linux 环境无法生成 iOS 原生安装包，用 Safari 打开同一网址 → 分享 → **添加到主屏幕**，效果等同独立 App。

手机 App 本身只是一个原生 WebView 壳，直接连接线上服务器，本机不存漫画，只记住登录状态与服务器地址，因此与网页、桌面软件实时互通。它支持导入时调起系统文件选择器、导出 CBZ/ZIP/PDF/EPUB 交给系统下载管理器（存到「下载」目录）、返回键网页内后退 / 双击退出、断网错误页一键重试，以及切换服务器地址（可填局域网地址连接电脑本机服务）。

> 兼容性：网站的凭据注入并不依赖 Service Worker（构建层动态加载 + fetch/XHR 补丁 + 资源 URL 递归注入已覆盖），App 内把 SW 换成无副作用的空脚本，锁定在纯网络模式，避免不同 Android 版本的 WebView 差异导致白屏。已用禁用 Service Worker 的移动浏览器实测首页、公共书库、漫画详情、阅读器全部正常。

源码、手工构建流程（`aapt2` → `javac` → `d8` → `zipalign` → `apksigner`）与自签名升级注意事项见 [`mobile/README.md`](mobile/README.md)。

### 验证互通

1. 网页里新建一部漫画；
2. 桌面软件按 `Ctrl/Cmd + R` 刷新 → 立刻出现；
3. 手机 App 重新打开书架（或切到公共书库再切回）→ 同样可见；
4. 软件里改封面或加标签，网页刷新 → 同步更新。

手机端的 WebView 兼容性可复现验证：`python3 mobile/tests/verify_webview.py`。

---

## 数据存储

```
data/
├── db.json       # 全部元数据（漫画 / 章节 / 页面 / 分享 / 设置）
└── store/        # 原始图片与自动生成的 WebP 缩略图
```

**备份 / 迁移就是复制整个 `data` 目录**，不需要导出任何中间格式。

---

## 键盘快捷键

| 键位 | 功能 | 键位 | 功能 |
|---|---|---|---|
| `←` `→` | 上一页 / 下一页（跟随 RTL） | `D` | 单页 / 双页切换 |
| `空格` `Enter` | 下一页 | `R` | 切换阅读方向 |
| `PageUp` `PageDown` | 翻页 | `M` | 打开 / 关闭目录 |
| `+` `-` | 缩放 | `P` | 打开 / 关闭页面缩略图 |
| `W` | 循环切换滤镜 | `F` | 全屏 |
| `?` | 显示快捷键帮助 | `Esc` | 关闭面板 / 退出阅读 |

---

## 技术栈

**前端**：React 18 · TypeScript · Vite · React Router
**后端**：Node.js · Express · Multer
**图像处理**：sharp（缩略图 / 旋转 / 裁剪 / 格式转换）
**文档处理**：pdfjs-dist（PDF 渲染） · pdf-lib（PDF 生成） · 7z-wasm（RAR/7z 等解压） · @zip.js/zip.js（ZIP 解压） · archiver（打包）
**其他**：nanoid（分享 token） · qrcode（二维码）

---

## API 概览

```
漫画      GET    /api/comics                       列表（支持搜索/标签/排序）
          POST   /api/comics                       新建
          GET    /api/comics/:id                   详情
          PATCH  /api/comics/:id                   更新元数据
          DELETE /api/comics/:id                   删除
          POST   /api/comics/:id/duplicate         创建副本
章节      POST   /api/comics/:id/chapters          新增章节
          PATCH  /api/comics/:id/chapters/:cid     改名
          DELETE /api/comics/:id/chapters/:cid     删除
          PUT    /api/comics/:id/chapters/reorder  排序
页面      POST   /api/comics/:id/chapters/:cid/pages            上传页面
          DELETE /api/comics/:id/chapters/:cid/pages/:pid       删除页面
          PUT    /api/comics/:id/chapters/:cid/pages/reorder    页面排序
          POST   /api/comics/:id/chapters/:cid/pages/move       跨话移动
          POST   /api/comics/:id/chapters/:cid/pages/:pid/edit  旋转/裁剪
          POST   /api/comics/:id/chapters/:cid/pages/split      拆分跨页
          POST   /api/comics/:id/chapters/:cid/pages/merge      合并为跨页
封面      POST   /api/comics/:id/cover             上传封面
          POST   /api/comics/:id/cover/page        用某页作封面
进度      PUT    /api/comics/:id/progress          保存阅读进度
分享      POST   /api/comics/:id/share              设置分享
          POST   /api/comics/:id/share/rotate       吊销并换新链接
          GET    /api/comics/:id/share/logs         访问日志
          DELETE /api/comics/:id/share/logs         清空日志
          GET    /api/share/:token                  访客读取
          POST   /api/share/:token/unlock           密码解锁
导出      GET    /api/export/:comicId               导出（cbz|zip|pdf|epub）
          GET    /api/share/:token/export           访客导出
导入      POST   /api/import/archive                上传压缩包（服务端解压）
          POST   /api/import/archive/:sid/commit    确认落盘
          POST   /api/import/folder                 从服务器目录导入
资源      GET    /api/files/:comicId/:chapterId/:file    原图
          GET    /api/thumbs/:comicId/:chapterId/:file   缩略图
账号      POST   /api/auth/register                 注册
          POST   /api/auth/login                    密码登录
          POST   /api/auth/send-code                发送邮箱验证码
          POST   /api/auth/login-code               验证码登录
          POST   /api/auth/email/send-code          发送邮箱验证验证码（需登录）
          POST   /api/auth/email/verify             确认邮箱验证（需登录）
          POST   /api/auth/forgot/send              发送重置密码验证码
          POST   /api/auth/forgot/reset             凭码重置密码
          POST   /api/auth/logout                   登出
          GET    /api/auth/status                   当前登录状态
          GET    /api/me                            我的资料与书架
          PATCH  /api/me                            修改资料
用户书库  GET    /api/users/:id                      用户主页
          GET    /api/community/comics              公共书库
公共协作  POST   /api/comics/:id/aliases             添加别名
          POST   /api/comics/:id/aliases/:id/activate   设为当前名称
          POST   /api/comics/:id/tags                添加标签
          POST   /api/comics/:id/covers/upload       添加封面
          POST   /api/comics/:id/covers/page         用某页添加封面
          POST   /api/comics/:id/covers/:id/activate   设为当前封面
          DELETE /api/comics/:id/{aliases|tags|covers}/:id   仅本人可删自己那条
广场      GET    /api/plaza/boards                   分区列表（含帖子数）
          GET    /api/plaza/posts?board=             帖子列表（按分区筛选）
          POST   /api/plaza/posts                    发帖（文字/分区/附件/表情）
          POST   /api/plaza/posts/:id/like           点赞
          POST   /api/plaza/posts/:id/comments       评论
          DELETE /api/plaza/posts/:id/comments/:cid  删除评论
          DELETE /api/plaza/posts/:id                删帖
          POST   /api/plaza/upload                   上传附件（multipart，≤ 12 个）
          GET    /api/plaza/media/:file              读取附件（?name= 指定下载名）
          GET    /api/plaza/emojis?q=                搜索表情包
          POST   /api/plaza/emojis                   添加自定义表情包
          DELETE /api/plaza/emojis/:id               删除自己添加的表情包
系统      GET    /api/stats                         统计
          PUT    /api/settings                      设置
          GET    /api/runtime                        版本号与能力开关
          GET    /pwa/<code>/manifest.webmanifest   带码 PWA 清单
发现      GET    /api/community/categories          分类列表与各类数量
          GET    /api/community/comics              公共书库（?q= 搜索、?category= 分类、?sort= 排序）
          GET    /api/community/ranking?type=       排行榜（hot|views|likes|downloads|new）
          GET    /api/community/uploads?limit=      公共书库上传记录
          POST   /api/community/import             合规批量导入（须确认合法授权）
          POST   /api/discovery/view               浏览量 +1
          POST   /api/discovery/like               点赞/取消（需登录）
          PATCH  /api/discovery/category           设置分类（需登录）
          GET    /api/plaza/posts?q=               广场全文搜索
          GET    /api/activity?limit=              主页动态流与置顶公告
          GET    /api/announcements                公告列表与发布权限
          POST   /api/announcements                发布公告（仅公告账号）
          DELETE /api/announcements/:id            删除自己发布的公告
          GET    /api/software                     软件下载清单与版本说明
          GET    /api/software/latest             自动更新检查（desktop|android|web）
          GET    /files/ComicVault-android.apk     站内 Android 安装包
```

---

## 本地验证

`tests/` 下有十一个可复跑的脚本。除 `test_mobile_ui.py`、`test_desktop_app.py` 与 `verify_online.py` 连接已有服务外，其余**本地**脚本都用独立临时数据目录启动后端，不会碰你自己的 `data/`；`CV_NO_DOTENV=1` 会隔离项目根目录的 `.env`，保证「未配置发信」场景可复现：

```bash
python3 tests/test_discovery.py     # 后端：分类/排行/搜索/动态/公告权限/软件更新/合规导入，56 项
python3 tests/test_discovery_ui.py  # 浏览器端到端：动态流/公告/公共书库/广场搜索/下载页，16 项
python3 tests/test_plaza_api.py     # 后端：分区 / 附件 / 表情包 / 权限，31 项
python3 tests/test_plaza_ui.py      # 浏览器端到端：广场富媒体 + 导入多选排序，34 项
python3 tests/test_mail.py          # 邮箱验证码真实发信链路，12 项
python3 tests/test_recovery.py      # 邮箱验证 / 找回密码全链路，32 项
python3 tests/test_mobile_ui.py     # 手机底栏/触摸目标/桌面布局，24 项（需先 npm start，或设 CV_BASE_URL）
python3 tests/test_desktop_app.py   # 真实启动 Electron 验证独立客户端，11 项（需 xvfb-run）
python3 tests/test_share_reader.py  # 分享落地页/条漫/上下话/桌面阅读窗口，37 项
python3 tests/test_android_import.py # 模拟 Android 桥验证多选导入网格，18 项
```

依赖 `requests`、`Pillow`、`playwright`（UI 脚本）与本机 Chromium（默认 `/usr/bin/chromium`，可改脚本里的 `CHROMIUM` 常量）。各脚本使用独立端口（`8793` / `8804` / `8811` / `8803` / `8801` / `8796+8797` / `8794+8795`），日志写到 `/tmp/cv-*.log`。UI 脚本会实际导入 4 张图片并读取 `/api/comics/:id` 校验服务端页序与手动排序一致；两个邮件脚本用内置调试 SMTP 服务器收信，**不向外部发信**，`test_recovery.py` 额外覆盖未验证邮箱不可找回、登录码与重置码用途隔离、重置后旧会话失效。

第十一个是**线上只读回归**，发布后用来确认新版本生效、旧数据完好、浏览器不白屏（只发 GET，不写线上数据）：

```bash
python3 tests/verify_online.py
# 换地址：CV_BASE=https://your.domain CV_SHARECODE=ABCD python3 tests/verify_online.py
# 无凭据：CV_BASE=https://your.domain CV_SHARECODE= python3 tests/verify_online.py
```

它检查运行时、分区/帖子/表情包/附件接口、`hasUsers` 与公共书库，再用浏览器打开广场页和设置页，断言无白屏、无控制台错误、无失败请求。

---

## 常见问题

**导入 RAR 时卡住？**
RAR 由服务端解压，首次调用需要加载约 30MB 的 WASM 引擎（服务启动时已预热）。超大压缩包（数百 MB）属于正常耗时。

**导出的 CBZ 在其他阅读器里页序正常吗？**
正常。归档采用顺序流式写入，页名统一为 `001`、`002` 递增，并在包内附带 `ComicInfo.xml`。

**换台机器怎么迁移？**
停掉服务，复制整个 `data` 目录到新机器的项目根目录，再启动即可。

**能多人同时访问吗？**
可以。现在有完整的账号体系：邮箱 + 密码或邮箱验证码登录，每个账号的书架数据彼此隔离；公共书库、广场、用户主页与分享链接可以匿名浏览。删除权限按逐条归属——某话是谁上传的，就只有谁能删那一话；别名、标签、封面同理。

---

## 一键发版：网站自动更新安装包

以前每次发版要手改文件名、体积、版本号并重启服务，现在全部自动化。**版本号的唯一来源是根目录 [`version.json`](version.json)**。

```bash
npm run version:bump      # 小改动：四段版本最后一段 +1
npm run build             # 构建前端；再按常规打包桌面 / Android
npm run release           # 一键发版
git push                  # GitHub Pages 清单随 version.json 自动更新
```

`npm run release`（`scripts/publish-release.cjs`）：

- 扫描成品 → 复制进 `data/installers/`（已被 `.gitignore` 忽略，仓库不会变大）；
- 计算**真实体积**与 **SHA256**，生成 `data/release.json` 与 `docs/release.json`；
- 重建 `漫画库-安装包合集.zip` 并自动写安装说明；

服务端 `server/discovery.js` **每次请求按 mtime 热读** `data/release.json`——所以**发新版不用改代码、不用重启服务**，网站「软件下载」页立刻显示最新文件名、体积、校验和、发布时间；标「本站直链」的从 `/files/` 直接下载，支持断点续传（Range）。

| 命令 | 用途 |
|---|---|
| `npm run release -- --dry-run` | 只预览，不写文件 |
| `npm run release -- --apk-only` | 只更新 APK，秒级 |
| `npm run release -- --no-bundle` | 跳过重建几百 MB 合集 |
| `npm run release -- --manifest-only` | 只生成公开清单（CI 用） |

## 四段版本号（主.次.修.构建）

版本号统一为 `3.1.0.1` 这样的四段式，**避免小改动频繁跳主版本**。规则写在 `version.json` 的 `versionRule`：

| 段 | 何时递增 | 命令 |
|---|---|---|
| 4 构建 | 文案 / 样式 / 脚本 / 文档等小改动（最常用） | `npm run version:bump` |
| 3 修 | 一次完整发版的一组修复 | `npm run version:sync -- --bump 2` |
| 2 次 | 成体系新功能 | `npm run version:sync -- --bump 1` |
| 1 主 | 架构 / 数据格式不兼容 | `npm run version:sync -- --bump 0` |

`npm run version:sync` 把版本幂等同步到全仓库 **11 处引用**（`server/discovery.js`、`desktop/package.json`、`main.js`、`preload.js`、`AndroidManifest.xml`、`MainActivity.java`、`android-bridge.js`、README 等）；`--check` 可用于 CI 检查是否有文件忘了同步。Electron 的 `package.json` 必须是三段 semver，因此桌面**安装包文件名**用 `buildVersion`（`3.1.0`），应用内显示与检查更新用四段；版本比较函数支持任意段数。

---

## 独立客户端 v3.4（不再是网站套壳）

桌面与 Android 客户端在 v3.0 重写为**独立界面**，不再加载网站页面；两者都直连同一台服务器的 `/api`，账号与漫画实时互通。

| | 网站 / PWA | 桌面客户端 | Android 客户端 |
|---|---|---|---|
| 界面 | 浏览器中的 SPA | 本地 `desktop/app/` 界面 | APK 内 `assets/app/` 本地界面 |
| 数据 | 直连服务端 | IPC 直连同一 `/api` | Java 桥直连同一 `/api` |
| 版本 | 2.7.0.1（随服务器） | 3.4.0.1 | 3.4.0.1 |
| 更新 | 刷新即最新 | 设置 → 检查更新 | 设置 → 检查更新 |
| 软件下载页 | 有（网站提供安装包） | **无** | **无** |

桌面端独有的原生能力：拖拽图片 / 文件夹直接导入（自动按文件名排序分话）、原生文件对话框、独立阅读窗口（键盘翻页 / 双页 / 缩放 / 跳页）、系统菜单、托盘常驻、快捷键（`Ctrl+N` 新建、`Ctrl+O` 导入、`Ctrl+Shift+O` 导入文件夹、`F5` 刷新）。

三个端共用同一台服务器、同一个账号、同一份 `data/`。检查更新统一放在各自的「设置」里，软件内不再出现下载页面。版本号分开维护：网站 `APP_VERSION`、客户端 `CLIENT_VERSIONS`（`server/discovery.js`），`/api/software/latest?channel=desktop|android|web` 按平台返回各自版本。

**v3.4 新增（与网站 2.7.0 同步）**

- **多选导入**：手机端修复了此前「选了文件没反应」的问题——`pickFiles()` 改为原生 `ACTION_GET_CONTENT` + `EXTRA_ALLOW_MULTIPLE`，支持从系统文件选择器的「使用漫画页面」（Kotatsu 等来源）一次多选；Java 桥读取 `content://` 并组装 `multipart/form-data` 上传。导入前显示**章节页式网格**：缩略图、编号即页序、逐张勾选、全选 / 反选、按名称排序 / 倒序。
- **条漫模式**：阅读器新增「条漫」选项，图片宽度撑满、零间隙、上下连续滚动，长图不被切断；隐藏翻页按钮与页码，滚到话末直接显示「下一话」入口。
- **上一话 / 下一话**：阅读器底栏与顶栏都有显式按钮，键盘 `[` `]`，读到话末继续前进自动进入下一话。
- **分享落地页**：分享链接打开后先展示封面、标题、作者、简介、话数 / 页数、下载权限、有效期与目录，再点「开始阅读」；阅读中可返回封面，去掉了遮挡画面的浮动下载按钮。

```bash
cd desktop && npm start        # 本地运行独立桌面客户端（需先有服务端）
python3 tests/test_desktop_app.py   # 通过 CDP 验证客户端界面与 API 互通
```

---

## 说明

本项目用于管理你**自己拥有合法权利**的漫画资源，请遵守当地法律法规与版权要求。
