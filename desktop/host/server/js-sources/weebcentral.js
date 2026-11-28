/**
 * Weeb Central（weebcentral.com）· 英文漫画/韩漫聚合站，MangaDex 停服后的主要替代站之一。
 * 内容海量、更新快，界面为 HTMX（服务端直出 HTML），无需登录、无 Cloudflare 挑战。
 * - 搜索/发现：GET /search/data?text=&sort=&offset=&limit= → <article> 卡片
 * - 详情/目录：GET /series/{id}/{slug} → 标题/封面/标签 + /chapters/{cid} 章节链接
 * - 全章节：GET /series/{id}/{slug}/full-chapter-list（可选，展开完整目录）
 * - 章节图片：GET /chapters/{cid}/images?is_prev=False&reading_style=long_strip → <img src>
 * 图片为直链（scans-hot.planeptune.us 等），无需 Referer。
 */
class WeebCentral extends ComicSource {
    name = "Weeb Central 漫画";
    key = "weebcentral";
    version = "1.0.0";
    minAppVersion = "1.6.0";
    url = "https://weebcentral.com";
    baseUrl = "https://weebcentral.com";
    mediaType = "comic";
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9"
    };

    async get(url) {
        const r = await Network.get(url, this.headers);
        if (!r || r.status !== 200 || !r.body) throw new Error("Weeb Central 请求失败：HTTP " + (r && r.status));
        return String(r.body);
    }

    decode(s) {
        return String(s == null ? "" : s)
            .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
            .replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCharCode(parseInt(x, 16)))
            .replace(/&(amp|quot|lt|gt|nbsp|apos);/gi, (_, e) => ({ amp: "&", quot: '"', lt: "<", gt: ">", nbsp: " ", apos: "'" })[e.toLowerCase()] || _)
            .trim();
    }

    /** 从 /series/{id}/... 抽 id */
    seriesIdOf(href) {
        const m = String(href || "").match(/\/series\/([^/?#]+)/i);
        return m ? decodeURIComponent(m[1]) : "";
    }

    /** 解析搜索/发现的 <article> 卡片 */
    cardsFrom(html) {
        const out = [];
        const seen = new Set();
        try {
            // 系列链接是绝对 URL：href="https://weebcentral.com/series/{id}/{slug}"
            const re = /href="(https?:\/\/[^"]*\/series\/([^/"?#]+)[^"]*)"/gi;
            let m;
            while ((m = re.exec(html))) {
                const href = m[1].replace(/&amp;/g, "&");
                const id = decodeURIComponent(m[2]);
                if (!id || seen.has(id)) continue;
                seen.add(id);
                // 取该 <a> 附近的卡片片段：截取到下一个 </article>
                const start = m.index;
                const aEnd = html.indexOf("</a>", start);
                const artEnd = html.indexOf("</article>", start);
                const chunk = html.slice(start, (artEnd > 0 && artEnd - start < 6000) ? artEnd : (aEnd > 0 ? aEnd : start + 2000));
                let title = "";
                const tm = chunk.match(/class="[^"]*text-ellipsis[^"]*"[^>]*>([^<]{2,150})</i)
                    || chunk.match(/alt="([^"]{2,150}?) cover"/i)
                    || chunk.match(/>([^<>]{3,150})<\/h[1-3]/i);
                if (tm) title = String(tm[1]).trim();
                // 兜底用 URL slug（/series/{id}/{slug}）
                if (!title) {
                    const sm = href.match(/\/series\/[^/]+\/([^/?#]+)/);
                    title = sm ? decodeURIComponent(sm[1]).replace(/-/g, " ") : id.replace(/-/g, " ");
                }
                // HTML 实体解码（&#39; &amp; &quot; 等）
                title = title.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
                    .replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCharCode(parseInt(x, 16)))
                    .replace(/&(amp|quot|lt|gt|nbsp);/gi, (_, e) => ({ amp: "&", quot: '"', lt: "<", gt: ">", nbsp: " " })[e.toLowerCase()] || _)
                    .trim();
                let cover = "";
                const im = chunk.match(/<img[^>]+src="([^"]+)"/i);
                if (im) cover = String(im[1]).replace(/&amp;/g, "&");
                out.push(new Comic({ id, title, cover, tags: [] }));
            }
        } catch { /* 忽略 */ }
        return out;
    }

    search = { load: async (keyword, options, page) => {
        keyword = String(keyword || "").trim();
        if (!keyword) return { comics: [], maxPage: page };
        const clean = keyword.replace(/[^\da-zA-Z\u4e00-\u9fa5\s]/g, " ").replace(/\s+/g, " ").trim();
        const url = this.baseUrl + "/search/data?limit=32&offset=" + ((page - 1) * 32)
            + "&text=" + encodeURIComponent(clean)
            + "&sort=Best%20Match&order=Descending&official=Any&anime=Any&adult=Any&display_mode=Full%20Display";
        try { return { comics: this.cardsFrom(await this.get(url)), maxPage: page + 1 }; }
        catch { return { comics: [], maxPage: page }; }
    }};

    explore = [
        { title: "Weeb Central · 最新更新", type: "multiPageComicList", load: async (page) => {
            const url = this.baseUrl + "/search/data?limit=32&offset=" + ((page - 1) * 32)
                + "&sort=Latest%20Updates&order=Descending&official=Any&anime=Any&adult=Any&display_mode=Full%20Display";
            return { comics: this.cardsFrom(await this.get(url)), maxPage: page + 1 };
        }},
        { title: "Weeb Central · 人气", type: "multiPageComicList", load: async (page) => {
            const url = this.baseUrl + "/search/data?limit=32&offset=" + ((page - 1) * 32)
                + "&sort=Popularity&order=Descending&official=Any&anime=Any&adult=Any&display_mode=Full%20Display";
            return { comics: this.cardsFrom(await this.get(url)), maxPage: page + 1 };
        }},
    ];

    comic = {
        loadInfo: async (book) => {
            const id = String(book == null ? "" : (book.id || book));
            if (!id) throw new Error("缺少书籍 ID");
            const hint = book && typeof book === "object" ? book.url : "";
            const seriesUrl = hint && /\/series\//i.test(hint) ? String(hint).replace(/&amp;/g, "&") : this.baseUrl + "/series/" + encodeURIComponent(id);
            const html = await this.get(seriesUrl);
            let title = "", cover = "", desc = "", author = "";
            const tags = [];
            const t = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
            if (t) title = this.decode(t[1]);
            const cm = html.match(/<img[^>]+src="(https?:[^"]*(?:cover|temp)[^"]*)"/i) || html.match(/<img[^>]+src="(https?:[^"]+)"[^>]*alt="[^"]*"[^>]*>/i);
            if (cm) cover = String(cm[1]).replace(/&amp;/g, "&");
            const dm = html.match(/<p[^>]*>([\s\S]{20,1200}?)<\/p>/i);
            if (dm) desc = String(dm[1]).replace(/<[^>]+>/g, "").trim();
            const am = html.match(/(?:Author|Artist)[\s\S]{0,300}?<a[^>]*>([^<]+)<\/a>/i);
            if (am) author = String(am[1]).trim();
            // 标签：章节按钮上方的 <a> 标签链接；简化用文章分类关键词兜底
            const tagBlock = html.match(/Tag\(s\):?[\s\S]{0,800}/i);
            if (tagBlock) {
                for (const m of tagBlock[0].matchAll(/>([^<>]{2,30})</g)) {
                    const v = String(m[1]).trim();
                    if (v && v.length <= 30 && !/^(Tag|s:|Status|Author)$/i.test(v)) tags.push(v);
                }
            }
            // 章节列表：/chapters/{cid}，从目录页顺序取
            const chapters = {};
            let chHtml = html;
            if (/full-chapter-list/i.test(html)) {
                try { chHtml = await this.get(seriesUrl.replace(/\/$/, "") + "/full-chapter-list"); } catch { chHtml = html; }
            }
            const seen = new Set();
            for (const m of chHtml.matchAll(/href="[^"]*\/chapters\/([A-Za-z0-9]+)[^"]*"[^>]*>([\s\S]{0,300}?)<\/a>/gi)) {
                const cid = m[1];
                if (seen.has(cid)) continue;
                seen.add(cid);
                const label = String(m[2]).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
                chapters[cid] = label || ("第 " + (seen.size) + " 话");
            }
            // 兜底：任意 /chapters/{cid} 链接
            if (!Object.keys(chapters).length) {
                for (const m of chHtml.matchAll(/\/chapters\/([A-Za-z0-9]{10,})/gi)) {
                    if (!seen.has(m[1])) { seen.add(m[1]); chapters[m[1]] = "第 " + seen.size + " 话"; }
                }
            }
            if (!Object.keys(chapters).length) throw new Error("没有找到章节，可能需要登录");
            return new ComicDetails({
                id, title: title || (book && book.title) || "Weeb Central", cover, author, description: desc,
                tags: tags.length ? { "题材": tags } : {}, chapters, url: seriesUrl
            });
        },
        loadEp: async (comicId, epId) => {
            const url = this.baseUrl + "/chapters/" + encodeURIComponent(epId) + "/images?is_prev=False&reading_style=long_strip";
            const html = await this.get(url);
            // 正文图在 section[x-data~=scroll] 内；这里抓所有 <img src> 并过滤掉站点 logo/图标
            const imgs = [];
            for (const m of html.matchAll(/<img[^>]+src="([^"]+)"/gi)) {
                let u = String(m[1]).replace(/&amp;/g, "&");
                if (/^\/\//.test(u)) u = "https:" + u;
                if (/^\//.test(u)) u = this.baseUrl + u;
                if (!/^https?:\/\//i.test(u)) continue;
                if (/\/static\//i.test(u) || /\/(logo|icon)/i.test(u)) continue;
                if (!imgs.includes(u)) imgs.push(u);
            }
            if (!imgs.length) throw new Error("这一话没有正文图片，可能需要登录");
            return { images: imgs };
        },
        onThumbnailLoad: (url) => ({ headers: { "Referer": this.baseUrl + "/", "User-Agent": this.headers["User-Agent"] } })
    };
}
