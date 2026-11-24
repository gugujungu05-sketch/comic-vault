/**
 * 拷贝漫画 · 轻小说源（CopyManga Books / 拷贝轻小说）。
 * 与 copymanga 漫画源共用官方 App 通道与签名协议（HMAC-SHA256 + 15 项业务头），
 * 端点取自开源客户端 caolib/kira 的 lib/api/novel/novel_api.dart：
 * - 搜索：/api/v3/search/books?q=&q_type=&limit=&offset=
 * - 发现：/api/v3/books?ordering=&limit=&offset=
 * - 详情：/api/v3/book/{pathWord}
 * - 卷目录：/api/v3/book/{pathWord}/volumes
 * - 卷正文：/api/v3/book/{pathWord}/volume/{volumeId}（含 volume.txtAddr / txtEncoding）
 * 正文用服务端给的 txtAddr 全 URL 直取，按 txtEncoding 解码（多为 utf-8）。
 */
var __copyNovelQueue = globalThis.__copyNovelQueue || (globalThis.__copyNovelQueue = { last: 0, chain: Promise.resolve() });
function __copyNovelThrottle() {
    const q = globalThis.__copyNovelQueue;
    const run = async () => {
        const gap = Date.now() - q.last;
        if (gap < 800) await new Promise((r) => setTimeout(r, 800 - gap));
        q.last = Date.now();
    };
    const next = q.chain.then(run, run);
    q.chain = next.catch(() => {});
    return next;
}

class CopyNovel extends ComicSource {
    name = "拷贝轻小说";
    key = "copynovel";
    version = "1.0.0";
    minAppVersion = "1.6.0";
    url = "https://www.copy4000.com";
    baseUrl = "https://api.copy202601.com";
    mediaType = "novel";

    _secret = "M2FmMDg1OTAzMTEwMzJlZmUwNjYwNTUwYTA1NjNhNTM=";
    _umstring = "b4c89ca4104ea9a97750314d791520ac";
    _appVersion = "3.1.1";
    _versionCode = "85";

    _deviceinfo() {
        let v = this.loadData("_deviceinfo");
        if (!v) { v = `${randomInt(1000000, 9999999)}V-${randomInt(1000, 9999)}`; this.saveData("_deviceinfo", v); }
        return v;
    }
    _device() {
        let v = this.loadData("_device");
        if (!v) {
            const cA = () => String.fromCharCode(65 + randomInt(0, 25));
            const cD = () => String.fromCharCode(48 + randomInt(0, 9));
            v = cA() + cA() + cD() + cA() + "." + cD() + cD() + cD() + cD() + cD() + cD() + "." + cD() + cD() + cD();
            this.saveData("_device", v);
        }
        return v;
    }
    _pseudoid() {
        let v = this.loadData("_pseudoid");
        if (!v) {
            const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
            v = ""; for (let i = 0; i < 16; i++) v += chars.charAt(randomInt(0, chars.length - 1));
            this.saveData("_pseudoid", v);
        }
        return v;
    }

    get headers() {
        const now = new Date();
        const ts = Math.floor(now.getTime() / 1000).toString();
        const sig = Convert.hmacString(Convert.decodeBase64(this._secret), Convert.encodeUtf8(ts), "sha256");
        const shifted = new Date(now.getTime() + 8 * 3600 * 1000);
        const dt = `${shifted.getUTCFullYear()}.${String(shifted.getUTCMonth() + 1).padStart(2, "0")}.${String(shifted.getUTCDate()).padStart(2, "0")}`;
        const token = this.loadData("token");
        return {
            "User-Agent": `COPY/${this._appVersion}`,
            "source": "copyApp",
            "deviceinfo": this._deviceinfo(),
            "dt": dt,
            "platform": "3",
            "referer": `com.copymanga.app-${this._appVersion}`,
            "version": this._appVersion,
            "versioncode": this._versionCode,
            "region": "1",
            "webp": "1",
            "device": this._device(),
            "pseudoid": this._pseudoid(),
            "Accept": "application/json",
            "authorization": token ? `Token ${token}` : "Token",
            "umstring": this._umstring,
            "x-auth-timestamp": ts,
            "x-auth-signature": sig,
        };
    }

