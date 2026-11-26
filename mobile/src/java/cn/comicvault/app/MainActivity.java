package cn.comicvault.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.app.DownloadManager;
import android.content.Context;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.ContentValues;
import android.provider.MediaStore;
import android.media.MediaScannerConnection;
import android.os.Build;
import android.util.Base64;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.JavascriptInterface;
import java.io.OutputStream;
import java.util.List;
import java.util.Map;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import org.json.JSONArray;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;

/**
 * 漫画库手机客户端。
 *
 * v3.0：界面是打包在本地的独立客户端（assets/app），不再直接显示网站页面。
 * 通过 Java 桥直连同一台服务器的 /api，账号与漫画和网站 / 桌面端实时互通。
 */
public class MainActivity extends Activity {

    private static final String PREFS = "cv_config";
    private static final String KEY_URL = "server_url";
    private static final String KEY_THEME = "theme";
    /** 支持的主题集合（与网站 / 桌面端保持一致） */
    private static final java.util.Set<String> VALID_THEMES = new java.util.HashSet<>(java.util.Arrays.asList(
            "dark", "light", "sea", "forest", "sunset", "sakura"));
    private static final String DEFAULT_URL =
            "https://a3375579f1d0038dc.app.workbuddy.host/?sharecode=HDZTNNHTBW";
    private static final int REQ_FILE = 1001;
    /** 独立客户端「多选导入」使用的原生文件选择器 */
    private static final int REQ_PICK_IMPORT = 1002;
    private static final String APP_VERSION = "3.4.0.41.0";
    private static final String LOCAL_APP_URL = "file:///android_asset/app/index.html";
    private static final String DRIVE_ZIP_URL = "https://www.workbuddy.cn/space/d/owdGBbPU0yzY2UrQGvierZ";
    private static final String KEY_UPDATE_HINT = "last_update_hint";

    private static final int BG = 0xFF0F1115;
    private static final int ACCENT = 0xFF7C6CFF;
    private static final int MUTED = 0xFF97A1B6;

    /**
     * 无副作用的 Service Worker 脚本。
     *
     * 网站已经通过「构建层动态加载 + fetch/XHR 补丁 + 资源 URL 递归注入」三层
     * 把 ?sharecode= 凭据补齐，Service Worker 只是额外的离线外壳，并非必需；
     * 实测在完全禁用 Service Worker 时，首页、公共书库、漫画详情、阅读器的
     * JS/CSS/接口/图片全部 200 且零错误。
     *
     * Android WebView 的 Service Worker 行为随系统版本差异较大（拦截、重定向、
     * clients.claim 与 Chrome 不完全一致），一旦它接管导航请求反而可能白屏。
     * 因此这里返回一个不含 fetch 监听的空 Service Worker，把手机端稳定锁定在
     * 已验证的「纯网络」路径上，同时保证注册调用不会报错、不会有 404 日志。
     */
    private static final byte[] NOOP_SW =
            ("/* ComicVault Android: Service Worker intentionally disabled. */\n")
                    .getBytes(StandardCharsets.UTF_8);

