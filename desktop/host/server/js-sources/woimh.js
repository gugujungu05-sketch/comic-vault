/**
 * 我爱漫画网源（www.woimh.com）。
 * 纯 HTTP + HTML 解析：
 * - 搜索：/search?keyword=xxx
 * - 发现/分类：/booklist?last=1（最近更新）、/booklist?end=1（完结）、/booklist/{标签}、/rank
 * - 详情：/book/mh{数字}，封面 tu.petatt.cn/book/{数字}/cover.jpg/0
 * - 章节：/chapter/{a}-{b}，图片 tu.petatt.cn/book/{书数字}/{章id}/{页id}.jpg/0
 * 该站同时含「漫画」和「小说版」条目（如"小说版守护女主的哥哥"），统一按漫画图源处理。
 */
class Woimh extends ComicSource {
    name = "我爱漫画网";
    key = "woimh";
    version = "1.0.0";
    minAppVersion = "1.6.0";
    url = "https://www.woimh.com";
    baseUrl = "https://www.woimh.com";
    mediaType = "comic";
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Referer": "https://www.woimh.com/"
    };

    abs(p, origin) {
        p = String(p || "").trim();
        if (/^https?:\/\//i.test(p)) return p.replace(/^http:\/\//i, "https://");
        if (p.startsWith("//")) return "https:" + p;
        return (origin || this.baseUrl) + (p.startsWith("/") ? p : "/" + p);
    }

    decode(s) {
        return String(s == null ? "" : s)
            .replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").trim();
    }

    // 封面 CDN：站点已把 pic.woimh.com 切到 tu.petatt.cn（pic 域名现返回 403）。
    // 统一把旧 pic 域名重写为可用的 tu 域名，避免封面 403 裂图。
    fixCoverHost(u) {
        return String(u || "").replace(/^https?:\/\/pic\.woimh\.com/i, "https://tu.petatt.cn");
    }
    isPlaceholder(u) { return !u || /zwfm|\/static\/|logo/i.test(u); }

    // 封面实际位于 <a> 内的 <p class="mh-cover" style="background-image:url(...)">，
    // 不在 <a> 自身 style 上——旧实现读 a.style 始终取不到，导致全部回退占位图。
    // 现在从子元素的 background-image（含 data-src/img）里取，并修域名。
    coverFrom(a, num) {
        try {
            if (!a || !a.querySelectorAll) return this.placeholderCover();
            const nodes = [a].concat(Array.from(a.querySelectorAll("p,div,span,img")));
            for (const node of nodes) {
                const attrs = node.attributes || {};
                const imgSrc = attrs.src || attrs["data-src"] || attrs["data-echo"] || attrs["data-original"] || "";
                const style = String(attrs.style || "");
                const bgm = /background-image\s*:\s*url\(([^)]+)\)/i.exec(style);
                const bg = bgm ? bgm[1].replace(/^['"]|['"]$/g, "") : "";
                const picked = imgSrc || bg;
                if (!picked) continue;
                const u = this.fixCoverHost(this.abs(picked, this.baseUrl));
                if (u && !this.isPlaceholder(u)) return u;
            }
        } catch (e) { /* 忽略 */ }
        return this.placeholderCover();
    }
    placeholderCover() { return "https://img.woimh.com/zwfm.jpg"; }

    async get(url) {
        const r = await Network.get(url, this.headers);
        if (!r || r.status !== 200 || !r.body) throw new Error("我爱漫画网请求失败：HTTP " + (r && r.status));
        return String(r.body);
    }

    /** 卡片解析：<a href="/book/mh{id}" title="标题"> + 封面(img src 或 background-image) */
    parseCards(html) {
        const doc = new HtmlDocument(html);
        const out = [], seen = new Set();
        try {
            for (const a of doc.querySelectorAll('a[href]')) {
                const href = String(a.attributes.href || "");
                const m = href.match(/^\/book\/(mh\d+)\/?$/i);
                if (!m) continue;
                const id = m[1];
                let title = this.decode(a.attributes.title || "");
                const img = a.querySelector("img");
                if (!title && img) title = this.decode(img.attributes.alt || "");
                if (!title) continue;
                if (seen.has(id)) continue;
                seen.add(id);
                const num = id.replace(/^mh/, "");
                // 站点封面已统一为占位图，从 a 的 style/img 里取；取不到用占位图，旧 CDN 已失效
                const cover = this.coverFrom(a, num);
                out.push(new Comic({ id, title, cover, tags: [] }));
            }
        } finally { doc.dispose(); }
        return out;
    }

    /** 从任意列表页 HTML 里补封面（background-image 形式），仅在没有 img 时兜底 */
    search = { load: async (keyword, options, page) => {
        keyword = String(keyword || "").trim();
        if (!keyword) return { comics: [], maxPage: page };
        let html = "";
        try { html = await this.get(this.baseUrl + "/search?keyword=" + encodeURIComponent(keyword)); }
        catch (e) { return { comics: [], maxPage: page }; }
        // 搜索页封面在 background-image，标题在 title 属性；先按 a[title] 收集 id/title，再补封面
        const doc = new HtmlDocument(html);
        const out = [], seen = new Set();
        try {
            for (const a of doc.querySelectorAll('a[href]')) {
                const href = String(a.attributes.href || "");
                const m = href.match(/^\/book\/(mh\d+)\/?$/i);
                if (!m) continue;
                const title = this.decode(a.attributes.title || "");
                if (!title) continue;
                const id = m[1];
                if (seen.has(id)) continue;
                seen.add(id);
                const cover = this.coverFrom(a, id.replace(/^mh/, ""));
                out.push(new Comic({ id, title, cover, tags: [] }));
            }
        } finally { doc.dispose(); }
        return { comics: out, maxPage: page };
    }};

    explore = [
        { title: "最近更新", type: "multiPageComicList", load: async (page) => {
            const html = await this.get(this.baseUrl + "/booklist?last=1" + (page > 1 ? "&page=" + page : ""));
            const comics = this.parseCards(html);
            return { comics, maxPage: comics.length ? page + 1 : page };
        }},
        { title: "完结优选", type: "multiPageComicList", load: async (page) => {
            const html = await this.get(this.baseUrl + "/booklist?end=1" + (page > 1 ? "&page=" + page : ""));
            const comics = this.parseCards(html);
            return { comics, maxPage: comics.length ? page + 1 : page };
        }},
    ];

    category = {
        title: "我爱漫画网分类",
        parts: [{
            name: "题材",
            type: "fixed",
            categories: ["恋爱", "奇幻", "日常", "宫廷", "少女", "冒险", "爱情", "穿越", "搞笑", "热血", "悬疑"],
            itemType: "category",
            categoryParams: ["恋爱", "奇幻", "日常", "宫廷", "少女", "冒险", "爱情", "穿越", "搞笑", "热血", "悬疑"]
        }],
        enableRankingPage: false
    };

    categoryComics = { load: async (category, param, options, page) => {
        const url = this.baseUrl + "/booklist/" + encodeURIComponent(String(param || "")) + (page > 1 ? "?page=" + page : "");
        try {
            const html = await this.get(url);
            const comics = this.parseCards(html);
            return { comics, maxPage: comics.length >= 10 ? page + 1 : page };
        } catch (e) {
            return { comics: [], maxPage: page };
        }
    }};

    comic = {
        loadInfo: async (book) => {
            const raw = String(book == null ? "" : (book.id || book));
            const m = raw.match(/mh(\d+)/);
            const num = m ? m[1] : raw.replace(/^mh/, "");
            const html = await this.get(this.baseUrl + "/book/mh" + num);
            const doc = new HtmlDocument(html);
            try {
                let title = "", cover = this.placeholderCover(), description = "";
                const h1 = doc.querySelector("h1");
                if (h1) title = this.decode(h1.text || "");
                // 封面：详情页 banner_detail_bg / .cover img。该站详情页主图多为 zwfm 占位，
                // 真实封面只在搜索/发现列表的 background-image 里，详情页无法可靠对应，
                // 因此这里只取本页明确的有效封面，取不到保留占位图（不从「相关推荐」误取别的书）。
                for (const sel of ["img.banner_detail_bg", ".banner_detail_form .cover img", ".detail-cover img", ".book-cover img"]) {
                    const n = doc.querySelector(sel);
                    if (n) {
                        const u = this.fixCoverHost(this.abs(String(n.attributes.src || ""), this.baseUrl));
                        if (u && !this.isPlaceholder(u)) { cover = u; break; }
                    }
                }
                // 简介：常见 class 描述块
                for (const sel of ["p.detail-desc", ".book-desc", ".intro", ".description", "div.desc"]) {
                    const n = doc.querySelector(sel);
                    if (n && String(n.text || "").trim()) { description = this.decode(n.text); break; }
                }
                // 标签：/booklist/?tag=xxx 或 /booklist/xxx
                const tags = {};
                for (const a of doc.querySelectorAll('a[href]')) {
                    const href = String(a.attributes.href || "");
                    const tm = href.match(/booklist\/(?:\?tag=)?([^/?]+)/);
                    if (!tm) continue;
                    let t = "";
                    try { t = decodeURIComponent(tm[1]); } catch (e) { t = tm[1]; }
                    if (!t || /^\d+$/.test(t)) continue;
                    if (/^(恋爱|奇幻|日常|宫廷|少女|冒险|爱情|穿越|搞笑|热血|悬疑|科幻|恐怖|校园|都市)$/.test(t)) {
                        (tags["题材"] || (tags["题材"] = []));
                        if (tags["题材"].indexOf(t) < 0) tags["题材"].push(t);
                    }
                }
                // 章节：/chapter/{a}-{b}，标题取 a 文本（第XX话），过滤"开始阅读"
                const chapters = {};
                const seen = new Set();
                for (const a of doc.querySelectorAll('a[href]')) {
                    const href = String(a.attributes.href || "");
                    const cm = href.match(/^\/chapter\/(\d+-\d+)\/?$/i);
                    if (!cm) continue;
                    const chId = cm[1];
                    let name = String(a.attributes.title || "").trim() || String(a.text || "").trim();
                    // 「开始阅读 / 阅读 / 立即阅读」是底部跳转按钮，跳过它，用目录里的正经标题（第01话…）
                    if (/^(开始阅读|阅读|立即阅读|上一话|下一话)$/.test(name)) continue;
                    if (!name) name = "第 " + (seen.size + 1) + " 话"; // 兜底
                    name = this.decode(name);
                    if (seen.has(chId)) {
                        // 同一章多个入口时优先保留更像话数的短标题
                        if (chapters[chId] && name.length >= chapters[chId].length) continue;
                    }
                    seen.add(chId);
                    chapters[chId] = name;
                }
                return new ComicDetails({
                    id: "mh" + num, title, cover, description, tags, chapters,
                    url: this.baseUrl + "/book/mh" + num,
                });
            } finally { doc.dispose(); }
        },
        loadEp: async (book, chapterPath) => {
            let path = String(chapterPath || "").trim();
            // 章节 id 是裸的 {a}-{b} 或 /chapter/{a}-{b}，统一补全 /chapter/ 前缀
            if (/^\d+-\d+\/?$/i.test(path)) path = "/chapter/" + path;
            const url = this.abs(path, this.baseUrl);
            const html = await this.get(url);
            const doc = new HtmlDocument(html);
            try {
                const imgs = [], seen = new Set();
                for (const node of doc.querySelectorAll('img[src],img[data-echo],img[data-original]')) {
                    let u = String(node.attributes["data-echo"] || node.attributes["data-original"] || node.attributes.src || "").trim();
                    if (!u) continue;
                    // 当前格式：tu.petatt.cn/book/{数字}.jpg/{页}；旧格式：/book/{书}/{章}/{页}.jpg
                    // 统一以「图片 CDN 的 /book/ 路径」为准，过滤站内广告/logo/占位图
                    if (!/petatt\.cn\/book\//i.test(u) && !/\/book\/\d+\/\d+\/\d+\.(?:jpg|png|webp)/i.test(u)) continue;
                    u = this.abs(u, this.baseUrl);
                    // 站点对非浏览器请求统一下发同一张「本站声明」占位图（11833918.jpg），
                    // 它不是正文；识别并剔除，避免把广告图当漫画显示。
                    if (/11833918\.jpg/.test(u)) continue;
                    if (seen.has(u)) continue;
                    seen.add(u);
                    imgs.push(u);
                }
                if (!imgs.length) {
                    throw new Error("我爱漫画网本章正文需要浏览器会话：站点对服务器请求只返回声明占位图，请在官网阅读或登录后再试");
                }
                return imgs;
            } finally { doc.dispose(); }
        },
        onImageLoad: () => ({ headers: { "User-Agent": this.headers["User-Agent"], "Referer": "https://www.woimh.com/" } }),
        onThumbnailLoad: () => ({ headers: { "User-Agent": this.headers["User-Agent"], "Referer": "https://www.woimh.com/" } })
    };
}
