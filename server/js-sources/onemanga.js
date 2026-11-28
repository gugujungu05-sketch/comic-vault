/**
 * 1Manga.co（1manga.co）· 英文漫画聚合站，日本漫画为主，内容量大、更新快。
 * 从 EverythingMoe 目录（用户书签里那类导航站）发现的优质站，实测 2026-11 直连可用。
 * - 搜索：GET /search?q=关键词 → /manga/{slug} 卡片
 * - 发现：GET /new、/popular
 * - 详情：GET /manga/{slug} → 封面/作者/标签 + /chapter/{slug}/chapter-N 章节
 * - 章节图片：GET /chapter/{slug}/chapter-N → imgx.mghcdn.com/{slug}/{N}/{page}.jpg
 */
class OneManga extends ComicSource {
    name = "1Manga 漫画";
    key = "onemanga";
    version = "1.0.0";
    minAppVersion = "1.6.0";
    url = "https://1manga.co";
    baseUrl = "https://1manga.co";
    mediaType = "comic";
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9"
    };

    async get(url) {
        const r = await Network.get(url, this.headers);
        if (!r || r.status !== 200 || !r.body) throw new Error("1Manga 请求失败：HTTP " + (r && r.status));
        return String(r.body);
    }

    decode(s) {
        return String(s == null ? "" : s)
            .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
            .replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCharCode(parseInt(x, 16)))
            .replace(/&(amp|quot|lt|gt|nbsp|apos);/gi, (_, e) => ({ amp: "&", quot: '"', lt: "<", gt: ">", nbsp: " ", apos: "'" })[e.toLowerCase()] || _)
            .replace(/\s+/g, " ").trim();
    }

    abs(u) {
        if (!u) return "";
        u = String(u).replace(/&amp;/g, "&");
        if (/^\/\//.test(u)) return "https:" + u;
        if (/^\//.test(u)) return this.baseUrl + u;
        if (/^https?:\/\//i.test(u)) return u;
        return this.baseUrl + "/" + u;
    }

    /** 解析 /manga/{slug} 卡片 */
    parseCards(html) {
        const out = [];
        const seen = new Set();
        for (const m of String(html || "").matchAll(/href="([^"]*\/manga\/([a-z0-9-_]+))"/gi)) {
            const href = this.decode(m[1]);
            const slug = this.decode(m[2]);
            if (!slug || seen.has(slug)) continue;
            seen.add(slug);
            // 卡片区域：从该链接向前/向后截取一段找标题与封面
            const start = m.index;
            const chunk = String(html).slice(Math.max(0, start - 300), start + 900);
            let cover = "";
            const im = chunk.match(/<img[^>]+(?:data-src|data-original|src)="([^"]*(?:thumb\.mghcdn|manga)[^"]*\.(?:jpg|jpeg|png|webp))"/i)
                || chunk.match(/<img[^>]+(?:data-src|src)="([^"]+\.(?:jpg|jpeg|png|webp))"/i);
            if (im) cover = this.abs(im[1]);
            let title = "";
            const tm = chunk.match(/(?:alt|title)="([^"]{3,120})"/i);
            if (tm) title = this.decode(tm[1]);
            if (!title || /^(cover|logo|manga|image|thumbnail)$/i.test(title)) {
                title = slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
            }
            out.push(new Comic({ id: slug, title, cover, tags: [] }));
        }
        return out;
    }

    search = { load: async (keyword, _options, page) => {
        const kw = String(keyword || "").trim();
        if (!kw) return { comics: [], maxPage: page };
        try {
            const url = this.baseUrl + "/search?q=" + encodeURIComponent(kw);
            return { comics: this.parseCards(await this.get(url)), maxPage: page };
        } catch { return { comics: [], maxPage: page }; }
    }};

    explore = [
        { title: "1Manga · 最新上架", type: "multiPageComicList", load: async (page) => {
            try {
                const u = page > 1 ? this.baseUrl + "/new?page=" + page : this.baseUrl + "/new";
                return { comics: this.parseCards(await this.get(u)), maxPage: page + 1 };
            } catch { return { comics: [], maxPage: page }; }
        }},
        { title: "1Manga · 人气榜", type: "multiPageComicList", load: async (page) => {
            try {
                const u = page > 1 ? this.baseUrl + "/popular?page=" + page : this.baseUrl + "/popular";
                return { comics: this.parseCards(await this.get(u)), maxPage: page + 1 };
            } catch { return { comics: [], maxPage: page }; }
        }},
    ];

    comic = {
        loadInfo: async (book) => {
            const slug = String(book == null ? "" : (book.id || book));
            if (!slug) throw new Error("缺少书籍 ID");
            const detailUrl = this.baseUrl + "/manga/" + encodeURIComponent(slug);
            const html = await this.get(detailUrl);

            let title = "";
            const tm = html.match(/<h1[^>]*>([\s\S]{2,160}?)<\/h1>/i);
            if (tm) title = this.decode(String(tm[1]).replace(/<[^>]+>/g, ""));
            if (!title) title = slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

            let cover = "";
            const cm = html.match(/<img[^>]+(?:data-src|src)="([^"]*thumb\.mghcdn[^"]+)"/i);
            if (cm) cover = this.abs(cm[1]);

            let author = "";
            const am = html.match(/(?:Author|Artist)[\s\S]{0,200}?<a[^>]*>([^<]+)<\/a>/i);
            if (am) author = this.decode(am[1]);

            let description = "";
            const dm = html.match(/<div[^>]*class="[^"]*(?:summary|description)[^"]*"[^>]*>([\s\S]{20,1600}?)<\/div>/i);
            if (dm) description = this.decode(String(dm[1]).replace(/<[^>]+>/g, " "));

            const tags = [];
            for (const m of html.matchAll(/href="[^"]*\/(?:genre|category|tag)\/[^"]*"[^>]*>([^<]{2,40})</gi)) {
                const v = this.decode(m[1]);
                if (v && tags.indexOf(v) < 0) tags.push(v);
            }

            // 章节：/chapter/{slug}/chapter-N ，按话数升序
            const chapters = {};
            const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const re = new RegExp('href="([^"]*\\/chapter\\/' + esc + '\\/chapter-[^"?#]+)"[^>]*>([\\s\\S]{0,200}?)<\\/a>', "gi");
            for (const m of html.matchAll(re)) {
                const href = this.decode(m[1]);
                const epId = (href.match(/(chapter-[^/?#]+)$/i) || [])[1] || href;
                const label = this.decode(String(m[2]).replace(/<[^>]+>/g, " "));
                if (!chapters[epId]) chapters[epId] = label || epId.replace(/chapter-/, "Chapter ");
            }
            if (!Object.keys(chapters).length) {
                for (const m of html.matchAll(new RegExp('\\/chapter\\/' + esc + '\\/(chapter-[\\w.]+)', "gi"))) {
                    if (!chapters[m[1]]) chapters[m[1]] = m[1].replace(/chapter-/, "Chapter ");
                }
            }
            if (!Object.keys(chapters).length) throw new Error("没有找到章节");

            return new ComicDetails({
                id: slug, title, cover, author, description,
                tags: tags.length ? { "题材": tags } : {},
                chapters, url: detailUrl
            });
        },
        loadEp: async (comicId, epId) => {
            const slug = String(comicId == null ? "" : (comicId.id || comicId));
            const ep = String(epId || "").replace(/^\//, "");
            const url = this.baseUrl + "/chapter/" + encodeURIComponent(slug) + "/" + encodeURIComponent(ep);
            const html = await this.get(url);
            const imgs = [];
            for (const m of html.matchAll(/(?:data-src|data-original|src)="([^"]*imgx\.mghcdn[^"]+\.(?:jpg|jpeg|png|webp))"/gi)) {
                let u = this.abs(m[1]);
                if (!imgs.includes(u)) imgs.push(u);
            }
            // 兜底：任意 mghcdn 正文图
            if (!imgs.length) {
                for (const m of html.matchAll(/(https?:\/\/imgx?\.mghcdn\.com[^"'\s]+\.(?:jpg|jpeg|png|webp))/gi)) {
                    const u = this.abs(m[1]);
                    if (!imgs.includes(u)) imgs.push(u);
                }
            }
            if (!imgs.length) throw new Error("这一话没有解析到正文图片");
            imgs.sort((a, b) => {
                const na = Number((a.match(/\/(\d+)\.(?:jpg|jpeg|png|webp)/i) || [])[1] || 0);
                const nb = Number((b.match(/\/(\d+)\.(?:jpg|jpeg|png|webp)/i) || [])[1] || 0);
                return na - nb;
            });
            return { images: imgs };
        },
        onImageLoad: (url) => ({ headers: { "Referer": this.baseUrl + "/", "User-Agent": this.headers["User-Agent"] } }),
        onThumbnailLoad: (url) => ({ headers: { "Referer": this.baseUrl + "/", "User-Agent": this.headers["User-Agent"] } })
    };
}