    private WebView web;
    private View loadingView;
    private View errorView;
    private TextView errorText;
    private ValueCallback<Uri[]> filePathCallback;
    /** 原生多选导入选择的 content:// 文件，id -> Uri，供桥组装 multipart 上传 */
    private final java.util.LinkedHashMap<String, Uri> pickedUris = new java.util.LinkedHashMap<>();
    private boolean loadFailed = false;
    private long lastBack = 0;
    private String currentUrl = DEFAULT_URL;
    private TextView loadingUrlText;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BG);

        web = new WebView(this);
        web.setBackgroundColor(BG);
        configureWebView();
        root.addView(web, full());

        loadingView = buildLoadingView();
        root.addView(loadingView, full());

        errorView = buildErrorView();
        errorView.setVisibility(View.GONE);
        root.addView(errorView, full());
        root.addView(buildSettingsButton(), settingsButtonParams());

        setContentView(root);
        loadSite();
        // 启动时静默检查一次客户端新版本，同一版本只提示一次
        checkUpdate(true);
    }

    private FrameLayout.LayoutParams full() {
        return new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    /* ------------------------------ WebView 配置 ------------------------------ */

    private void configureWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setUserAgentString(s.getUserAgentString() + " ComicVaultAndroid/3.4");

        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        web.addJavascriptInterface(new JsBridge(), "AndroidHost");

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme();
                if ("file".equalsIgnoreCase(scheme)) return false;
                if ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) {
                    String host = uri.getHost();
                    String baseHost = Uri.parse(currentUrl).getHost();
                    if (host != null && host.equalsIgnoreCase(baseHost)) return false;
                }
                openExternally(uri);
                return true;
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri != null && "/sw.js".equals(uri.getPath())) {
                    return new WebResourceResponse(
                            "application/javascript", "utf-8",
                            new ByteArrayInputStream(NOOP_SW));
                }
                return super.shouldInterceptRequest(view, request);
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                loadFailed = false;
                loadingView.setVisibility(View.VISIBLE);
                errorView.setVisibility(View.GONE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (!loadFailed) {
                    loadingView.setVisibility(View.GONE);
                    errorView.setVisibility(View.GONE);
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                loadFailed = true;
                loadingView.setVisibility(View.GONE);
                showError(String.valueOf(error.getDescription()));
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            // WebView 默认不支持 window.prompt/alert/confirm，必须显式实现，
            // 否则「用邮箱验证码登录」等依赖 prompt 的功能在 App 里完全无法输入
            @Override
            public boolean onJsPrompt(WebView view, String url, String message, String defaultValue,
                                      JsPromptResult result) {
                final EditText input = new EditText(MainActivity.this);
                input.setText(defaultValue == null ? "" : defaultValue);
                input.setSelection(input.getText().length());
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle("漫画库")
                        .setMessage(message)
                        .setView(input)
                        .setPositiveButton("确定", (d, w) -> result.confirm(input.getText().toString()))
                        .setNegativeButton("取消", (d, w) -> result.cancel())
                        .setOnCancelListener(d -> result.cancel())
                        .show();
                return true;
            }

            @Override
            public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle("漫画库")
                        .setMessage(message)
                        .setPositiveButton("确定", (d, w) -> result.confirm())
                        .setOnCancelListener(d -> result.cancel())
                        .show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle("漫画库")
                        .setMessage(message)
                        .setPositiveButton("确定", (d, w) -> result.confirm())
                        .setNegativeButton("取消", (d, w) -> result.cancel())
                        .setOnCancelListener(d -> result.cancel())
                        .show();
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = callback;
                try {
                    Intent pick = params.createIntent();
                    // 不用 createChooser 包装：部分系统选择器在 chooser 下会忽略 EXTRA_ALLOW_MULTIPLE
                    if (params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
                        pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    }
                    startActivityForResult(pick, REQ_FILE);
                } catch (Exception e) {
                    filePathCallback = null;
                    Toast.makeText(MainActivity.this, "无法打开文件选择器", Toast.LENGTH_SHORT).show();
                    return false;
                }
                return true;
            }
        });

        // 导出 CBZ / ZIP / PDF / EPUB 时交给系统下载管理器
        web.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            try {
                DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                String cookie = CookieManager.getInstance().getCookie(url);
                if (cookie != null) req.addRequestHeader("Cookie", cookie);
                if (userAgent != null) req.addRequestHeader("User-Agent", userAgent);
                String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
                req.setNotificationVisibility(
                        DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                dm.enqueue(req);
                Toast.makeText(this, "已开始下载：" + name, Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                openExternally(Uri.parse(url));
            }
        });
    }

    private void openExternally(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception ignored) {
            /* 没有可处理的应用则忽略 */
        }
    }

    /* ------------------------------ 界面 ------------------------------ */

    private View buildLoadingView() {
        LinearLayout box = centeredBox();

        TextView logo = new TextView(this);
        logo.setText("📚");
        logo.setTextSize(38);
        logo.setGravity(Gravity.CENTER);
        GradientDrawable badge = new GradientDrawable();
        badge.setColor(ACCENT);
        badge.setCornerRadius(dp(18));
        logo.setBackground(badge);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(76), dp(76));
        lp.gravity = Gravity.CENTER_HORIZONTAL;
        lp.bottomMargin = dp(22);
        box.addView(logo, lp);

        box.addView(label("漫画库 ComicVault", 21, 0xFFE9EDF6, dp(0), dp(6)));
        box.addView(label("正在连接服务器…", 13, MUTED, dp(0), dp(8)));

        loadingUrlText = new TextView(this);
        loadingUrlText.setText(currentUrl);
        loadingUrlText.setTextSize(11);
        loadingUrlText.setTextColor(MUTED);
        loadingUrlText.setGravity(Gravity.CENTER);
        loadingUrlText.setPadding(dp(18), 0, dp(18), dp(20));
        box.addView(loadingUrlText);

        ProgressBar bar = new ProgressBar(this, null, android.R.attr.progressBarStyle);
        bar.setIndeterminate(true);
        LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(dp(160), dp(6));
        blp.gravity = Gravity.CENTER_HORIZONTAL;
        box.addView(bar, blp);

        TextView switcher = new TextView(this);
        switcher.setText("更换服务器地址");
        switcher.setTextSize(13);
        switcher.setTextColor(ACCENT);
        switcher.setPadding(dp(16), dp(16), dp(16), dp(16));
        switcher.setOnClickListener(v -> showServerDialog());
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        slp.gravity = Gravity.CENTER_HORIZONTAL;
        slp.topMargin = dp(26);
        box.addView(switcher, slp);
        return box;
    }

    private View buildErrorView() {
        LinearLayout box = centeredBox();
        box.addView(label("暂时连不上服务器", 20, 0xFFE9EDF6, dp(0), dp(10)));

        errorText = label("", 13, MUTED, dp(0), dp(14));
        box.addView(errorText);

        box.addView(label("漫画与账号数据都保存在服务器端，\n恢复网络后重新连接即可，不会丢失。",
                13, MUTED, dp(0), dp(22)));

        box.addView(button("重新连接", true, v -> loadSite()));
        box.addView(button("切换服务器", false, v -> showServerDialog()));
        return box;
    }

    private LinearLayout centeredBox() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(BG);
        box.setPadding(dp(32), dp(24), dp(32), dp(24));
        box.setClickable(true);
        return box;
    }

    private TextView label(String text, float size, int color, int topMargin, int bottomMargin) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextSize(size);
        t.setTextColor(color);
        t.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.gravity = Gravity.CENTER_HORIZONTAL;
        lp.topMargin = topMargin;
        lp.bottomMargin = bottomMargin;
        t.setLayoutParams(lp);
        return t;
    }

    private Button button(String text, boolean primary, View.OnClickListener listener) {
        Button b = new Button(this);
        b.setText(text);
        b.setTextSize(14);
        b.setAllCaps(false);
        b.setOnClickListener(listener);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(primary ? ACCENT : 0xFF1E2431);
        bg.setCornerRadius(dp(10));
        if (!primary) bg.setStroke(1, 0xFF272E3D);
        b.setBackground(bg);
        b.setTextColor(primary ? Color.WHITE : 0xFFE9EDF6);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(220), dp(46));
        lp.gravity = Gravity.CENTER_HORIZONTAL;
        lp.bottomMargin = dp(10);
        b.setLayoutParams(lp);
        return b;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    /** 本地界面与服务器之间的桥：所有 /api 请求由 Java 发出，避免 file:// 跨域限制 */
    private class JsBridge {
        @JavascriptInterface
        public String api(String spec) {
            try {
                JSONObject o = new JSONObject(spec);
                String method = o.optString("method", "GET");
                String path = o.optString("path", "/");
                JSONObject query = o.optJSONObject("query");
                String body = (o.isNull("body") || !o.has("body")) ? null : o.get("body").toString();
                JSONArray files = o.optJSONArray("files");

                Uri base = Uri.parse(currentUrl);
                String code = base.getQueryParameter("sharecode");
                Uri.Builder b = base.buildUpon().path(path).clearQuery();
                if (query != null) {
                    java.util.Iterator<String> it = query.keys();
                    while (it.hasNext()) {
                        String k = it.next();
                        b.appendQueryParameter(k, query.optString(k));
                    }
                }
                if (code != null) b.appendQueryParameter("sharecode", code);

                HttpURLConnection conn = (HttpURLConnection) new URL(b.build().toString()).openConnection();
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(files != null && files.length() > 0 ? 600000 : 20000);
                conn.setRequestMethod(method);
                conn.setRequestProperty("Accept", "application/json");
                String cookie = CookieManager.getInstance().getCookie(currentUrl);
                if (cookie != null) conn.setRequestProperty("Cookie", cookie);
                if (files != null && files.length() > 0) {
                    conn.setDoOutput(true);
                    // 流式上传：不预设流式模式时 HttpURLConnection 会把整个请求体缓冲在内存里
                    // 才开始发送——大文件（几百话小说 / 整本漫画）会长时间无进展甚至内存溢出
                    conn.setChunkedStreamingMode(256 * 1024);
                    String boundary = "----cv" + System.currentTimeMillis()
                            + Long.toHexString(System.nanoTime());
                    conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
                    OutputStream os = conn.getOutputStream();
                    if (body != null && !"null".equals(body)) {
                        try {
                            JSONObject fields = new JSONObject(body);
                            java.util.Iterator<String> fk = fields.keys();
                            while (fk.hasNext()) {
                                String k = fk.next();
                                os.write(("--" + boundary + "\r\n"
                                        + "Content-Disposition: form-data; name=\"" + k + "\"\r\n\r\n"
                                        + fields.optString(k) + "\r\n").getBytes(StandardCharsets.UTF_8));
                            }
                        } catch (Exception ignore) { /* body 非对象时忽略普通字段 */ }
                    }
                    for (int i = 0; i < files.length(); i++) {
                        JSONObject f = files.optJSONObject(i);
                        if (f == null) continue;
                        String id = f.optString("id", "");
                        String name = f.optString("name", "page.jpg")
                                .replace("\"", "_").replace("\r", "").replace("\n", "");
                        /* 服务端有的接口收单个 file、有的收多个 files，按前端指定的字段名上传 */
                        String field = f.optString("field", "files");
                        if (field == null || field.trim().isEmpty()) field = "files";
                        Uri u = pickedUris.get(id);
                        if (u == null) continue;
                        java.io.InputStream is = getContentResolver().openInputStream(u);
                        if (is == null) continue;
                        os.write(("--" + boundary + "\r\n"
                                + "Content-Disposition: form-data; name=\"" + field + "\"; filename=\"" + name + "\"\r\n"
                                + "Content-Type: application/octet-stream\r\n\r\n").getBytes(StandardCharsets.UTF_8));
                        byte[] buf = new byte[16384];
                        int n;
                        while ((n = is.read(buf)) > 0) os.write(buf, 0, n);
                        is.close();
                        os.write("\r\n".getBytes(StandardCharsets.UTF_8));
                    }
                    os.write(("--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
                    os.close();
                } else if (body != null && !"null".equals(body)) {
                    conn.setDoOutput(true);
                    conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                    OutputStream os = conn.getOutputStream();
                    os.write(body.getBytes(StandardCharsets.UTF_8));
                    os.close();
                }
                int status = conn.getResponseCode();
                java.io.InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                StringBuilder sb = new StringBuilder();
                if (in != null) {
                    BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
                    String line;
                    while ((line = r.readLine()) != null) sb.append(line);
                    r.close();
                }
                Map<String, List<String>> headers = conn.getHeaderFields();
                List<String> cookies = headers.get("Set-Cookie");
                if (cookies == null) cookies = headers.get("set-cookie");
                if (cookies != null) {
                    for (String c : cookies) CookieManager.getInstance().setCookie(currentUrl, c);
                }
                conn.disconnect();
                String text = sb.toString();
                JSONObject out = new JSONObject();
                out.put("status", status);
                try { out.put("data", new JSONObject(text)); }
                catch (Exception e) { out.put("data", text); }
                return out.toString();
            } catch (Exception e) {
                String hint = String.valueOf(e.getMessage());
                if (hint == null || hint.isEmpty() || "null".equals(hint)) hint = "网络连接失败";
                if (hint.contains("timeout") || hint.contains("Timeout") || hint.contains("connect")) {
                    hint += "：请检查网络；若已开启 VPN / 加速器，请先关闭或把漫画库相关域名设为直连";
                }
                try {
                    return new JSONObject().put("status", 0)
                            .put("data", new JSONObject().put("error", hint))
                            .toString();
                } catch (Exception x) {
                    return "{\"status\":0,\"data\":{\"error\":\"request failed\"}}";
                }
            }
        }

        @JavascriptInterface
        public String asset(String path) {
            Uri base = Uri.parse(currentUrl);
            String code = base.getQueryParameter("sharecode");
            Uri.Builder b = base.buildUpon().path(path).clearQuery();
            if (code != null) b.appendQueryParameter("sharecode", code);
            return b.build().toString();
        }

        /** 打开系统多选文件选择器：可从「浏览其他应用中的文件」进入 Kotatsu 等漫画来源。
         *  MIME 设为通配符并配合 EXTRA_MIME_TYPES，才能把压缩包、PDF 等非图片格式一起列出来。 */
        @JavascriptInterface public String pickFiles() {
            runOnUiThread(() -> {
                try {
                    Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("*/*");
                    i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    i.putExtra(Intent.EXTRA_LOCAL_ONLY, true);
                    i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                            "image/*", "application/zip", "application/x-zip-compressed",
                            "application/x-cbz", "application/vnd.comicbook+zip",
                            "application/vnd.rar", "application/x-rar-compressed",
                            "application/x-7z-compressed", "application/pdf",
                            "application/epub+zip", "application/x-pdf",
                            "application/octet-stream", "text/plain"});
                    startActivityForResult(i, REQ_PICK_IMPORT);
                } catch (Exception e) {
                    notifyFilesPicked("[]");
                }
            });
            return "{}";
        }

        /** 已选图片的缩略图 data URL，让导入网格像漫画章节页那样显示真实预览 */
        @JavascriptInterface public String thumb(String id) {
            try {
                Uri u = pickedUris.get(id);
                if (u == null) return "";
                android.graphics.BitmapFactory.Options opt = new android.graphics.BitmapFactory.Options();
                opt.inSampleSize = 8;
                java.io.InputStream is = getContentResolver().openInputStream(u);
                if (is == null) return "";
                android.graphics.Bitmap bmp = android.graphics.BitmapFactory.decodeStream(is, null, opt);
                is.close();
                if (bmp == null || bmp.getWidth() == 0) return "";
                int w = 180;
                int h = Math.max(1, Math.round((float) bmp.getHeight() / bmp.getWidth() * w));
                android.graphics.Bitmap small = android.graphics.Bitmap.createScaledBitmap(bmp, w, Math.min(h, 320), true);
                java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                small.compress(android.graphics.Bitmap.CompressFormat.JPEG, 62, bos);
                small.recycle();
                bmp.recycle();
                return "data:image/jpeg;base64," + android.util.Base64.encodeToString(
                        bos.toByteArray(), android.util.Base64.NO_WRAP);
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface public String getConfig() {
            try {
                String saved = prefs().getString(KEY_THEME, "dark");
                if (!VALID_THEMES.contains(saved)) saved = "dark";
                return new JSONObject().put("server", currentUrl)
                        .put("mode", "remote")
                        .put("theme", saved).put("version", APP_VERSION).toString();
            } catch (Exception e) { return "{}"; }
        }

        @JavascriptInterface public String setServer(String url) {
            final String u = url;
            runOnUiThread(() -> {
                prefs().edit().putString(KEY_URL, u).apply();
                currentUrl = u;
                loadSite();
            });
            return "{}";
        }

        @JavascriptInterface public String setTheme(String theme) {
            String t = VALID_THEMES.contains(theme) ? theme : "dark";
            prefs().edit().putString(KEY_THEME, t).apply();
            return "{\"ok\":true,\"theme\":\"" + t + "\"}";
        }

        /** 软件内下载新版 APK：交给系统下载管理器，完成后点通知即可安装。
         *  返回 JSON 给 app.js，避免「点下载没反应」；异常时退回浏览器打开下载地址。 */
        @JavascriptInterface public String installUpdate(String url) {
            final String u = String.valueOf(url);
            if (!u.startsWith("http://") && !u.startsWith("https://")) {
                return "{\"ok\":false,\"error\":\"下载地址不合法\"}";
            }
            runOnUiThread(() -> {
                try {
                    DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                    if (dm == null) throw new IllegalStateException("no download service");
                    String name = u.substring(u.lastIndexOf('/') + 1);
                    int q = name.indexOf('?');
                    if (q > 0) name = name.substring(0, q);
                    if (!name.endsWith(".apk")) name = "ComicVault-update.apk";
                    DownloadManager.Request req = new DownloadManager.Request(Uri.parse(u));
                    req.setTitle("漫画库 新版本安装包");
                    req.setDescription("下载完成后点击通知，按提示完成安装");
                    req.setNotificationVisibility(
                            DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    req.setMimeType("application/vnd.android.package-archive");
                    req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                    dm.enqueue(req);
                    android.widget.Toast.makeText(MainActivity.this,
                            "开始下载新版本，完成后请点通知栏安装",
                            android.widget.Toast.LENGTH_LONG).show();
                } catch (Exception e) {
                    openExternally(Uri.parse(u));
                }
            });
            return "{\"ok\":true,\"installed\":false}";
        }

        @JavascriptInterface public String checkUpdate() {
            try {
                JSONObject info = fetchUpdateJson();
                info.put("ok", true).put("current", APP_VERSION);
                return info.toString();
            } catch (Exception e) {
                return "{\"ok\":false,\"error\":\""
                        + String.valueOf(e.getMessage()).replace("\"", "'") + "\"}";
            }
        }

        @JavascriptInterface public String siteUrl() { return currentUrl; }
        @JavascriptInterface public String version() { return APP_VERSION; }

        @JavascriptInterface public String openExternal(String url) {
            final String u = url;
            runOnUiThread(() -> openExternally(Uri.parse(u)));
            return "{}";
        }

        @JavascriptInterface public String openDownload() {
            runOnUiThread(() -> openExternally(Uri.parse(DRIVE_ZIP_URL)));
            return "{}";
        }

        @JavascriptInterface public String openReader(String comic, String chapter) {
            runOnUiThread(() -> web.loadUrl("file:///android_asset/app/reader.html?comic="
                    + Uri.encode(comic) + "&chapter=" + Uri.encode(chapter)));
            return "{}";
        }

        @JavascriptInterface public String closeReader() {
            runOnUiThread(() -> web.loadUrl(LOCAL_APP_URL));
            return "{}";
        }

        /** 把服务器上的一张图片读成 data URL。file:// 页面无法直接 fetch http 图片，
         *  由 Java 代理取回字节，供 saveImage 写进相册（阅读器「保存本页」用）。 */
        @JavascriptInterface public String imageToDataUrl(String url) {
            try {
                String u = String.valueOf(url);
                if (!u.startsWith("http://") && !u.startsWith("https://")) return "";
                HttpURLConnection conn = (HttpURLConnection) new URL(u).openConnection();
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(30000);
                String cookie = CookieManager.getInstance().getCookie(currentUrl);
                if (cookie != null) conn.setRequestProperty("Cookie", cookie);
                conn.setRequestProperty("Accept", "image/*");
                String mime = conn.getContentType();
                if (mime == null || !mime.startsWith("image/")) mime = "image/jpeg";
                mime = mime.split(";")[0].trim();
                java.io.InputStream is = conn.getInputStream();
                java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
                is.close();
                conn.disconnect();
                return "data:" + mime + ";base64," + Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
            } catch (Exception e) {
                return "";
            }
        }

        /** 保存一张图片到系统相册 Pictures/ComicVault（分享二维码 / 阅读器单页通用）。
         *  Android WebView 里 <a download> 对 data URL 不会触发任何下载，以前表现为
         *  「点『保存二维码』没反应」；这里统一由 Java 用 MediaStore 落盘并给 Toast 反馈。 */
        @JavascriptInterface public String saveImage(String dataUrl, String name) {
            try {
                String s = String.valueOf(dataUrl);
                int comma = s.indexOf(",");
                if (!s.startsWith("data:image/") || comma < 0) {
                    return "{\"ok\":false,\"error\":\"图片数据无效\"}";
                }
                String head = s.substring(0, comma);
                byte[] bytes = Base64.decode(s.substring(comma + 1), Base64.DEFAULT);
                String mime = head.contains("image/png") ? "image/png"
                        : head.contains("image/webp") ? "image/webp"
                        : head.contains("image/gif") ? "image/gif"
                        : head.contains("image/bmp") ? "image/bmp" : "image/jpeg";
                String ext = "image/png".equals(mime) ? ".png"
                        : "image/webp".equals(mime) ? ".webp"
                        : "image/gif".equals(mime) ? ".gif"
                        : "image/bmp".equals(mime) ? ".bmp" : ".jpg";
                String safe = String.valueOf(name).replaceAll("[^a-zA-Z0-9._\\-\\u4e00-\\u9fa5]", "_");
                if (safe.length() > 80) safe = safe.substring(0, 80);
                if (safe.isEmpty()) safe = "ComicVault-图片";
                final String display = safe + ext;
                final String result;
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.Images.Media.DISPLAY_NAME, display);
                    cv.put(MediaStore.Images.Media.MIME_TYPE, mime);
                    cv.put(MediaStore.Images.Media.RELATIVE_PATH,
                            Environment.DIRECTORY_PICTURES + "/ComicVault");
                    Uri uri = getContentResolver().insert(
                            MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cv);
                    if (uri == null) throw new IllegalStateException("无法创建相册条目");
                    OutputStream os = getContentResolver().openOutputStream(uri);
                    if (os == null) throw new IllegalStateException("无法写入相册");
                    os.write(bytes);
                    os.flush();
                    os.close();
                    result = Environment.DIRECTORY_PICTURES + "/ComicVault/" + display;
                } else {
                    java.io.File dir = new java.io.File(
                            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES),
                            "ComicVault");
                    if (!dir.exists() && !dir.mkdirs()) {
                        throw new IllegalStateException("无法创建图片目录");
                    }
                    java.io.File f = new java.io.File(dir, display);
                    java.io.FileOutputStream fos = new java.io.FileOutputStream(f);
                    fos.write(bytes);
                    fos.flush();
                    fos.close();
                    MediaScannerConnection.scanFile(MainActivity.this,
                            new String[]{f.getAbsolutePath()}, new String[]{mime}, null);
                    result = f.getAbsolutePath();
                }
                runOnUiThread(() -> Toast.makeText(MainActivity.this,
                        "已保存到相册：" + display, Toast.LENGTH_LONG).show());
                try {
                    return new JSONObject().put("ok", true).put("path", result).toString();
                } catch (Exception e) {
                    return "{\"ok\":true}";
                }
            } catch (Exception e) {
                try {
                    return new JSONObject().put("ok", false)
                            .put("error", String.valueOf(e.getMessage()).replace("\"", "'")).toString();
                } catch (Exception x) {
                    return "{\"ok\":false}";
                }
            }
        }

        /** 下载服务器上的文件（按话 / 整本导出）到公共「下载」目录，通知栏可见。
         *  与桌面端 cv:save-api-file 对齐，让手机端也能选择单话 / 多话 / 整本下载。 */
        @JavascriptInterface public String saveApiFile(String apiPath, String defaultName) {
            try {
                String p = String.valueOf(apiPath);
                Uri base = Uri.parse(currentUrl);
                String code = base.getQueryParameter("sharecode");
                int q = p.indexOf('?');
                String pathPart = q >= 0 ? p.substring(0, q) : p;
                String queryPart = q >= 0 ? p.substring(q + 1) : "";
                String url = base.buildUpon().path(pathPart).clearQuery().build().toString();
                if (!queryPart.isEmpty()) url += "?" + queryPart;
                if (code != null && !queryPart.contains("sharecode=")) {
                    url += (queryPart.isEmpty() ? "?" : "&") + "sharecode=" + Uri.encode(code);
                }
                String name = String.valueOf(defaultName)
                        .replaceAll("[^a-zA-Z0-9._\\-\\u4e00-\\u9fa5]", "_");
                if (name.isEmpty()) name = "ComicVault-export.cbz";
                DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                if (dm == null) throw new IllegalStateException("no download service");
                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                req.setTitle(name);
                req.setDescription("漫画库导出文件");
                req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                String cookie = CookieManager.getInstance().getCookie(currentUrl);
                if (cookie != null) req.addRequestHeader("Cookie", cookie);
                dm.enqueue(req);
                final String msg = "开始下载：" + name + "，完成后在「下载」目录查看";
                runOnUiThread(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show());
                return new JSONObject().put("ok", true)
                        .put("path", Environment.DIRECTORY_DOWNLOADS + "/" + name).toString();
            } catch (Exception e) {
                try {
                    return new JSONObject().put("ok", false)
                            .put("error", String.valueOf(e.getMessage()).replace("\"", "'")).toString();
                } catch (Exception x) {
                    return "{\"ok\":false}";
                }
            }
        }
    }

    /* ------------------------------ 逻辑 ------------------------------ */

    private void loadSite() {
        currentUrl = prefs().getString(KEY_URL, DEFAULT_URL);
        loadFailed = false;
        errorView.setVisibility(View.GONE);
        loadingView.setVisibility(View.VISIBLE);
        if (loadingUrlText != null) loadingUrlText.setText(currentUrl);
        web.loadUrl(LOCAL_APP_URL);
    }

    private void showError(String message) {
        errorText.setText(message);
        errorView.setVisibility(View.VISIBLE);
        loadingView.setVisibility(View.GONE);
    }

    private void showServerDialog() {
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setText(prefs().getString(KEY_URL, DEFAULT_URL));
        input.setSelection(input.getText().length());
        input.setTextColor(0xFFE9EDF6);

        new AlertDialog.Builder(this)
                .setTitle("服务器地址")
                .setMessage("默认连接线上网站。若电脑本机启动了服务，可填局域网地址（手机需与电脑同一网络）。")
                .setView(input)
                .setPositiveButton("保存并连接", (d, w) -> {
                    String v = input.getText().toString().trim();
                    if (!v.startsWith("http://") && !v.startsWith("https://")) v = "https://" + v;
                    prefs().edit().putString(KEY_URL, v).apply();
                    loadSite();
                })
                .setNeutralButton("恢复默认", (d, w) -> {
                    prefs().edit().putString(KEY_URL, DEFAULT_URL).apply();
                    loadSite();
                })
                .setNegativeButton("取消", null)
                .show();
    }


    /* ------------------------------ 软件设置 / 自动更新 ------------------------------ */

    private View buildSettingsButton() {
        TextView b = new TextView(this);
        b.setText("⚙");
        b.setTextSize(20);
        b.setTextColor(Color.WHITE);
        b.setGravity(Gravity.CENTER);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(ACCENT);
        bg.setCornerRadius(dp(24));
        b.setBackground(bg);
        b.setAlpha(0.82f);
        b.setOnClickListener(v -> showSettingsMenu());
        return b;
    }

    private FrameLayout.LayoutParams settingsButtonParams() {
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(dp(46), dp(46));
        lp.gravity = Gravity.BOTTOM | Gravity.END;
        lp.rightMargin = dp(16);
        // 抬到移动端底部 Tab 栏（约 60dp + 安全区）之上，避免遮挡最右侧「广场」
        lp.bottomMargin = dp(76);
        return lp;
    }

    private void showSettingsMenu() {
        String[] items = {
                "查看服务器地址", "在浏览器打开网站", "检查更新",
                "切换服务器地址", "关于与版本"
        };
        new AlertDialog.Builder(this)
                .setTitle("软件设置 · 漫画库 v" + APP_VERSION)
                .setItems(items, (d, which) -> {
                    switch (which) {
                        case 0: showSiteUrlDialog(); break;
                        case 1: openExternally(Uri.parse(currentUrl)); break;
                        case 2: checkUpdate(false); break;
                        case 3: showServerDialog(); break;
                        case 4: showAboutDialog(); break;
                        default: break;
                    }
                })
                .setNegativeButton("关闭", null)
                .show();
    }

    private void showSiteUrlDialog() {
        new AlertDialog.Builder(this)
                .setTitle("网站地址")
                .setMessage("软件连接的网站：\n" + currentUrl
                        + "\n\n桌面软件、手机 App 与网页共用这个地址、同一个账号与同一份数据。")
                .setPositiveButton("复制", (d, w) -> {
                    ClipboardManager cm =
                            (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                    if (cm != null) {
                        cm.setPrimaryClip(ClipData.newPlainText("ComicVault 网站地址", currentUrl));
                        Toast.makeText(this, "网址已复制", Toast.LENGTH_SHORT).show();
                    }
                })
                .setNeutralButton("浏览器打开", (d, w) -> openExternally(Uri.parse(currentUrl)))
                .setNegativeButton("关闭", null)
                .show();
    }

    private void showAboutDialog() {
        new AlertDialog.Builder(this)
                .setTitle("关于 漫画库")
                .setMessage("手机客户端 v" + APP_VERSION + "\n\n网站地址：\n" + currentUrl
                        + "\n\n这是独立客户端界面，通过服务器 API 与网页 / 桌面软件实时同步；"
                        + "检查更新请在「设置」里进行。")
                .setPositiveButton("知道了", null)
                .show();
    }

    /** silent = true 用于启动时自动检查，同一版本只提示一次 */
    private void checkUpdate(boolean silent) {
        if (!silent) Toast.makeText(this, "正在检查更新…", Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            try {
                JSONObject info = fetchUpdateJson();
                runOnUiThread(() -> handleUpdateResult(info, silent));
            } catch (Exception e) {
                String reason = e.getMessage() == null ? "网络不可用" : e.getMessage();
                runOnUiThread(() -> {
                    if (!silent) {
                        Toast.makeText(this, "检查更新失败：" + reason, Toast.LENGTH_LONG).show();
                    }
                });
            }
        }).start();
    }

    private JSONObject fetchUpdateJson() throws Exception {
        Uri base = Uri.parse(currentUrl);
        String code = base.getQueryParameter("sharecode");
        Uri.Builder b = base.buildUpon().path("/api/software/latest").clearQuery();
        b.appendQueryParameter("channel", "android");
        b.appendQueryParameter("current", APP_VERSION);
        if (code != null) b.appendQueryParameter("sharecode", code);
        HttpURLConnection conn =
                (HttpURLConnection) new URL(b.build().toString()).openConnection();
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(8000);
        conn.setRequestMethod("GET");
        try {
            if (conn.getResponseCode() != 200) {
                throw new Exception("HTTP " + conn.getResponseCode());
            }
            BufferedReader r = new BufferedReader(
                    new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) sb.append(line);
            r.close();
            return new JSONObject(sb.toString());
        } finally {
            conn.disconnect();
        }
    }

    private void handleUpdateResult(JSONObject info, boolean silent) {
        String latest = info.optString("latest", APP_VERSION);
        boolean has = info.optBoolean("hasUpdate", false);
        String hint = info.optString("hint", "");
        JSONArray notes = info.optJSONArray("notes");
        StringBuilder sb = new StringBuilder();
        if (notes != null) {
            for (int i = 0; i < notes.length(); i++) {
                sb.append("· ").append(notes.optString(i)).append("\n");
            }
        }
        if (!has) {
            if (!silent) {
                new AlertDialog.Builder(this)
                        .setTitle("已是最新版本")
                        .setMessage("当前客户端 v" + APP_VERSION + "，服务器 v" + latest + "\n" + hint)
                        .setPositiveButton("知道了", null)
                        .show();
            }
            return;
        }
        String shown = prefs().getString(KEY_UPDATE_HINT, "");
        if (silent && latest.equals(shown)) return;
        prefs().edit().putString(KEY_UPDATE_HINT, latest).apply();
        new AlertDialog.Builder(this)
                .setTitle("发现新版本 v" + latest)
                .setMessage("当前客户端 v" + APP_VERSION + "\n\n" + sb.toString().trim()
                        + "\n\n" + hint)
                .setPositiveButton("知道了", null)
                .setNegativeButton("稍后", null)
                .show();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE && filePathCallback != null) {
            filePathCallback.onReceiveValue(
                    WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            filePathCallback = null;
            return;
        }
        if (requestCode == REQ_PICK_IMPORT) {
            JSONArray arr = new JSONArray();
            pickedUris.clear();
            if (resultCode == RESULT_OK && data != null) {
                ClipData clip = data.getClipData();
                if (clip != null) {
                    for (int i = 0; i < clip.getItemCount(); i++) {
                        addPickedUri(clip.getItemAt(i).getUri(), arr);
                    }
                } else if (data.getData() != null) {
                    addPickedUri(data.getData(), arr);
                }
            }
            notifyFilesPicked(arr.toString());
        }
    }

    /** 把系统选择器返回的一个 content:// 登记进待上传表，并解析显示名 */
    private void addPickedUri(Uri u, JSONArray arr) {
        if (u == null) return;
        try {
            try {
                getContentResolver().takePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignore) { /* 部分来源不支持持久化授权，会话内仍可读 */ }
            String name = "";
            android.database.Cursor cur = null;
            try {
                cur = getContentResolver().query(u, null, null, null, null);
                if (cur != null && cur.moveToFirst()) {
                    int ni = cur.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                    if (ni >= 0 && cur.getString(ni) != null) name = cur.getString(ni);
                }
            } catch (Exception ignore) { }
            finally { if (cur != null) try { cur.close(); } catch (Exception ignore) {} }
            /* 兜底名称：解析不到 DISPLAY_NAME 时按 MIME 推断扩展名，
               不能一律叫 page.jpg——否则 zip/pdf 会被错标成 jpg 无法识别格式。 */
            if (name == null || name.trim().isEmpty()) {
                String mime = "";
                try { mime = getContentResolver().getType(u); } catch (Exception ignore) { }
                name = "file." + extForMime(mime);
            }
            String id = "f" + (pickedUris.size() + 1);
            pickedUris.put(id, u);
            arr.put(new JSONObject().put("id", id).put("name", name));
        } catch (Exception e) { /* 跳过无法读取的条目 */ }
    }

    /** 把一个 content:// URI 解析出展示名失败时，按 MIME/路径推断一个带正确扩展名的兜底名 */
    private String guessName(Uri u) {
        String mime = "";
        try { mime = getContentResolver().getType(u); } catch (Exception ignore) { }
        String seg = u.getLastPathSegment();
        if (seg != null && seg.contains(".")) return seg.substring(Math.max(0, seg.lastIndexOf('/') + 1));
        return "file." + extForMime(mime);
    }

    private static String extForMime(String mime) {
        if (mime == null) return "jpg";
        switch (mime) {
            case "application/zip":
            case "application/x-zip-compressed":
            case "application/vnd.comicbook+zip":
            case "application/x-cbz": return "zip";
            case "application/vnd.rar":
            case "application/x-rar-compressed": return "rar";
            case "application/x-7z-compressed": return "7z";
            case "application/pdf":
            case "application/x-pdf": return "pdf";
            case "application/epub+zip": return "epub";
            case "text/plain": return "txt";
            case "image/png": return "png";
            case "image/webp": return "webp";
            case "image/gif": return "gif";
            case "image/jpeg": return "jpg";
            default: return "jpg";
        }
    }

    private void notifyFilesPicked(String json) {
        runOnUiThread(() -> {
            try {
                web.evaluateJavascript("window.__cvFilesPicked && window.__cvFilesPicked(JSON.parse("
                        + JSONObject.quote(json) + "))", null);
            } catch (Exception ignore) { }
        });
    }

    @Override
    protected void onPause() {
        // 把 httpOnly 会话 Cookie 刷到磁盘：进程被系统回收后重新打开仍保持登录，
        // 手机端与网页/桌面软件继续是同一个账号、同一份数据。
        CookieManager.getInstance().flush();
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        web.resumeTimers();
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) {
            web.goBack();
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastBack < 2000) {
            super.onBackPressed();
        } else {
            lastBack = now;
            Toast.makeText(this, "再按一次退出", Toast.LENGTH_SHORT).show();
        }
    }
}
