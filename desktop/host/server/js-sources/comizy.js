/**
 * Comizy.io（MangaBuddy 迁移站）· 英文漫画大站，更新快、内容多（源自 Kotatsu 的 MangaBuddyParser）。
 * Next.js SSR：列表/搜索页把书籍数据嵌在 HTML 的 JSON 片段里；详情页章节走 DOM 链接。
 * - 搜索：GET /search?q={keyword}
 * - 发现：GET /home 、/latest
 * - 详情：GET /{slug} → og:image 封面 + a[href^="/{slug}/chapter-"] 章节
 * - 章节：GET /{slug}/chapter-{n} → img[data-reader-page][src]（xN.cmzcdn.org）
 */
class Comizy extends ComicSource {
    name = "Comizy 漫画";
    key = "comizy";
    version = "1.0.0";
    minAppVersion = "1.6.0";
    url = "https://comizy.io";
    baseUrl = "https://comizy.io";
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

    async get(url) {
        const r = await Network.get(url, this.headers);
        if (!r || r.status !== 200 || !r.body) throw new Error("Comizy 请求失败：HTTP " + (r && r.status));
        return String(r.body);
    }

    /** 从 SSR HTML 内嵌 JSON 提取书籍：{displayAltName, slug, cover} */
    parseJsonCards(html) {
        const out = [], seen = new Set();
        // JSON 片段里字段顺序：..."displayAltName":"X",...,"slug":"y","cover":"z"...
        const re = /"displayAltName":"((?:\\.|[^"\\])*)"[\s\S]{0,600}?"slug":"([^"]+)","cover":"((?:\\.|[^"\\])*)"/g;
        let m;
        while ((m = re.exec(html)) !== null) {
            const title = this.decodeJson(m[1]);
            const slug = m[2];
            let cover = this.decodeJson(m[3]);
            if (!slug || seen.has(slug) || !title) continue;
            seen.add(slug);
            if (cover && !/^https?:/i.test(cover)) cover = this.abs(cover);
            out.push(new Comic({ id: slug, title, cover, tags: [] }));
        }
        // 回退：只匹配 title + slug + cover（字段名 title 而非 displayAltName）
        if (!out.length) {
            const re2 = /"title":"((?:\\.|[^"\\])*)"[\s\S]{0,600}?"slug":"([^"]+)","cover":"((?:\\.|[^"\\])*)"/g;
            while ((m = re2.exec(html)) !== null) {
                const title = this.decodeJson(m[1]);
                const slug = m[2];
                let cover = this.decodeJson(m[3]);
                if (!slug || seen.has(slug) || !title) continue;
                seen.add(slug);
                if (cover && !/^https?:/i.test(cover)) cover = this.abs(cover);
                out.push(new Comic({ id: slug, title, cover, tags: [] }));
            }
        }
        return out;
    }

    decodeJson(s) {
        return String(s == null ? "" : s)
            .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
            .replace(/\\(["\\/])/g, "$1").replace(/\\n/g, " ").replace(/&amp;/g, "&");
    }

    /** 从 DOM 卡片解析（首页最新区有时是 <a href="/slug"> + img） */
    parseDomCards(html) {
        const doc = new HtmlDocument(html);
        try {
            const out = [], seen = new Set();
            for (const a of doc.querySelectorAll('a[href]')) {
                const href = String(a.attributes.href || "");
                const m = href.match(/^\/([a-z0-9][a-z0-9-]{2,})\/?$/i); // 根路径 slug
                if (!m) continue;
                const slug = m[1];
                if (seen.has(slug) || /^(search|home|latest|about|genre|login|api|_next|static)/i.test(slug)) continue;
                const img = a.querySelector("img");
                if (!img) continue;
                let cover = String(img.attributes.src || "");
                if (!/^https?:/i.test(cover)) continue;
                if (/logo|avatar|icon/i.test(cover)) continue;
                const title = String(img.attributes.alt || "").trim() || slug.replace(/-/g, " ");
                seen.add(slug);
                out.push(new Comic({ id: slug, title, cover, tags: [] }));
            }
            return out;
        } finally { doc.dispose(); }
    }

    search = { load: async (keyword, options, page) => {
        keyword = String(keyword || "").trim();
        if (!keyword) return { comics: [], maxPage: page };
        const html = await this.get(this.baseUrl + "/search?q=" + encodeURIComponent(keyword));
        let comics = this.parseJsonCards(html);
        if (!comics.length) comics = this.parseDomCards(html);
        return { comics, maxPage: page };
    }};

    explore = [
        { title: "Comizy · 热门漫画", type: "multiPageComicList", load: async (page) => {
            const url = page > 1 ? this.baseUrl + "/latest?page=" + page : this.baseUrl + "/home";
            const html = await this.get(url);
            let comics = this.parseJsonCards(html);
            if (!comics.length) comics = this.parseDomCards(html);
            return { comics, maxPage: comics.length ? page + 1 : page };
        }}
    ];

    comic = {
        loadInfo: async (book) => {
            const slug = String(book || "").replace(/^\/+|\/+$/g, "").split("/").pop();
            const html = await this.get(this.baseUrl + "/" + slug);
            const doc = new HtmlDocument(html);
            try {
                let title = "", cover = "", description = "";
                const h1 = doc.querySelector("h1");
                if (h1) title = String(h1.text || "").trim();
                const og = doc.querySelector('meta[property="og:image"]') || doc.querySelector('meta[name="og:image"]');
                if (og && og.attributes.content) cover = this.abs(og.attributes.content);
                const ogd = doc.querySelector('meta[property="og:description"]') || doc.querySelector('meta[name="description"]');
                if (ogd) description = String(ogd.attributes?.content || "").slice(0, 500);

                const chapters = {};
                const seen = new Set();
                const links = [];
                for (const a of doc.querySelectorAll('a[href]')) {
                    const href = String(a.attributes.href || "");
                    const m = href.match(new RegExp("/" + slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/(chapter-[^/?#]+)/?$", "i"));
                    if (!m) continue;
                    const u = this.abs("/" + slug + "/" + m[1]);
                    if (seen.has(u)) continue;
                    seen.add(u);
                    let name = String(a.text || "").trim();
                    if (!name) {
                        const num = (m[1].match(/chapter-([\d.-]+)/i) || [])[1] || "";
                        name = "Chapter " + num;
                    }
                    links.push({ url: u, name });
                }
                // 按章节数字升序
                links.sort((a, b) => {
                    const na = Number((a.url.match(/chapter-([\d.]+)/i) || [])[1] || 0);
                    const nb = Number((b.url.match(/chapter-([\d.]+)/i) || [])[1] || 0);
                    return na - nb;
                });
                links.forEach((x) => { chapters[x.url] = x.name; });
                return new ComicDetails({
                    id: slug,
                    title: title || slug.replace(/-/g, " "),
                    cover, description,
                    tags: {},
                    chapters,
                    url: this.baseUrl + "/" + slug,
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
                for (const img of doc.querySelectorAll("img")) {
                    // 正文图带 data-reader-page 属性；排除头像/贴纸
                    const isPage = img.attributes["data-reader-page"] !== undefined || /cmzcdn\.org/i.test(String(img.attributes.src || ""));
                    if (!isPage) continue;
                    const src = String(img.attributes.src || img.attributes["data-src"] || "").trim();
                    if (!/^https?:\/\//i.test(src)) continue;
                    if (seen.has(src)) continue;
                    seen.add(src);
                    images.push(src);
                }
                if (!images.length) throw new Error("该章节没有解析到图片，可能已失效");
                return { images };
            } finally { doc.dispose(); }
        },
        onImageLoad: (url) => new ImageLoadingConfig({ url, headers: { "User-Agent": this.headers["User-Agent"], "Referer": this.baseUrl + "/" } }),
        onThumbnailLoad: (url) => new ImageLoadingConfig({ url, headers: { "User-Agent": this.headers["User-Agent"], "Referer": this.baseUrl + "/" } }),
    };
}
