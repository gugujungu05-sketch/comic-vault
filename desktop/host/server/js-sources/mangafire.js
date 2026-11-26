/**
 * MangaFire 漫画源（mangafire.to，英文/多语言）。
 *
 * 站点 2025 改版后全站 API 需要动态 VRF token（VM 混淆 + Cloudflare JS 挑战），
 * 纯 HTTP 无法生成。宿主提供 MangaFireVrf.generate(action,value,page) 通过无头浏览器
 * 按需生成并缓存带 vrf 的 API 路径；源脚本拿到路径后直接用 Network.get 裸连。
 *
 * 图片在 pw*.mfcdn3.xyz，需带 Referer: https://mangafire.to/；新版 API 已返回
 * 还原后的整图（pages[].url），无需再切片反混淆。
 */
class MangaFire extends ComicSource {
    name = "MangaFire";
    key = "mangafire";
    version = "1.0.0";
    minAppVersion = "1.6.0";
    url = "https://mangafire.to";
    baseUrl = "https://mangafire.to";
    mediaType = "comic";
    language = "en";

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": "https://mangafire.to/"
    };
    // 图片请求头（独立，避免 JSON 头干扰）
    imgHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://mangafire.to/"
    };

    /** 调用宿主生成的带 vrf 路径，裸连取 JSON */
    async api(action, value, page) {
        const rel = await MangaFireVrf.generate(action, value, page || 1);
        if (!rel) throw new Error("MangaFire 无法生成访问凭证，请稍后重试");
        const url = /^https?:\/\//i.test(rel) ? rel : this.baseUrl + rel;
        const r = await Network.get(url, this.headers);
        if (!r || r.status !== 200 || !r.body) throw new Error("MangaFire 请求失败：HTTP " + (r && r.status));
        let d;
        try { d = JSON.parse(r.body); }
        catch { throw new Error("MangaFire 返回异常数据"); }
        if (d.message && !d.items && !d.data) throw new Error("MangaFire：" + d.message);
        return d;
    }

    /** 标题卡片 -> Comic */
    card(x) {
        if (!x) return null;
        const hid = String(x.hid || "");
        const url = x.url || (hid ? "/title/" + hid + "-" + String(x.slug || "") : "");
        const poster = x.poster || {};
        return new Comic({
            id: url || hid,
            title: String(x.title || ""),
            cover: poster.medium || poster.large || poster.small || "",
            subTitle: x.latestChapter ? ("第 " + x.latestChapter + " 话") : "",
            author: x.author || "",
            tags: []
        });
    }

    search = {
        load: async (keyword, _tags, page) => {
            const d = await this.api("search", keyword, page || 1);
            const comics = (d.items || []).map((x) => this.card(x)).filter(Boolean);
            const meta = d.meta || {};
            return { comics, maxPage: meta.lastPage || meta.last_page || (comics.length ? (page || 1) + 1 : page || 1) };
        }
    };

    /** 发现页：top-titles 榜单不需要 vrf，直连更快。多个榜单维度 */
    _topList(type, days) {
        return { type: "multiPageComicList", load: async (page) => {
            const url = this.baseUrl + "/api/top-titles?type=" + type + "&days=" + days +
                "&limit=30" + (page > 1 ? "&page=" + page : "");
            const r = await Network.get(url, this.headers);
            if (!r || r.status !== 200 || !r.body) throw new Error("MangaFire 榜单请求失败：HTTP " + (r && r.status));
            const d = JSON.parse(r.body || "{}");
            return { comics: (d.items || []).map((x) => this.card(x)).filter(Boolean), maxPage: page + 1 };
        }};
    }
    explore = [
        { title: "今日热门", ...this._topList("trending", 1) },
        { title: "本周热门", ...this._topList("trending", 7) },
        { title: "本月热门", ...this._topList("trending", 30) }
    ];

    bookIdOf(value) {
        const raw = String(value == null ? "" : (value.id || value));
        // 支持 /title/92kk8-naruto、/title/92kk8-naruto/chapter/123、纯 "92kk8"
        const m = raw.match(/\/title\/([^/?#]+)/);
        if (m) return m[1].split("-")[0];
        const plain = raw.replace(/^\/+|\/+$/g, "").split("/")[0];
        return plain.split("-")[0] || plain;
    }

    comic = {
        loadInfo: async (book) => {
            const hid = this.bookIdOf(book);
            if (!hid) throw new Error("MangaFire：无效的书籍地址");
            const d = await this.api("detail", hid);
            const info = d.data || {};
            if (!info.title) throw new Error("作品不存在或已下架");
            // 章节列表（按话数，英文）：取全部页，不再只取最新 20 话。
            // VRF 与查询参数绑定，宿主桥接会一次导航循环点完所有分页并缓存每页 VRF，
            // 因此逐页请求可复用缓存、不会重复启动浏览器。
            let chapters = {};
            const allItems = [];
            try {
                const MAX_PAGES = 60; // 上限 60 页 / 1200 话，防止超长作品拖垮详情
                // 先取第 1 页：宿主桥接会一次导航缓存该书所有分页的 VRF，
                // 之后各页凭证命中磁盘缓存、无需再启动浏览器。
                const first = await this.api("chapters", hid, 1);
                let items = first.items || [];
                for (const c of items) allItems.push(c);
                const meta0 = first.meta || {};
                const lastPage = Math.min(MAX_PAGES, Number(meta0.lastPage) || 1);
                // 其余页并发拉取（限流 6），VRF 已缓存，纯 HTTP 很快
                const rest = [];
                for (let p = 2; p <= lastPage; p++) rest.push(p);
                let idx = 0;
                const workers = Array.from({ length: Math.min(6, rest.length || 1) }, async () => {
                    while (idx < rest.length) {
                        const p = rest[idx++];
                        try {
                            const ch = await this.api("chapters", hid, p);
                            for (const c of (ch.items || [])) allItems.push(c);
                        } catch (e) { /* 单页失败不影响其它页 */ }
                    }
                });
                await Promise.all(workers);
                // 按话数升序输出（框架会识别数字排序）；同一话多版本（正篇/Side Story）按 id 区分保留
                allItems.sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0));
                for (const c of allItems) {
                    // number 才是话数；个别章节没有 number，此时用 name，不把长 id 当话数显示
                    const num = Number(c.number) || 0;
                    const head = (num > 0 && num < 100000) ? ("第 " + num + " 话") : (c.name ? String(c.name) : "章节");
                    const label = head + (c.name && num > 0 ? " " + c.name : "");
                    chapters[String(c.id)] = label;
                }
            } catch { /* 章节失败仍有详情 */ }
            const poster = info.poster || {};
            const langs = (info.languages || []).join("、");
            const tags = [];
            if (info.type) tags.push(info.type.toUpperCase());
            if (info.status) tags.push(info.status);
            if (langs) tags.push("语言:" + langs);
            return new ComicDetails({
                id: hid,
                title: info.title,
                cover: poster.large || poster.medium || poster.small || "",
                url: this.baseUrl + (info.url || "/title/" + hid),
                author: "",
                description: String(info.synopsisHtml || "").replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim(),
                tags: tags,
                chapters: Object.keys(chapters).length ? chapters : null,
                mediaType: "comic"
            });
        },

        loadEp: async (book, chapterPath) => {
            const hid = this.bookIdOf(book);
            const cid = String(chapterPath || "").match(/\d+/)?.[0] || String(chapterPath || "");
            // images action 需要 hid|slug|chapterId，slug 可留空（API 只用 hid + cid）
            const d = await this.api("images", hid + "|" + hid + "|" + cid);
            const data = d.data || {};
            const images = (data.pages || []).map((p) => p.url).filter(Boolean);
            if (!images.length) throw new Error("这一话没有解析到图片");
            return { images };
        },

        onImageLoad: (url) => new ImageLoadingConfig({ url, headers: this.imgHeaders })
    };
}
