# ComicVault · 漫画库

一套**支持多用户的漫画社区**：把散落的图片、压缩包、PDF 整理成一话一话，存进私人书架、读得舒服、分享出去只要一条链接；也可以发布到公共书库让大家一起补全，在广场讨论交流。

单端口部署，前后端一体，**数据全部落在你自己的磁盘上**。邮箱注册登录后各账号数据彼此隔离；第一个注册的账号自动接管已有漫画。

---

## 功能一览

### 📥 导入与分话

| 能力 | 说明 |
|---|---|
| 图片多选 | JPG / PNG / WebP / GIF / BMP / AVIF / TIFF |
| 文件夹拖拽 | 直接把整个目录拖进书架，保留目录结构 |
| ZIP / CBZ | 浏览器端解压，自动读取 `ComicInfo.xml` |
| RAR / CBR / 7Z / CB7 | 服务端 7-Zip WASM 引擎解压，大包不占浏览器内存 |
| ACE / ARJ / LZH / CAB / ISO 等 | 同一引擎一并支持 |
| PDF | 按页渲染成图片，可选渲染清晰度 |
| 服务器本地目录 | 已在本机的漫画无需上传，填路径直接入库 |

**四种分话模式**：按目录结构 · 按固定页数 · 按文件名中的编号 · 全部归为单话。分好后每话都能改名、增删、上下移排序。

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

- **登录**：邮箱 + 密码，或邮箱验证码（配 `RESEND_API_KEY` 发真实邮件，未配置时页面直接显示开发验证码）。会话用 httpOnly Cookie。
- **数据隔离**：每本漫画属于一个账号，私密漫画别人打不开；公开漫画别人可看，可单独关闭下载权限。
- **私密也能分享**：分享链接 `/s/<token>` 无需登录，即使是私密漫画，拿到链接的人也能直接阅读。
- **用户主页**：展示昵称、简介、公开漫画与广场动态，可修改资料和头像。
- **公共书库**：所有登录用户都能上传新话、加标签、加多个别名、加多个封面并设为当前显示；**删除按逐条归属**——谁上传的话 / 谁添加的条目，只有本人能删，创建者也删不了别人那一条。
- **广场**：发帖讨论、附带漫画或分享链接、点赞、评论；只能删自己发的帖和评论。
- **自动备份**：数据库原子写入，每 10 分钟留快照，损坏时自动从最新快照恢复。

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
系统      GET    /api/stats                         统计
          PUT    /api/settings                      设置
```

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

## 部署成正式网址（GitHub → Render / Railway）

GitHub Pages 只能放静态网页，**跑不了登录、上传和数据库**；下面两种方式是「用 GitHub 仓库部署成能跑 Node 后端的正式网址」，都会得到一个不带访问凭据的干净地址。

### 方式一：Render Blueprint（推荐）

1. 把本仓库推到 GitHub（已完成）。
2. 打开 <https://dashboard.render.com> → **New** → **Blueprint** → 连接 GitHub 并选择 `comic-vault`。
3. Render 自动读取 `render.yaml`，确认服务与 1GB 磁盘（挂载到 `/data`）。
4. 可选：在 Environment 里填 `RESEND_API_KEY` 和 `MAIL_FROM`，邮箱验证码就会发真实邮件；不填则登录页直接显示「开发模式验证码」，功能一样可用。
5. 点 **Apply**，构建完成后得到 `https://comic-vault-xxxx.onrender.com`。
6. 首次打开会提示「创建第一个账号」，该账号自动接管演示数据。

### 方式二：Railway

1. <https://railway.app> → **New Project** → **Deploy from GitHub repo** → 选择本仓库。
2. Variables 里加 `CV_DATA_DIR=/data`（`PORT` 由平台自动注入，**不要手填**）。
3. Settings → Volumes 挂载一个卷到 `/data`（不挂载则重启后数据会清空）。
4. **Generate Domain** 得到公开地址。

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口，云平台会自动注入 |
| `CV_DATA_DIR` | `data/` | 数据目录，云端应指向持久卷（如 `/data`） |
| `RESEND_API_KEY` | 空 | 配了才发真实邮件，否则页面显示开发验证码 |
| `MAIL_FROM` | `ComicVault <onboarding@resend.dev>` | 发件人，需与 Resend 已验证域名一致 |
| `CV_ALLOW_FS_IMPORT` | `1` | 设为 `0` 关闭「从服务器目录导入」（云端建议关） |

### 数据可靠性

- `db.json` 采用「临时文件 + 原子替换」写入，退出时绝不会写入空库。
- 每 10 分钟自动留一份快照到 `data/backups/`（最多 6 份）；若主库损坏，启动时自动从最新快照恢复，并把坏文件留档为 `db.json.corrupt-*`。
- **云端务必挂载持久卷**，否则容器重启会丢数据；无卷方案只适合试用。

### 与当前演示地址的区别

| | 当前演示地址 | Render / Railway |
|---|---|---|
| 网址 | 带 `?sharecode=` 访问凭据 | 干净地址，无需凭据 |
| 数据 | 沙箱磁盘，演示级 | 平台持久卷，可长期保存 |
| 邮件验证码 | 开发模式（页面直接显示） | 配密钥后发真实邮件 |
| 适用 | 立即体验 | 长期正式使用 |

---

## 说明

本项目用于管理你**自己拥有合法权利**的漫画资源，请遵守当地法律法规与版权要求。
