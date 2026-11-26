/**
 * WEBTOON（webtoons.com）· 韩国 Naver 官方英文/多语言韩漫平台。
 * 免费章节可直接阅读，无需登录；部分「Fast Pass / Daily」付费章节会跳过。
 * - 搜索：GET /en/search?keyword=xxx
 * - 详情/目录：GET /en/{genre}/{slug}/list?title_no=ID
 * - 章节图片：GET 该章节 viewer 页，取 <img data-url="...">
 * 图片走 webtoon-phinf.pstatic.net，需带 Referer: https://www.webtoons.com/
 */
class Webtoons extends ComicSource {
    name = "WEBTOON 韩漫";
    key = "webtoons";
    version = "1.0.0";
    minAppVersion = "1.6.0";
    url = "https://www.webtoons.com";
    baseUrl = "https://www.webtoons.com";
    mediaType = "comic";
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9"
    };

    async get(url) {
        const r = await Network.get(url, this.headers);
        if (!r || r.status !== 200 || !r.body) throw new Error("WEBTOON 请求失败：HTTP " + (r && r.status));
        return String(r.body);
    }

    /** 从含 list?title_no= 或 viewer 的链接里抽 title_no */
    titleNoOf(href) {
        const m = String(href || "").match(/title_no=(\d+)/i);
        return m ? m[1] : "";
    }

    /** 缓存每本书真实的 list 页 URL（含 genre/slug），loadInfo 时写入，loadEp 复用 */
    _listUrls = {};
    async listUrlOf(comicId, hint) {
        if (this._listUrls[comicId]) return this._listUrls[comicId];
        if (hint && /\/list\?/i.test(hint)) {
            this._listUrls[comicId] = String(hint);
            return hint;
        }
        // Webtoons 会根据 title_no 自动重定向到正确的 genre/slug，故 fantasy/all 即可
        return this.baseUrl + "/en/fantasy/all/list?title_no=" + comicId;
    }

    /** 解析搜索/榜单页的卡片 */
    cardsFrom(html) {
        const doc = new HtmlDocument(html);
        const out = [];
        try {
            const links = doc.querySelectorAll('a[href*="title_no="]') || [];
            const seen = new Set();
            for (const a of links) {
                const href = String(a.attributes.href || "");
                const id = this.titleNoOf(href);
                if (!id || seen.has(id)) continue;
                // 只要列表入口（避免重复命中 viewer 链接）
                if (!/\/list\?/i.test(href)) continue;
                let title = "", author = "", cover = "";
                const img = a.querySelector("img");
                if (img && img.attributes.src) cover = String(img.attributes.src);
                const strong = a.querySelector("strong.title") || a.querySelector(".title");
                if (strong && strong.text) title = String(strong.text).trim();
                const au = a.querySelector(".author");
                if (au && au.text) author = String(au.text).trim();
                if (!title) continue;
                seen.add(id);
                // 记住真实 list URL（含 genre/slug），供详情/章节复用
                this._listUrls[id] = href.replace(/&amp;/g, "&");
                out.push(new Comic({ id, title, cover, author, tags: ["韩漫", "WEBTOON"] }));
            }
        } finally { doc.dispose(); }
        return out;
    }

    search = { load: async (keyword, options, page) => {
        keyword = String(keyword || "").trim();
        if (!keyword) return { comics: [], maxPage: page };
        try {
            const html = await this.get(this.baseUrl + "/en/search?keyword=" + encodeURIComponent(keyword));
            const comics = this.cardsFrom(html);
            return { comics, maxPage: page };
        } catch (e) { return { comics: [], maxPage: page }; }
    }};

    explore = [
        { title: "WEBTOON · 热门", type: "multiPageComicList", load: async (page) => {
            const html = await this.get(this.baseUrl + "/en");
            return { comics: this.cardsFrom(html), maxPage: 1 };
        }},
        { title: "WEBTOON · 新作", type: "multiPageComicList", load: async (page) => {
            const html = await this.get(this.baseUrl + "/en/canvas/new");
            return { comics: this.cardsFrom(html), maxPage: 1 };
        }},
    ];

    comic = {
        loadInfo: async (book) => {
            const id = String(book == null ? "" : (book.id || book));
            const hint = book && typeof book === "object" ? book.url : "";
            const probeUrl = await this.listUrlOf(id, hint);
            // 直接请求并保留重定向后的最终 URL（slug 会被 Webtoons 自动补全）
            const resp = await Network.get(probeUrl, this.headers);
            if (!resp || resp.status !== 200 || !resp.body) throw new Error("WEBTOON 请求失败：HTTP " + (resp && resp.status));
            const listUrl = resp.url || probeUrl;
            this._listUrls[id] = listUrl;
            const html = String(resp.body);
            const doc = new HtmlDocument(html);
            let title = "", cover = "", author = "", desc = "";
            try {
                const t = doc.querySelector("h1") || doc.querySelector(".info_area h1") || doc.querySelector("h2.title");
                if (t && t.text) title = String(t.text).trim();
                const img = doc.querySelector(".thumb img") || doc.querySelector("#sideMenuContent img");
                if (img && img.attributes.src) cover = String(img.attributes.src);
                const au = doc.querySelector(".author");
                if (au && au.text) author = String(au.text).trim();
                const d = doc.querySelector(".summary");
                if (d && d.text) desc = String(d.text).trim();
            } finally { doc.dispose(); }
            // 章节列表：href 里含 episode_no= 的 viewer 链接
            const chapters = {};
            // viewer 链接：&episode_no= 或 &amp;episode_no= 都兼容
            const eps = [...html.matchAll(/href="([^"]*\/viewer\?title_no=\d+&(?:amp;)?episode_no=(\d+)[^"]*)"/gi)];
            for (const m of eps) {
                const epNo = m[2];
                chapters[epNo] = "第 " + epNo + " 话";
            }
            // 兜底：用 data-episode-no 属性
            if (!Object.keys(chapters).length) {
                const nums = [...html.matchAll(/data-episode-no="(\d+)"/gi)].map((m) => m[1]);
                for (const n of [...new Set(nums)]) chapters[n] = "第 " + n + " 话";
            }
            return new ComicDetails({
                id, title: title || "WEBTOON", cover, author, description: desc,
                tags: { "题材": ["韩漫", "WEBTOON"] }, chapters,
                url: listUrl
            });
        },
        loadEp: async (comicId, epId) => {
            // 找该章节的 viewer 页：从目录页里搜 episode_no=epId 的链接
            const listUrl = await this.listUrlOf(comicId);
            const listHtml = await this.get(listUrl);
            const m = listHtml.match(new RegExp('href="([^"]*viewer\\?title_no=\\d+&(?:amp;)?episode_no=' + epId + '(?![0-9])[^"]*)"', "i"));
            let viewerUrl;
            if (m) viewerUrl = m[1].replace(/&amp;/g, "&");
            else {
                const basePath = String(listUrl).replace(/\/list\?.*$/, "");
                viewerUrl = basePath + "/viewer?title_no=" + encodeURIComponent(comicId) + "&episode_no=" + encodeURIComponent(epId);
            }
            if (/^https?:/i.test(viewerUrl) === false) viewerUrl = this.baseUrl + viewerUrl;
            const html = await this.get(viewerUrl);
            // 正文图 class="_images"；class="_thumbnailImages" 是缩略图/推荐，必须排除
            const imgs = [...html.matchAll(/<img[^>]+data-url="([^"]+)"[^>]*class="[^"]*_images[^"]*"[^>]*>/gi)].map((x) => x[1]).filter(Boolean);
            // 兼容 class 在 data-url 之前的写法
            if (!imgs.length) {
                const all = [...html.matchAll(/<img[^>]*>/gi)].map((x) => x[0]);
                for (const tag of all) {
                    const cm = tag.match(/class="([^"]+)"/i);
                    const um = tag.match(/data-url="([^"]+)"/i);
                    if (cm && um && /(^|\s)_images(\s|$)/i.test(cm[1]) && um[1]) imgs.push(um[1]);
                }
            }
            if (!imgs.length) throw new Error("这一话没有正文图片，可能需要登录或为付费章节");
            return { images: imgs };
        },
        onImageLoad: (url) => new ImageLoadingConfig({
            url,
            headers: { "Referer": "https://www.webtoons.com/", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36" }
        }),
        onThumbnailLoad: (url) => ({ headers: { "Referer": "https://www.webtoons.com/", "User-Agent": "Mozilla/5.0" } })
    };
}
