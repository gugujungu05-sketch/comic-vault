/**
 * MangaPill（mangapill.com）· 老牌英文漫画/韩漫聚合站，内容完整、章节多。
 * 服务端直出 HTML，无登录、无 Cloudflare 挑战，图片 CDN 直链。
 * - 搜索：GET /search?q=xxx → 卡片
 * - 发现：GET / → 最新更新
 * - 详情：GET /manga/{id}/{slug} → 标题/封面/标签 + /chapters/... 章节
 * - 章节图片：GET /chapters/{id}/{slug} → <img data-src="...">
 */
class MangaPill extends ComicSource {
    name = "MangaPill 漫画";
    key = "mangapill";
    version = "1.0.0";
    minAppVersion = "1.6.0";
    url = "https://mangapill.com";
    baseUrl = "https://mangapill.com";
    mediaType = "comic";
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9"
    };

    async get(url) {
        const r = await Network.get(url, this.headers);
        if (!r || r.status !== 200 || !r.body) throw new Error("MangaPill 请求失败：HTTP " + (r && r.status));
        return String(r.body);
    }

    decode(s) {
        return String(s == null ? "" : s)
            .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
            .replace(/&(amp|quot|lt|gt|nbsp|apos);/gi, (_, e) => ({ amp: "&", quot: '"', lt: "<", gt: ">", nbsp: " ", apos: "'" })[e.toLowerCase()] || _)
            .trim();
    }

    /** /manga/{id}/... → id */
    mangaIdOf(href) {
        const m = String(href || "").match(/\/manga\/(\d+)/i);
        return m ? m[1] : "";
    }

    cardsFrom(html) {
        const out = [];
        const seen = new Set();
        // <a href="/manga/{id}/{slug}" ...><figure><img data-src="..." alt="Title ..."/>
        const re = /href="(\/manga\/(\d+)\/[^"]+)"[\s\S]{0,400}?<img[^>]+(?:data-src|src)="([^"]+)"[^>]*alt="([^"]*)"/gi;
        let m;
        while ((m = re.exec(html))) {
            const id = m[2];
            if (seen.has(id)) continue;
            seen.add(id);
            let title = this.decode(m[4] || "").trim();
            // alt 常为 "Title Title"，去掉重复的一半
            const parts = title.split(/\s{2,}|\s+/);
            const half = Math.floor(parts.length / 2);
            if (half > 0 && parts.slice(0, half).join(" ").toLowerCase() === parts.slice(half).join(" ").toLowerCase()) {
                title = parts.slice(0, half).join(" ");
            }
            if (!title) title = m[1].split("/").pop().replace(/-/g, " ");
            out.push(new Comic({ id, title, cover: String(m[3]).replace(/&amp;/g, "&"), tags: [] }));
        }
        return out;
    }

    search = { load: async (keyword, options, page) => {
        keyword = String(keyword || "").trim();
        if (!keyword) return { comics: [], maxPage: page };
        try {
            const html = await this.get(this.baseUrl + "/search?q=" + encodeURIComponent(keyword));
            return { comics: this.cardsFrom(html), maxPage: page + 1 };
        } catch { return { comics: [], maxPage: page }; }
    }};

    explore = [
        { title: "MangaPill · 最近更新", type: "multiPageComicList", load: async (page) => {
            const url = page > 1 ? this.baseUrl + "/?page=" + page : this.baseUrl + "/";
            return { comics: this.cardsFrom(await this.get(url)), maxPage: page + 1 };
        }},
    ];

    comic = {
        loadInfo: async (book) => {
            const id = String(book == null ? "" : (book.id || book));
            if (!id) throw new Error("缺少书籍 ID");
            const hint = book && typeof book === "object" ? book.url : "";
            const detailUrl = hint && /\/manga\//i.test(hint) ? String(hint) : this.baseUrl + "/manga/" + encodeURIComponent(id);
            const html = await this.get(detailUrl);
            let title = "", cover = "", desc = "";
            const tags = [];
            const t = html.match(/<h1[^>]*>([\s\S]{1,200}?)<\/h1>/i);
            if (t) title = this.decode(String(t[1]).replace(/<[^>]+>/g, ""));
            const cm = html.match(/<img[^>]+(?:data-src|src)="(https?:[^"]*\/i\/[^"]+)"[^>]*alt="/i)
                || html.match(/<img[^>]+data-src="(https?:[^"]+)"[^>]*alt="[^"]*"[^>]*class="[^"]*object-cover/i);
            if (cm) cover = String(cm[1]).replace(/&amp;/g, "&");
            const dm = html.match(/(?:Description|Summary)[\s\S]{0,100}?<p[^>]*>([\s\S]{20,1500}?)<\/p>/i)
                || html.match(/<p[^>]*class="[^"]*(?:description|summary)[^"]*"[^>]*>([\s\S]{20,1500}?)<\/p>/i);
            if (dm) desc = this.decode(String(dm[1]).replace(/<[^>]+>/g, " "));
            // 标签：详情页 genre 链接
            for (const m of html.matchAll(/\/genres?\/[^"']+["'][^>]*>([^<]{2,30})</gi)) {
                const v = this.decode(m[1]);
                if (v && !tags.includes(v)) tags.push(v);
            }
            const chapters = {};
            const seen = new Set();
            for (const m of html.matchAll(/href="(\/chapters\/([^\/"?#]+)\/[^"]+)"[^>]*>([\s\S]{0,300}?)<\/a>/gi)) {
                const path = m[1], cid = m[2];
                if (seen.has(path)) continue;
                seen.add(path);
                const label = this.decode(String(m[3]).replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
                chapters[path] = label || ("章节 " + seen.size);
            }
            if (!Object.keys(chapters).length) throw new Error("没有找到章节");
            return new ComicDetails({
                id, title: title || (book && book.title) || "MangaPill", cover, description: desc,
                tags: tags.length ? { "题材": tags.slice(0, 20) } : {}, chapters, url: detailUrl
            });
        },
        loadEp: async (comicId, epId) => {
            // epId 是 /chapters/3069-10700500/slug 去掉前导 / 的路径
            const path = String(epId || "").replace(/^\//, "");
            const url = /^https?:\/\//i.test(path) ? path : this.baseUrl + "/" + path;
            const html = await this.get(url);
            const imgs = [];
            for (const m of html.matchAll(/<img[^>]+(?:data-src|src)="(https?:\/\/[^"]+)"/gi)) {
                const u = String(m[1]).replace(/&amp;/g, "&");
                if (!imgs.includes(u)) imgs.push(u);
            }
            if (!imgs.length) throw new Error("这一话没有正文图片");
            return { images: imgs };
        },
        onThumbnailLoad: (url) => ({ headers: { "Referer": "https://mangapill.com/", "User-Agent": this.headers["User-Agent"] } })
    };
}
