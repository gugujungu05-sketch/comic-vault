/**
 * MangaOwl（mangaowl.io）· 英文漫画站，更新快、内容多（Kotatsu 的 MangaowlParser 对应站）。
 * WordPress + WP-Manga 结构，服务端直出 HTML，Node fetch 可直连。
 * - 搜索：GET /?s={keyword}
 * - 发现：GET / （热门/最新区块）
 * - 详情：GET /read-1/{id}/ → h1 标题 + .summary_image img 封面 + 章节链接
 * - 章节：GET /read-1/{id}/{chapter}/ → img[src]（wp-content/uploads/WP-manga/data/...）
 */
class MangaOwl extends ComicSource {
    name = "MangaOwl 漫画";
    key = "mangaowl";
    version = "1.0.0";
    minAppVersion = "1.6.0";
    url = "https://mangaowl.io";
    baseUrl = "https://mangaowl.io";
    mediaType = "comic";
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
    };

    abs(p, origin) {
        p = String(p || "").trim();
        if (/^https?:\/\//i.test(p)) return p;
        if (p.startsWith("//")) return "https:" + p;
        return (origin || this.baseUrl) + (p.startsWith("/") ? p : "/" + p);
    }

    decode(s) {
        return String(s == null ? "" : s)
            .replace(/&#(\d+);?/g, (_, n) => String.fromCharCode(Number(n)))
            .replace(/&#x([0-9a-f]+);?/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
            .replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">").replace(/&#8217;|&rsquo;/g, "'").trim();
    }

    async get(url) {
        const r = await Network.get(url, this.headers);
        if (!r || r.status !== 200 || !r.body) throw new Error("MangaOwl 请求失败：HTTP " + (r && r.status));
        return String(r.body);
    }

    /** 卡片：a[href="/read-1/{id}/"] + img。标题常在兄弟节点 .post-title h4 a，
     *  img.alt 多为文件名，故先建立 id→标题 映射再匹配。 */
    parseCards(html) {
        const doc = new HtmlDocument(html);
        try {
            // 1) id → 真实标题（标题链接：.post-title / h2~h4 内的 a）
            const titleMap = {};
            for (const a of doc.querySelectorAll('a[href]')) {
                const href = String(a.attributes.href || "");
                const m = href.match(/\/(?:read-1|manga)\/([a-z0-9]+)\/?$/i);
                if (!m) continue;
                const text = this.decode(a.text || "").trim();
                const inTitle = /post-title|font-title|^h[1-4]$/i.test(
                    String(a.attributes.class || "") + " " + (a.parent ? String(a.parent.attributes?.class || "") : "")
                );
                if (text && text.length > 2 && !/^\d/.test(text) && (inTitle || !titleMap[m[1]])) {
                    if (!titleMap[m[1]] || inTitle) titleMap[m[1]] = text;
                }
            }
            // 2) 图片卡片：封面来自 a>img，标题优先用映射
            const out = [], seen = new Set();
            for (const a of doc.querySelectorAll('a[href]')) {
                const href = String(a.attributes.href || "");
                const m = href.match(/\/(?:read-1|manga)\/([a-z0-9]+)\/?$/i);
                if (!m) continue;
                const id = m[1];
                if (seen.has(id)) continue;
                const img = a.querySelector("img");
                if (!img) continue;
                let cover = String(img.attributes["data-src"] || img.attributes.src || "").trim();
                if (!/^https?:/i.test(cover)) cover = this.abs(cover);
                if (/logo/i.test(cover)) continue;
                let title = titleMap[id] || "";
                if (!title) {
                    const alt = this.decode(img.attributes.alt || "");
                    // 跳过纯文件名 alt（如 "1-10-193×278-1"）
                    if (alt && !/^\d+[-x×]/.test(alt) && !/\d+x\d+/i.test(alt) && !/\.(jpg|png|webp)$/i.test(alt)) title = alt;
                }
                if (!title) title = id;
                seen.add(id);
                out.push(new Comic({ id, title, cover, tags: [] }));
            }
            return out;
        } finally { doc.dispose(); }
    }

    search = { load: async (keyword, options, page) => {
        keyword = String(keyword || "").trim();
        if (!keyword) return { comics: [], maxPage: page };
        const html = await this.get(this.baseUrl + "/?s=" + encodeURIComponent(keyword));
        const comics = this.parseCards(html);
        return { comics, maxPage: page };
    }};

    explore = [
        { title: "MangaOwl · 热门漫画", type: "multiPageComicList", load: async (page) => {
            const url = page > 1 ? this.baseUrl + "/page/" + page + "/" : this.baseUrl + "/";
            let html;
            try { html = await this.get(url); }
            catch (e) { html = await this.get(this.baseUrl + "/"); }
            const comics = this.parseCards(html);
            return { comics, maxPage: comics.length ? page + 1 : page };
        }}
    ];

    comic = {
        loadInfo: async (book) => {
            const id = String(book || "").replace(/^\/+|\/+$/g, "").split("/").pop();
            const html = await this.get(this.baseUrl + "/read-1/" + id + "/");
            const doc = new HtmlDocument(html);
            try {
                let title = "", cover = "", description = "";
                const h1 = doc.querySelector("h1");
                if (h1) title = this.decode(h1.text);
                const sumImg = doc.querySelector(".summary_image img") || doc.querySelector(".summary-image img");
                if (sumImg) cover = this.abs(String(sumImg.attributes["data-src"] || sumImg.attributes.src || ""));
                // 兜底：任意 uploads 非 logo 大图
                if (!cover || /logo/i.test(cover)) {
                    for (const img of doc.querySelectorAll("img[src]")) {
                        const s = String(img.attributes.src || "").trim();
                        if (/wp-content\/uploads/i.test(s) && !/logo/i.test(s)) { cover = this.abs(s); break; }
                    }
                }
                const desc = doc.querySelector(".summary-content") || doc.querySelector(".description");
                if (desc) description = this.decode(desc.text).slice(0, 500);

                const chapters = {};
                const seen = new Set();
                const links = [];
                for (const a of doc.querySelectorAll('a[href]')) {
                    const href = String(a.attributes.href || "");
                    const m = href.match(new RegExp("/read-1/" + id + "/([^/?#]+)/?$", "i"));
                    if (!m) continue;
                    const u = this.abs("/read-1/" + id + "/" + m[1]);
                    if (seen.has(u)) continue;
                    seen.add(u);
                    let name = this.decode(a.text || "").trim();
                    if (!name) {
                        const num = (m[1].match(/chapter-([\d.]+)/i) || [])[1] || "";
                        name = "Chapter " + num;
                    }
                    links.push({ url: u, name });
                }
                links.sort((a, b) => {
                    const na = Number((a.url.match(/chapter-([\d.]+)/i) || [])[1] || 0);
                    const nb = Number((b.url.match(/chapter-([\d.]+)/i) || [])[1] || 0);
                    return na - nb;
                });
                links.forEach((x) => { chapters[x.url] = x.name; });
                return new ComicDetails({
                    id,
                    title: title || id,
                    cover, description,
                    tags: {},
                    chapters,
                    url: this.baseUrl + "/read-1/" + id + "/",
                });
            } finally { doc.dispose(); }
        },
        loadEp: async (book, chapterPath) => {
            const url = this.abs(String(chapterPath || ""), this.baseUrl);
            const html = await this.get(url);
            const doc = new HtmlDocument(html);
            try {
                const images = [];
                const seen = new Set();
                for (const img of doc.querySelectorAll("img[src]")) {
                    const src = String(img.attributes.src || "").trim();
                    if (!/wp-content\/uploads\/WP-manga\/data\//i.test(src)) continue;
                    if (seen.has(src)) continue;
                    seen.add(src);
                    images.push(this.abs(src));
                }
                images.sort((a, b) => {
                    const na = Number((a.match(/(\d+)\.(?:jpg|png|webp)/i) || [])[1] || 0);
                    const nb = Number((b.match(/(\d+)\.(?:jpg|png|webp)/i) || [])[1] || 0);
                    return na - nb;
                });
                if (!images.length) throw new Error("该章节没有解析到图片，可能已失效");
                return { images };
            } finally { doc.dispose(); }
        },
        onImageLoad: (url) => new ImageLoadingConfig({ url, headers: { "User-Agent": this.headers["User-Agent"], "Referer": this.baseUrl + "/" } }),
        onThumbnailLoad: (url) => new ImageLoadingConfig({ url, headers: { "User-Agent": this.headers["User-Agent"], "Referer": this.baseUrl + "/" } }),
    };
}
