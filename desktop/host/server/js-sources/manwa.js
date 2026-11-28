/**
 * 漫蛙漫画源（manwa，基于 manwaua.cc 服务端渲染页面解析）。
 * 漫蛙域名频繁迁移，主域名从"防走失页"动态获取并缓存；图片 CDN 独立域名。
 * 页面为 SSR HTML：首页/搜索/详情/章节都是 HTML 解析，图片在 data-r-src。
 */
class ManWa extends ComicSource {
    name = "漫蛙漫画";
    key = "manwa";
    version = "1.0.0";
    minAppVersion = "1.6.0";
    url = "https://manwaua.cc";
    baseUrl = "https://manwaua.cc";
    imgHost = "https://mwfimsvfast40.cc";
    mediaType = "comic";
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Referer": "https://manwaua.cc/",
    };
    // 章节图（*_zb.webp）整段被 AES-128-CBC 加密，key=iv（16 字节，hex 形式）；
    // 浏览器端用 CryptoJS 解密后得到标准 WebP。后端图片代理据此还原。封面 cover_1.jpg 未加密，不受影响。
    imageDecode = { aes: { key: "6d793265637265743738326563726574", iv: "6d793265637265743738326563726574" } };

    abs(p, origin) {
        p = String(p || "").trim();
        if (/^https?:\/\//i.test(p)) return p;
        if (p.startsWith("//")) return "https:" + p;
        return (origin || this.baseUrl) + (p.startsWith("/") ? p : "/" + p);
    }

    async get(url) {
        const r = await Network.get(url, this.headers);
        if (!r || r.status !== 200 || !r.body) throw new Error("漫蛙请求失败：HTTP " + (r && r.status));
        return String(r.body);
    }

    /** 从防走失页动态解析当前可用主域名；失败回退内置最新域名。 */
    async resolveBase() {
        const cached = this.loadData("_base");
        if (cached && Date.now() - (cached.at || 0) < 12 * 3600 * 1000) return cached.v;
        let found = "";
        try {
            const html = await this.get("https://manwa.xin/");
            const b64 = (html.match(/atob\(['"]([A-Za-z0-9+/=]+)['"]\)/) || [])[1];
            if (b64) {
                const arr = JSON.parse(Convert.decodeUtf8(Convert.decodeBase64(b64)));
                if (arr.length) found = String(arr[0]).replace(/\/+$/, "");
            }
        } catch { /* 回退 */ }
        if (!found) found = this.baseUrl;
        this.saveData("_base", { v: found, at: Date.now() });
        return found;
    }

    /** 通用卡片解析：从 <a href="/book/{id}"> 提取 id/标题/封面 */
    parseCards(html, base) {
        const doc = new HtmlDocument(html);
        const out = [], seen = new Set();
        try {
            for (const a of doc.querySelectorAll('a[href]')) {
                const href = String(a.attributes.href || "");
                const m = href.match(/^\/book\/(\d+)/);
                if (!m) continue;
                const id = m[1];
                if (seen.has(id)) continue;
                let cover = "", title = String(a.attributes.title || "");
                const img = a.querySelector("img");
                if (img) {
                    cover = this.abs(img.attributes["data-original"] || img.attributes["data-home-src"] || img.attributes.src || "", base);
                    if (!title) title = String(img.attributes.alt || "");
                }
                if (!title) continue;
                seen.add(id);
                out.push(new Comic({ id, title: title.replace(/\s*\(完整版\)\s*/g, "").trim(), cover, tags: [] }));
            }
        } finally { doc.dispose(); }
        return out;
    }

    explore = [{
        title: "漫蛙漫画",
        type: "multiPageComicList",
        load: async (page) => {
            const base = await this.resolveBase();
            const html = await this.get(base + "/?page=" + page);
            const comics = this.parseCards(html, base);
            return { comics, maxPage: comics.length ? page + 1 : page };
        },
    }];

    search = {
        load: async (keyword, options, page) => {
            keyword = String(keyword || "").trim();
            if (!keyword) return { comics: [], maxPage: page };
            const base = await this.resolveBase();
            const url = base + "/search/" + encodeURIComponent(keyword) + (page > 1 ? `?page=${page}` : "");
            let html = "";
            try { html = await this.get(url); } catch (e) { return { comics: [], maxPage: page }; }
            const comics = this.parseCards(html, base);
            return { comics, maxPage: comics.length ? page + 1 : page };
        },
    };

    comic = {
        loadInfo: async (id) => {
            const base = await this.resolveBase();
            const html = await this.get(base + "/book/" + id);
            const doc = new HtmlDocument(html);
            try {
                let title = "", cover = "", description = "";
                const h1 = doc.querySelector("h1");
                if (h1) title = String(h1.text || "").trim();
                const desc = doc.querySelector("p.detail-desc");
                if (desc) description = String(desc.text || "").trim();
                const chapters = {};
                for (const a of doc.querySelectorAll('a[href]')) {
                    const href = String(a.attributes.href || "");
                    const m = href.match(/^\/chapter\/(\d+)/);
                    if (!m) continue;
                    // 跳过「开始阅读」等底部按钮（无 title、class=detail-bottom-btn）
                    const cls = String(a.attributes.class || "");
                    if (/detail-bottom-btn|bottom-btn/i.test(cls)) continue;
                    const chId = m[1];
                    let name = String(a.attributes.title || "").trim();
                    if (!name) name = String(a.text || "").trim();
                    if (!name || /^(开始阅读|阅读|立即阅读)$/.test(name)) {
                        if (chapters[chId]) continue; // 已有正确标题则不覆盖
                        name = "第 " + chId + " 话";
                    }
                    chapters[chId] = name;
                }
                const img = doc.querySelector("img[data-original]");
                if (img) cover = this.abs(img.attributes["data-original"] || "", base);
                // 题材：详情页 <span class="info-tag-span">标签</span>
                const tags = {};
                for (const n of doc.querySelectorAll('.info-tag-span')) {
                    const t = String(n.text || "").trim();
                    if (t && t.length <= 24) (tags["题材"] || (tags["题材"] = [])).push(t);
                }
                return new ComicDetails({
                    id: id, title: title.replace(/\s*\(完整版\)\s*/g, "").trim(), cover, description,
                    tags, chapters, url: base + "/book/" + id,
                });
            } finally { doc.dispose(); }
        },
        loadEp: async (comicId, epId) => {
            const base = await this.resolveBase();
            const html = await this.get(base + "/chapter/" + epId);
            const doc = new HtmlDocument(html);
            try {
                const imgs = [];
                const nodes = doc.querySelectorAll("img.content-img");
                for (const n of nodes) {
                    const u = String(n.attributes["data-r-src"] || "").trim();
                    if (u) imgs.push(this.abs(u, base));
                }
                if (!imgs.length) {
                    // 兜底：所有含 upload2 的 data-r-src
                    for (const n of doc.querySelectorAll("img[data-r-src]")) {
                        const u = String(n.attributes["data-r-src"] || "").trim();
                        if (u && /upload2/i.test(u)) imgs.push(this.abs(u, base));
                    }
                }
                return { images: imgs };
            } finally { doc.dispose(); }
        },
        onImageLoad: (url) => new ImageLoadingConfig({ url: url, headers: { "Referer": "https://manwaua.cc/", "User-Agent": "Mozilla/5.0" } }),
    };
}