    async api(path, _retry) {
        await __copyNovelThrottle();
        const r = await Network.get(this.baseUrl + path, this.headers);
        if (!r || r.status !== 200 || !r.body) throw new Error("拷贝轻小说请求失败：HTTP " + (r && r.status));
        let j; try { j = JSON.parse(String(r.body)); } catch (e) { throw new Error("拷贝轻小说返回解析失败"); }
        if (j.code === 210) {
            const retry = _retry || 0;
            if (retry < 3) {
                let wait = 8000 + retry * 6000;
                const m = /(\d+)\s*seconds?/i.exec(String(j.message || ""));
                if (m) wait = Math.max(wait, Math.min(45000, Number(m[1]) * 1000));
                await new Promise((res) => setTimeout(res, wait));
                return this.api(path, retry + 1);
            }
            throw new Error("拷贝轻小说：访问过于频繁，请稍后再试");
        }
        if (j.code !== 200) throw new Error(j.message || "拷贝轻小说请求失败");
        return j.results;
    }

    card(c) {
        if (!c) return null;
        const pathWord = String(c.path_word || c.pathWord || "");
        if (!pathWord) return null;
        const tags = Array.isArray(c.theme) ? c.theme.map((t) => t.name).filter(Boolean) : [];
        const cover = String(c.cover || "").replace(/^http:\/\//i, "https://");
        return new Comic({ id: pathWord, title: String(c.name || c.title || ""), cover, tags,
            description: String(c.brief || c.description || "") });
    }

    search = { load: async (keyword, options, page) => {
        keyword = String(keyword || "").trim();
        if (!keyword) return { comics: [], maxPage: page };
        try {
            const d = await this.api("/api/v3/search/books?q=" + encodeURIComponent(keyword) + "&q_type=&limit=18&offset=" + ((page - 1) * 18));
            const list = (d && d.list) || [];
            const comics = list.map((c) => this.card(c)).filter(Boolean);
            return { comics, maxPage: comics.length >= 18 ? page + 1 : page };
        } catch (e) { return { comics: [], maxPage: page }; }
    }};

    explore = [{ title: "轻小说推荐", type: "multiPageComicList", load: async (page) => {
        const d = await this.api("/api/v3/books?ordering=-datetime_updated&limit=18&offset=" + ((page - 1) * 18) + "&free_type=1");
        const list = (d && d.list) || [];
        const comics = list.map((c) => this.card(c)).filter(Boolean);
        return { comics, maxPage: comics.length >= 18 ? page + 1 : page };
    }}];

    // 逐章正文 EPUB 适配器（online.js 通用分支调用）
    comic = {
        /* 拷贝轻小说 API 2026 改版：卷正文响应 {results:{book,volume:{txt_addr,txt_encoding,contents[]}}}，
           章节列表在 volume.contents（不再是 volume.chapters），正文是整卷一个 txt 文件，
           每章用 start_lines/end_lines 标记行段；编码多为 GBK。
           这里把章节 id 编码成 "起始行_结束行"，chapter 方法据此从整卷 txt 切片。 */
        textNovelCatalog: async (bookId) => {
            const det = await this.api("/api/v3/book/" + encodeURIComponent(bookId));
            const book = (det && det.book) || det || {};
            const volsRes = await this.api("/api/v3/book/" + encodeURIComponent(bookId) + "/volumes");
            const volumeList = (volsRes && (volsRes.list || volsRes.volumes)) || [];
            if (!this.__cnVolCache) this.__cnVolCache = {};
            const loadVol = async (vid) => {
                if (this.__cnVolCache[vid]) return this.__cnVolCache[vid];
                const vd = await this.api("/api/v3/book/" + encodeURIComponent(bookId) + "/volume/" + encodeURIComponent(vid));
                const vol = (vd && vd.volume) || vd || {};
                this.__cnVolCache[vid] = vol;
                return vol;
            };
            const volumes = [];
            for (const v of volumeList) {
                const vid = String(v.volume_id || v.uuid || v.id || "");
                if (!vid) continue;
                const vol = await loadVol(vid);
                const chapters = [];
                for (const c of (vol.contents || vol.chapters || [])) {
                    if (!c) continue;
                    const start = c.start_lines != null ? Number(c.start_lines) : null;
                    const end = c.end_lines != null ? Number(c.end_lines) : null;
                    // 新结构：用行段编码 id；旧结构：用章节 id
                    const id = (start != null && end != null) ? (start + "_" + end) : String(c.chapter_id || c.uuid || c.id || "");
                    if (!id) continue;
                    chapters.push({ id, title: String(c.name || c.title || "正文") });
                }
                volumes.push({ id: vid, title: String(v.title || v.name || vol.name || "卷"), chapters });
            }
            return {
                title: String(book.name || book.title || "在线小说"),
                author: (Array.isArray(book.author) && book.author.length ? String(book.author[0].name || "") : ""),
                cover: String(book.cover || "").replace(/^http:\/\//i, "https://"),
                description: String(book.brief || ""), volumes
            };
        },
        textNovelChapter: async (bookId, chapterId, volumeId) => {
            try {
                if (!this.__cnVolCache) this.__cnVolCache = {};
                let vol = this.__cnVolCache[volumeId];
                if (!vol) {
                    const vd = await this.api("/api/v3/book/" + encodeURIComponent(bookId) + "/volume/" + encodeURIComponent(volumeId));
                    vol = (vd && vd.volume) || vd || {};
                    this.__cnVolCache[volumeId] = vol;
                }
                const txtAddr = String(vol.txt_addr || vol.txtAddr || "");
                if (!/^https?:\/\//i.test(txtAddr)) return "";
                const r = await Network.get(txtAddr, { "User-Agent": "Mozilla/5.0" });
                if (!r || r.status !== 200) return "";
                // 按卷声明的编码解码（GBK/UTF-8）
                const enc = String(vol.txt_encoding || vol.txtEncoding || "utf-8").toLowerCase();
                let text = (r.bytes && /gbk|gb2312|gb18030/.test(enc)) ? Convert.decodeGbk(r.bytes) : String(r.body || "");
                // 新结构：按 start_lines/end_lines 切出本章
                const m = /^(\d+)_(\d+)$/.exec(String(chapterId));
                if (m) {
                    const start = parseInt(m[1]), end = parseInt(m[2]);
                    const lines = text.split(/\r?\n/);
                    text = lines.slice(Math.max(0, start - 1), end).join("\n");
                }
                // 正文可能是 HTML 片段，剥标签后转段落
                if (/<[a-z][\s\S]*>/i.test(text)) text = text.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "");
                const paras = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
                return paras.map((p) => "<p>" + p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + "</p>").join("");
            } catch (e) { return ""; }
        },
        loadInfo: async (book) => {
            const id = String(book == null ? "" : (book.id || book));
            const det = await this.api("/api/v3/book/" + encodeURIComponent(id));
            const bookInfo = (det && det.book) || det || {};
            if (!bookInfo.name) throw new Error("作品不存在或已下架");
            const volsRes = await this.api("/api/v3/book/" + encodeURIComponent(id) + "/volumes");
            const volumes = (volsRes && (volsRes.list || volsRes.volumes)) || [];
            const chapters = {};
            for (const v of volumes) {
                const vid = String(v.volume_id || v.uuid || v.id || "");
                if (!vid) continue;
                chapters["vol:" + vid] = String(v.title || v.name || "卷");
            }
            const tags = {};
            for (const t of (Array.isArray(bookInfo.theme) ? bookInfo.theme : [])) { const n = String(t.name || "").trim(); if (n) (tags["题材"] || (tags["题材"] = [])).push(n); }
            const author = Array.isArray(bookInfo.author) && bookInfo.author.length ? String(bookInfo.author[0].name || "") : "";
            return new ComicDetails({
                id, title: String(bookInfo.name), cover: String(bookInfo.cover || "").replace(/^http:\/\//i, "https://"),
                description: String(bookInfo.brief || ""), author, tags, chapters,
                url: "https://www.copy4000.com/book/" + id
            });
        },
        downloadBook: async (book) => ({ textNovel: true, sourceKey: "copynovel" }),
        onThumbnailLoad: () => ({ headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://api.copy202601.com/" } })
    };
}
