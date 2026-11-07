# 漫画库 · Android 客户端 v3.0

**v3.0 起不再直接显示网站页面。** APK 内打包了一份独立的本地界面（`assets/app/`），由 WebView 从 `file://` 加载；所有数据通过 Java 桥 `AndroidHost` 直连同一台服务器的 `/api`。

> 说明边界：界面是本地打包的独立 HTML/CSS/JS（与网站不同、不依赖网站页面），渲染仍由 Android WebView 承担；桌面端 Electron 则额外提供原生窗口、菜单、托盘与文件对话框。两者都不再是「打开网站的浏览器壳」。

| 项目 | v1 / v2 | v3.0 |
|---|---|---|
| 界面来源 | 远程网站 | APK 内 `assets/app/` |
| 导航 | 网站顶部导航 | 本地界面底部 Tab 栏 |
| 数据请求 | 网页 fetch | Java 桥 `HttpURLConnection` 直连 `/api` |
| 软件下载入口 | 菜单里有 | **已移除** |
| 检查更新 | 菜单「软件下载 / 检查更新」 | **设置 → 检查更新** |
| 版本 | 1.0.0 | 3.0.0（versionCode 3） |

## 成品与安装

| 文件 | 说明 |
|---|---|
| `/workspace/漫画库-Android.apk` | 已签名成品，约 62 KB，Android 6.0（API 23）及以上 |

传到手机后点击安装，允许「未知来源」即可。用与网页 / 桌面软件相同的邮箱账号登录一次，登录态由 `CookieManager` 持久化。

**iPhone / iPad**：Linux 环境无法生成 iOS 原生 IPA，用 Safari 打开网站 → 分享 → 「添加到主屏幕」使用 PWA。

## 功能

- 本地独立界面：底部 Tab（书架 / 公共书库 / 广场 / 设置）、本地阅读器（滑动翻页、缩放、章节切换）
- 设置菜单：查看/切换服务器地址、在浏览器打开网站、**检查更新**、关于与版本
- 外链交给系统浏览器；`file://` 内链（阅读器）留在应用内
- 登录 Cookie 在 `onPause()` 时 `flush()` 到磁盘，进程回收后仍保持登录
- 断网时显示可重试提示页，漫画数据都在服务端，不会丢

## 关键实现

```
app.js  ──window.CVAndroid──▶ android-bridge.js ──▶ AndroidHost (@JavascriptInterface)
                                                     │
                                                     └─▶ HttpURLConnection → /api/*
```

`AndroidHost.api()` 负责拼 URL（保留 `?sharecode=`）、带 Cookie、发 JSON 请求、回写 `Set-Cookie`，返回 `{status, data}`；`asset()` 把封面/页面图路径拼成可直接 `<img>` 加载的绝对地址。因为 `file://` 页面不能跨域 fetch，请求全部走 Java 桥，不依赖 CORS。

## 构建

```bash
export ANDROID_HOME=/opt/android-sdk
export ANDROID_SDK_ROOT=/opt/android-sdk
bash mobile/build-apk.sh
```

`build-apk.sh` 现在是 8 步，新增第 2a 步：把 `desktop/app/` 的 HTML/CSS/JS 与 `mobile/assets/android-bridge.js` 复制进 `assets/app/`，并在两个 HTML 里注入桥脚本，再用 `aapt2 link -A` 打进 APK。其余步骤不变（aapt2 → javac → d8 → zip → zipalign → apksigner）。

所需 SDK 组件：`platforms;android-35`、`build-tools;35.0.0`、`platform-tools`。

> **升级注意**：`comicvault.keystore` 已忽略、不进 Git；后续发版必须用同一密钥签名，否则手机拒绝覆盖安装。

## 已知限制

- 自签名证书，仅用于内部分发，未上架应用商店。
- 界面渲染依赖 WebView，不是纯 Java 原生控件；但界面与数据链路都独立于网站。
- 手机端导入仍以网页端为主（桌面端支持拖拽批量导入）。
- iOS 原生 IPA 无法在 Linux 沙箱生成。
