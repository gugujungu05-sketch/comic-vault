/** 轻小说文库（公开文库 API）。
 *  从 Ciallo-Reader 的 Wenku8LibrarySource.kt 直接移植：
 *  - 搜索：GET /api/books?q={kw}&page=1&limit=24
 *  - 详情：GET /api/books/{id}
 *  - 整本下载：GET /api/books/{id}/download（EPUB，含插图，Referer 必须带站点根）
 *  小说整本以 EPUB 下载后交给书库的 EPUB 分章流程入库。 */
class Wenku8Library extends ComicSource {
    name = "轻小说文库";
    key = "wenku8";
    version = "1.0.0";
    mediaType = "novel";
    baseUrl = "https://wenku8.ywy.moe";
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
        "Accept": "application/json"
    };
    referer() { return this.baseUrl + "/"; }

    abs(raw) {
        const value = String(raw || "").trim();
        if (!value) return "";
        if (/^https?:\/\//.test(value)) return value;
        return this.baseUrl + (value.startsWith("/") ? value : "/" + value);
    }

    checkId(id) {
        if (!/^[1-9][0-9]{0,8}$/.test(String(id || ""))) throw new Error("无效的文库书籍标识");
        return String(id);
    }

    stripHtml(text) {
        return String(text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }

    bookOf(data) {
        const id = this.checkId(data.id);
        const title = String(data.title || "").trim();
        if (!title) throw new Error("文库书名为空");
        const tags = Array.isArray(data.tags) ? data.tags.filter(Boolean) : [];
        return {
            id,
            title,
            cover: this.abs(data.coverUrl || ""),
            author: String(data.author || "").trim(),
            description: this.stripHtml(data.synopsis),
            tags,
            kind: "novel",
            mediaType: "novel",
        };
    }

    async getJson(url) {
        const res = await Network.get(url, { ...this.headers, "Referer": this.referer() });
        if (res.status !== 200) throw new Error("中文文库返回 HTTP " + res.status);
        return JSON.parse(res.body);
    }

    async detail(id) {
        return this.getJson(this.baseUrl + "/api/books/" + this.checkId(id));
    }

    search = { load: async (keyword) => {
        const kw = String(keyword || "").trim();
        if (!kw) return { comics: [], maxPage: 1 };
        const j = await this.getJson(this.baseUrl + "/api/books?q=" + encodeURIComponent(kw) + "&page=1&limit=24");
        const items = Array.isArray(j.items) ? j.items : [];
        return { comics: items.map((it) => this.bookOf(it)), maxPage: 1 };
    } };

    explore = [
        {title: "全部小说", type: "multiPageComicList", load: async (page) => {
            const j = await this.getJson(this.baseUrl + "/api/books?page=" + Math.max(1, Number(page) || 1) + "&limit=60");
            const items = Array.isArray(j.items) ? j.items : [];
            return {comics: items.map((it) => this.bookOf(it)), maxPage: Math.max(1, Number(j.pages) || Number(page) || 1)};
        }},
        {title: "最近更新", type: "multiPageComicList", load: async (page) => {
            const j = await this.getJson(this.baseUrl + "/api/books?page=" + Math.max(1, Number(page) || 1) + "&limit=60");
            const items = Array.isArray(j.items) ? j.items : [];
            const sorted = items.slice().sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")) || (b.id - a.id));
            return {comics: sorted.map((it) => this.bookOf(it)), maxPage: Math.max(1, Number(j.pages) || Number(page) || 1)};
        }},
    ];

    comic = {
        loadInfo: async (id) => {
            const b = this.bookOf(await this.detail(id));
            return {
                ...b,
                url: this.baseUrl + "/books/" + b.id,
                chapters: null,   // 小说整本下载：EPUB 交给书库自动分章
            };
        },
        /** 整本 EPUB 下载信息：服务端据此下载并走 EPUB 分章入库 */
        downloadBook: async (id) => {
            const b = this.bookOf(await this.detail(id));
            return {
                url: this.baseUrl + "/api/books/" + this.checkId(id) + "/download",
                filename: b.title.replace(/[\\/:*?"<>|]/g, "_") + ".epub",
                headers: { "User-Agent": this.headers["User-Agent"], "Referer": this.referer() },
            };
        },
        onImageLoad: () => ({ headers: { "User-Agent": this.headers["User-Agent"], "Referer": this.referer() } }),
        onThumbnailLoad: () => ({ headers: { "User-Agent": this.headers["User-Agent"], "Referer": this.referer() } }),
    };
}
