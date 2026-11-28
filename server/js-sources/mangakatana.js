/**
 * MangaKatana（mangakatana.com）· 英文漫画站，日文原版+英译量大、更新快、无需登录。
 * 用户书签里的站点，实测 2026-11 可直连、无 Cloudflare 挑战。
 * - 搜索：GET /?search=关键词 → .item 卡片（含封面/章节数）
 * - 发现：GET /hot-manga /new-manga /manga-list/... 等
 * - 详情：GET /manga/{slug}.{id} → 封面/作者/标签/全部章节链接
 * - 章节图片：GET /manga/{slug}.{id}/cN → 页面内嵌 https://iN.mangakatana.com/token/.../N.jpg
 */
class MangaKatana extends ComicSource {
    name = "MangaKatana 漫画";
    key = "mangakatana";
    version = "1.0.0";
    minAppVersion = "1.6.0";
    url = "https://mangakatana.com";
    baseUrl = "https://mangakatana.com";
    mediaType = "comic";
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9"
    };

    async get(url) {
        const r = await Network.get(url, this.headers);
        if (!r || r.status !== 200 || !r.body) throw new Error("MangaKatana 请求失败：HTTP " + (r && r.status));
        return String(r.body);
    }

    decode(s) {
        return String(s == null ? "" : s)
            .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
            .replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCharCode(parseInt(x, 16)))
            .replace(/&(amp|quot|lt|gt|nbsp|apos|#39);/gi, (_, e) => ({ amp: "&", quot: '"', lt: "<", gt: ">", nbsp: " ", apos: "'", "#39": "'" })[e.toLowerCase()] || _)
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

    /** 解析搜索/发现页的 .item 卡片 */
    parseCards(html) {
        const out = [];
        const seen = new Set();
        // 每个条目形如 <div class="item"> ... <a href="/manga/xxx.123"> ... <img src=...>
        const chunks = String(html || "").split(/<div[^>]*class="[^"]*\bitem\b[^"]*"[^>]*>/i).slice(1);
        for (const chunk of chunks) {
            const hm = chunk.match(/href="([^"]*\/manga\/[^"]+)"/i);
            if (!hm) continue;
            let href = this.decode(hm[1]);
            const idm = href.match(/\/manga\/([^/?#]+)/i);
            if (!idm) continue;
            const id = this.decode(idm[1]);
            if (seen.has(id)) continue;
            seen.add(id);
            // 标题：优先 <h3 class="title"><a ...>标题</a>，其次 a 的 title 属性；img alt 是 "[Cover]" 不能用
            let title = "";
            const tm = chunk.match(/<h3[^>]*class="[^"]*title[^"]*"[^>]*>[\s\S]{0,200}?<a[^>]*>([\s\S]{2,150}?)<\/a>/i)
                || chunk.match(/<a[^>]+href="[^"]*\/manga\/[^"]*"[^>]*title="([^"]+)"/i)
                || chunk.match(/>\s*([^<>]{3,150})\s*<\/h3>/i);
            if (tm) title = this.decode(String(tm[1]).replace(/<[^>]+>/g, ""));
            if (!title) title = id.replace(/\.\d+$/, "").replace(/[-_]/g, " ");
            let cover = "";
            const im = chunk.match(/<img[^>]+(?:data-src|src)="([^"]+)"/i);
            if (im) cover = this.abs(im[1]);
            // latestChapter 从文本里的 "Chapter N" 抽取
            let latestChapter = null;
            const cm = chunk.match(/Chapter\s+([\d.]+)/i);
            if (cm) latestChapter = "Chapter " + cm[1];
            out.push(new Comic({ id, title, cover, latestChapter, tags: [] }));
        }
        return out;
    }

    search = { load: async (keyword, _options, page) => {
        const kw = String(keyword || "").trim();
        if (!kw) return { comics: [], maxPage: page };
        try {
            const url = this.baseUrl + "/?search=" + encodeURIComponent(kw);
            const comics = this.parseCards(await this.get(url));
            return { comics, maxPage: page };
        } catch { return { comics: [], maxPage: page }; }
    }};

    explore = [
        { title: "MangaKatana · 热门", type: "multiPageComicList", load: async (page) => {
            try { return { comics: this.parseCards(await this.get(this.baseUrl + "/hot-manga/page/" + page)), maxPage: page + 1 }; }
            catch { return { comics: [], maxPage: page }; }
        }},
        { title: "MangaKatana · 最新上架", type: "multiPageComicList", load: async (page) => {
            try { return { comics: this.parseCards(await this.get(this.baseUrl + "/new-manga/page/" + page)), maxPage: page + 1 }; }
            catch { return { comics: [], maxPage: page }; }
        }},
        { title: "MangaKatana · 更新", type: "multiPageComicList", load: async (page) => {
            try { return { comics: this.parseCards(await this.get(this.baseUrl + "/latest-update/page/" + page)), maxPage: page + 1 }; }
            catch { return { comics: [], maxPage: page }; }
        }},
    ];

    comic = {
        loadInfo: async (book) => {
            const id = String(book == null ? "" : (book.id || book));
            if (!id) throw new Error("缺少书籍 ID");
            const hint = book && typeof book === "object" ? book.url : "";
            const seriesUrl = hint && /\/manga\//i.test(hint) ? this.abs(hint) : this.baseUrl + "/manga/" + encodeURIComponent(id);
            const html = await this.get(seriesUrl);

            let title = "";
            const tm = html.match(/<h1[^>]*>([\s\S]{2,150}?)<\/h1>/i);
            if (tm) title = this.decode(String(tm[1]).replace(/<[^>]+>/g, ""));

            let cover = "";
            const cm = html.match(/<img[^>]+src="([^"]*\/imgs\/cover\/[^"]+)"/i);
            if (cm) cover = this.abs(cm[1]);

            let author = "";
            const am = html.match(/Author[\s\S]{0,200}?<a[^>]*>([^<]+)<\/a>/i);
            if (am) author = this.decode(am[1]);

            // 标签：详情页 "genres" 区块的链接
            const tags = [];
            const genreBlock = html.match(/Genres?[\s\S]{0,1200}/i);
            if (genreBlock) {
                for (const m of genreBlock[0].matchAll(/href="[^"]*\/manga-category\/[^"]*"[^>]*>([^<]{2,40})</gi)) {
                    const v = this.decode(m[1]);
                    if (v && tags.indexOf(v) < 0 && !/^more$/i.test(v)) tags.push(v);
                }
            }

            // 描述
            let description = "";
            const dm = html.match(/<div[^>]*class="[^"]*summary[^"]*"[^>]*>([\s\S]{20,1500}?)<\/div>/i)
                || html.match(/<p[^>]*>([\s\S]{30,1200}?)<\/p>/i);
            if (dm) description = this.decode(String(dm[1]).replace(/<[^>]+>/g, " "));

            // 章节：形如 /manga/{slug}.{id}/cN  （只取当前漫画自身的章节）
            const chapters = {};
            const idPrefix = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const re = new RegExp('href="([^"]*\\/manga\\/' + idPrefix + '\\/c[^"?#]+)"[^>]*>([\\s\\S]{0,200}?)<\\/a>', "gi");
            for (const m of html.matchAll(re)) {
                const href = this.decode(m[1]);
                const epId = (href.match(/\/(c[^/?#]+)$/i) || [])[1] || href; // 保留 c 前缀，如 c1
                const label = this.decode(String(m[2]).replace(/<[^>]+>/g, " "));
                if (!chapters[epId]) chapters[epId] = label || ("Chapter " + epId);
            }
            // 兜底：任意自身 /cN 链接
            if (!Object.keys(chapters).length) {
                const re2 = new RegExp('\\/manga\\/' + idPrefix + '\\/(c[\\w.]+)', "gi");
                for (const m of html.matchAll(re2)) if (!chapters[m[1]]) chapters[m[1]] = "Chapter " + m[1].slice(1);
            }
            if (!Object.keys(chapters).length) throw new Error("没有找到章节，可能该漫画需要登录");

            return new ComicDetails({
                id, title: title || id.replace(/\.\d+$/, ""), cover, author, description,
                tags: tags.length ? { "题材": tags } : {},
                chapters, url: seriesUrl
            });
        },
        loadEp: async (_comicId, epId) => {
            const ep = String(epId || "").replace(/^\//, "");
            const id = String(_comicId == null ? "" : (_comicId.id || _comicId));
            const slug = id.replace(/\.\d+$/, "");
            // epId 可能是纯 "c1" 或完整 "/manga/slug.id/c1"
            let url;
            if (/\/manga\//i.test(ep)) url = this.abs(ep);
            else url = this.baseUrl + "/manga/" + encodeURIComponent(id) + "/" + ep;
            const html = await this.get(url);
            const imgs = [];
            for (const m of html.matchAll(/<img[^>]+(?:data-src|src)="([^"]*\/token\/[^"]+\/\d+\.(?:jpg|jpeg|png|webp))"/gi)) {
                let u = this.abs(m[1]);
                if (!imgs.includes(u)) imgs.push(u);
            }
            // 兜底：iN.mangakatana.com 直链
            if (!imgs.length) {
                for (const m of html.matchAll(/(https?:[^"'\s]*i\d*\.mangakatana\.com[^"'\s]+\.(?:jpg|jpeg|png|webp))/gi)) {
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
