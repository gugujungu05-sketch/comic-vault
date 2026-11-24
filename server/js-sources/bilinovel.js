/** 哔哩轻小说（linovelib）源 —— 基于 lnovel 开放 API（lnovel.animes.garden）。
 *  lnovel 把哔哩轻小说/轻小说文库抓取后提供 JSON API：
 *  - 榜单发现：GET /api/bili/top/{weekvisit|monthvisit|weekrecommend|...}
 *  - 详情：GET /api/bili/novel/{nid}
 *  - 卷/章节列表：GET /api/bili/novel/{nid}/vol/{vid}
 *  - 章节正文：GET /api/bili/novel/{nid}/chapter/{cid}
 *  小说整本导入：本项目后端会识别 textNovel 标志，逐章抓正文生成 EPUB 入库。 */
class BiliNovel extends ComicSource {
    name = "哔哩轻小说";
    key = "bilinovel";
    version = "1.0.0";
    mediaType = "novel";
    baseUrl = "https://lnovel.animes.garden";
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/139.0.0.0 Safari/537.36",
        "Accept": "application/json"
    };
    textNovel = true; // 后端据此走「逐章正文 → EPUB」整本导入通道

    async getJson(path) {
        const r = await Network.get(this.baseUrl + path, this.headers);
        if (!r || r.status !== 200 || !r.body) throw new Error("哔哩轻小说请求失败：HTTP " + (r && r.status));
        const j = JSON.parse(r.body);
        if (j && j.ok === false) throw new Error(j.message || "哔哩轻小说接口错误");
        return j;
    }

    stripHtml(s) {
        return String(s || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
    }

    bookOf(it) {
        return {
            id: String(it.nid || it.id || ""),
            title: String(it.title || it.name || "").trim(),
            cover: String(it.cover || ""),
            author: String(it.author || (Array.isArray(it.authors) ? (it.authors[0]?.name || "") : "") || ""),
            description: this.stripHtml(it.description || ""),
            tags: Array.isArray(it.labels) ? it.labels : (Array.isArray(it.tags) ? it.tags : []),
            latestChapter: it.latestChapter || null,
            kind: "novel",
            mediaType: "novel",
        };
    }

    search = { load: async (keyword) => {
        const kw = String(keyword || "").trim();
        if (!kw) return { comics: [], maxPage: 1 };
        // lnovel 没有独立 search 端点：用榜单合集做关键词过滤（覆盖热门书）。
        // 并发拉取所有榜单，避免串行累加导致搜索超时/极慢（原实现 5 个榜单串行，
        // 单个 1~4s 累加超过 10s，偶发卡住直接 40s 超时）。
        const buckets = ["weekvisit", "monthvisit", "weekrecommend", "monthrecommend", "new"];
        const results = await Promise.all(buckets.map(async (b) => {
            try { return ((await this.getJson("/api/bili/top/" + b))?.data?.items) || []; }
            catch { return []; } // 单个榜单失败不影响其它
        }));
        const seen = new Set();
        const out = [];
        for (const items of results) {
            for (const it of items) {
                const book = this.bookOf(it);
                if (seen.has(book.id)) continue;
                seen.add(book.id);
                if (book.title.toLowerCase().includes(kw.toLowerCase()) || book.author.toLowerCase().includes(kw.toLowerCase())) out.push(book);
            }
        }
        return { comics: out, maxPage: 1 };
    } };

    explore = [
        { title: "周点击榜", type: "multiPageComicList", load: async () => {
            const j = await this.getJson("/api/bili/top/weekvisit");
            return { comics: ((j?.data?.items) || []).map((it) => this.bookOf(it)), maxPage: 1 };
        }},
        { title: "月点击榜", type: "multiPageComicList", load: async () => {
            const j = await this.getJson("/api/bili/top/monthvisit");
            return { comics: ((j?.data?.items) || []).map((it) => this.bookOf(it)), maxPage: 1 };
        }},
        { title: "周推荐榜", type: "multiPageComicList", load: async () => {
            const j = await this.getJson("/api/bili/top/weekrecommend");
            return { comics: ((j?.data?.items) || []).map((it) => this.bookOf(it)), maxPage: 1 };
        }},
        { title: "最新更新", type: "multiPageComicList", load: async () => {
            const j = await this.getJson("/api/bili/top/new");
            return { comics: ((j?.data?.items) || []).map((it) => this.bookOf(it)), maxPage: 1 };
        }},
    ];

    comic = {
        loadInfo: async (nid) => {
            const j = await this.getJson("/api/bili/novel/" + encodeURIComponent(nid));
            const d = j.data || {};
            const book = this.bookOf({ nid: d.nid, name: d.name, authors: d.authors, description: d.description, cover: d.cover, labels: d.labels });
            return {
                ...book,
                url: this.baseUrl + "/bili/novel/" + nid,
                chapters: null, // 整本导入：后端按 textNovel 逐章抓正文生成 EPUB
            };
        },
        /** 整本导入：返回 nid，后端据此逐章抓正文（见 online.js 的 textNovel 分支） */
        downloadBook: async (nid) => {
            return {
                textNovel: true,
                sourceKey: "bilinovel",
                bookId: String(nid),
                filename: String(nid) + ".epub",
                headers: { "User-Agent": this.headers["User-Agent"] },
            };
        },
        onImageLoad: () => ({ headers: { "User-Agent": this.headers["User-Agent"] } }),
        onThumbnailLoad: () => ({ headers: { "User-Agent": this.headers["User-Agent"] } }),
    };
}
