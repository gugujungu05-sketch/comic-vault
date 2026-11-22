/**
 * Rawkuma 生肉漫画源（rawkuma.net / rawkuma.com，同一站点两套域名）。
 * 纯 HTTP + HTML 解析，无动态代码执行。
 * - 搜索：net 站用 WordPress AJAX（nonce 从首页动态获取），失败回退 WP 的 ?s= 搜索
 * - 发现/详情/阅读：net 站 DOM 结构稳定，图片在 cdn.rawkuma.com
 */
class Rawkuma extends ComicSource {
    name = "Rawkuma生肉";
    key = "rawkuma";
    version = "1.0.0";
    minAppVersion = "1.6.0";
    url = "https://rawkuma.net";
    baseUrl = "https://rawkuma.net";
    altBase = "https://rawkuma.com";
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Referer": "https://rawkuma.net/"
    };

    abs(path, origin = this.baseUrl) {
        path = String(path || "").trim();
        if (/^https?:\/\//i.test(path)) return path;
        if (path.startsWith("//")) return "https:" + path;
        return origin + (path.startsWith("/") ? path : "/" + path);
    }

    decode(s) {
        return String(s == null ? "" : s)
            .replace(/&#(\d+);?/g, (_, n) => String.fromCharCode(Number(n)))
            .replace(/&#x([0-9a-f]+);?/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
            .replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">").replace(/&#8211;|&ndash;/g, "-").replace(/&#8217;|&rsquo;/g, "'")
            .replace(/&middot;/g, "·").trim();
    }

    /** 从 URL 里取漫画 slug：/manga/{slug}/ 或 /manga/{slug}/chapter-x/ */
    slugOf(value) {
        const m = String(value || "").match(/\/manga\/([^/]+)/);
        return m ? decodeURIComponent(m[1]) : String(value || "").replace(/^\/+|\/+$/g, "");
    }

    async get(url, headers) {
        const r = await Network.get(url, headers || this.headers);
        if (!r || r.status !== 200 || !r.body) throw new Error("Rawkuma 请求失败：HTTP " + (r && r.status));
        return String(r.body);
    }

    /** 首页 nonce（AJAX 搜索需要），带短缓存 */
    async nonce() {
        const cached = this.loadData("nonce");
        if (cached && Date.now() - (cached.at || 0) < 20 * 60 * 1000) return cached.v;
        const html = await this.get(this.baseUrl + "/");
        const m = html.match(/nonce=([0-9a-f]+)/i) || html.match(/nonce["':=]+["']?([0-9a-f]{8,})/i);
        const v = m ? m[1] : "";
        if (v) this.saveData("nonce", { v, at: Date.now() });
        return v;
    }

    /** 把搜索/卡片 HTML 里的 manga 链接解析成书卡片 */
    parseCards(html) {
        const doc = new HtmlDocument(html);
        try {
            const out = [], seen = new Set();
            for (const a of doc.querySelectorAll('a[href]')) {
                const href = String(a.attributes.href || "");
                const m = href.match(/^https?:\/\/(?:www\.)?rawkuma\.(?:net|com)\/manga\/([^/]+)\/?$/i);
                if (!m) continue;
                const id = this.slugOf(href);
                if (seen.has(id)) continue;
                // 跳过非卡片导航链接：卡片里应含 img 或 h2/h3 标题
                let cover = "", title = "";
                const img = a.querySelector("img");
                if (img) cover = this.abs(img.attributes["data-src"] || img.attributes.src || "", this.baseUrl);
                const heading = a.querySelector("h2,h3,.title");
                title = this.decode(heading ? heading.text : (img ? img.attributes.alt : ""));
                if (!title) title = id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
                if (!img && !heading) continue;
                seen.add(id);
                out.push(new Comic({ id, title, cover, tags: [] }));
            }
            return out;
        } finally { doc.dispose(); }
    }

    search = { load: async (keyword, options, page) => {
        keyword = String(keyword || "").trim();
        if (!keyword) return { comics: [], maxPage: page };
        let html = "";
        try {
            const nonce = await this.nonce();
            const postHeaders = Object.assign({}, this.headers, { "Content-Type": "application/x-www-form-urlencoded" });
            const r = await Network.post(this.baseUrl + "/wp-admin/admin-ajax.php?nonce=" + nonce + "&action=search",
                postHeaders, "search_term=" + encodeURIComponent(keyword));
            if (r && r.status === 200 && r.body) html = String(r.body);
        } catch (e) { /* 回退 */ }
        let comics = html ? this.parseCards(html) : [];
        // 回退：WordPress 默认搜索页
        if (!comics.length) {
            try {
                const r = await Network.get(this.altBase + "/?s=" + encodeURIComponent(keyword), this.headers);
                if (r && r.status === 200) comics = this.parseCards(String(r.body || ""));
            } catch (e) { /* 忽略 */ }
        }
        return { comics, maxPage: page };
    }};

    explore = [
        { title: "最新漫画", type: "multiPageComicList", load: async (page) => {
            const html = await this.get(this.baseUrl + "/");
            const comics = this.parseCards(html);
            return { comics, maxPage: comics.length ? null : page };
        }}
    ];

    category = {
        title: "Rawkuma 分类",
        parts: [{
            name: "类型",
            type: "fixed",
            categories: ["Action", "Adventure", "Comedy", "Drama", "Fantasy", "Horror", "Mystery", "Romance", "Sci-Fi", "Shounen", "Shoujo", "Slice of Life", "Sports", "Supernatural"],
            itemType: "category",
            categoryParams: ["action", "adventure", "comedy", "drama", "fantasy", "horror", "mystery", "romance", "sci-fi", "shounen", "shoujo", "slice-of-life", "sports", "supernatural"]
        }],
        enableRankingPage: false
    };

    categoryComics = { load: async (category, param, options, page) => {
        // rawkuma 类型走 /manga-genre/{slug}/page/{n}/（若不可用则回退首页）
        const url = this.baseUrl + "/manga-genre/" + encodeURIComponent(String(param || "")) +
            (page > 1 ? "/page/" + page + "/" : "/");
        try {
            const html = await this.get(url);
            const comics = this.parseCards(html);
            return { comics, maxPage: comics.length >= 10 ? page + 1 : page };
        } catch (e) {
            const comics = this.parseCards(await this.get(this.baseUrl + "/"));
            return { comics, maxPage: page };
        }
    }};

    /** 详情页：抓标题、封面、简介、章节列表 */
    parseDetail(html, book) {
        const doc = new HtmlDocument(html);
        try {
            const chapters = {};
            const seen = new Set();
            for (const a of doc.querySelectorAll('a[href]')) {
                const href = String(a.attributes.href || "");
                const m = href.match(/\/manga\/[^/]+\/(chapter-[^/?]+)\/?/i);
                if (!m) continue;
                const chUrl = this.abs(href, this.baseUrl);
                if (seen.has(chUrl)) continue;
                seen.add(chUrl);
                // 章节标题只取话数整数，去掉 .内部ID 后缀（如 chapter-1.429315 → Chapter 1）
                const num = (m[1].match(/chapter-(\d+)/) || [])[1] || "";
                chapters[chUrl] = "Chapter " + num;
            }
            // 封面：优先 og:image / 详情主图，排除站点 Logo
            let cover = "";
            for (const img of doc.querySelectorAll('img[src]')) {
                const s = String(img.attributes.src || "");
                if (!/wp-content\/uploads/i.test(s) || /logo/i.test(s)) continue;
                cover = this.abs(s, this.baseUrl);
                break;
            }
            const slug = this.slugOf(book);
            return new ComicDetails({
                title: this.decode(book && book.title) || slug.replace(/-/g, " "),
                cover,
                description: "",
                tags: {},
                chapters,
                url: this.baseUrl + "/manga/" + slug + "/"
            });
        } finally { doc.dispose(); }
    }

    comic = {
        loadInfo: async (book) => {
            const slug = this.slugOf(book);
            const html = await this.get(this.baseUrl + "/manga/" + slug + "/");
            return this.parseDetail(html, book);
        },
        loadEp: async (book, chapterPath) => {
            const url = this.abs(String(chapterPath || ""), this.baseUrl);
            const html = await this.get(url);
            const doc = new HtmlDocument(html);
            try {
                const images = [];
                const seen = new Set();
                for (const img of doc.querySelectorAll('img[src]')) {
                    let src = String(img.attributes.src || "").trim();
                    const real = img.attributes["data-src"] || img.attributes["data-lazy-src"] || src;
                    src = String(real || "").trim();
                    if (!/cdn\.rawkuma\.com|wp-content\/uploads/i.test(src)) continue;
                    if (/logo|\.svg/i.test(src)) continue;
                    src = this.abs(src, this.baseUrl);
                    if (seen.has(src)) continue;
                    seen.add(src);
                    images.push(src);
                }
                if (!images.length) throw new Error("该章节没有解析到图片，可能已失效");
                // 按页码自然排序，避免 DOM 顺序错乱
                images.sort((a, b) => {
                    const na = Number((a.match(/(\d+)\.(?:jpg|png|webp)/i) || [])[1] || 0);
                    const nb = Number((b.match(/(\d+)\.(?:jpg|png|webp)/i) || [])[1] || 0);
                    return na - nb;
                });
                return images;
            } finally { doc.dispose(); }
        },
        onImageLoad: () => ({ headers: { "User-Agent": this.headers["User-Agent"], "Referer": "https://rawkuma.net/" } }),
        onThumbnailLoad: () => ({ headers: { "User-Agent": this.headers["User-Agent"], "Referer": "https://rawkuma.net/" } })
    };
}
