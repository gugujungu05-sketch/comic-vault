/**
 * カドコミ / Comic Walker（comic-walker.com）· KADOKAWA 集英社旗下日本正版免费漫画站。
 * 用户书签 third 图里的日文源；VeneraX 里标 1.0.2。
 * 内容极全、更新快、日本原版漫画最全的合法站之一。
 *
 * 重要：该站图片使用 XOR DRM + 短时效签名（viewer API 的 drmMode/drmHash），
 * 属于正版保护。本源只提供「搜索 / 发现 / 详情 / 章节目录 / 封面」信息，
 * 正文阅读请跳转原站（浏览器内已登录时可正常看），不做 DRM 解密盗图。
 *
 * API（官方前端同款，稳定）：
 *  - 搜索：GET /api/search/keywords?word=xxx&limit=N  → { pagination, result:[{code,title,thumbnail}] }
 *  - 榜单：GET /api/ranking?... / /api/search/initial (五十音全部作品)
 *  - 详情：GET /api/contents/details/work?workCode=XXX → { work, comics:{total,result:[{episodes:[]}]} }
 *  - 章节：work.comics[].episodes[]（episode.code / title / thumbnail）
 */
class KadoComi extends ComicSource {
    name = "カドコミ ComicWalker（日本正版）";
    key = "kadocomi";
    version = "1.0.0";
    minAppVersion = "1.6.0";
    url = "https://comic-walker.com";
    baseUrl = "https://comic-walker.com";
    mediaType = "comic";
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Referer": "https://comic-walker.com/"
    };

    async api(path) {
        const r = await Network.get(this.baseUrl + path, this.headers);
        if (!r || r.status !== 200 || !r.body) throw new Error("カドコミ请求失败：" + (r && r.status));
        const text = String(r.body);
        try { return JSON.parse(text); }
        catch { throw new Error("カドコミ返回非 JSON"); }
    }

    abs(u) {
        if (!u) return "";
        u = String(u).replace(/&amp;/g, "&");
        if (/^\/\//.test(u)) return "https:" + u;
        if (/^\//.test(u)) return this.baseUrl + u;
        if (/^https?:\/\//i.test(u)) return u;
        return this.baseUrl + "/" + u;
    }

    comicFromItem(x) {
        const code = String(x.code || x.workCode || "");
        if (!code) return null;
        return new Comic({
            id: code,
            title: String(x.title || x.name || code),
            cover: this.abs(x.thumbnail || x.thumbnailUrl || x.bookCover || ""),
            latestChapter: x.latestEpisodeTitle || x.updateText || null,
            tags: []
        });
    }

    search = { load: async (keyword, _options, page) => {
        const kw = String(keyword || "").trim();
        if (!kw) return { comics: [], maxPage: page };
        try {
            const j = await this.api("/api/search/keywords?word=" + encodeURIComponent(kw) + "&limit=40" + (page > 1 ? "&offset=" + ((page - 1) * 40) : ""));
            const arr = (j.result || j.items || []).map((x) => this.comicFromItem(x)).filter(Boolean);
            const total = (j.pagination && j.pagination.total) || 0;
            return { comics: arr, maxPage: total > page * 40 ? page + 1 : page };
        } catch { return { comics: [], maxPage: page }; }
    }};

    explore = [
        { title: "カドコミ · 五十音全作品", type: "multiPageComicList", load: async (page) => {
            try {
                const j = await this.api("/api/search/initial");
                const arr = [];
                (Array.isArray(j) ? j : []).forEach((g) => (g.items || []).forEach((x) => {
                    const c = this.comicFromItem(x);
                    if (c && !arr.some((e) => e.id === c.id)) arr.push(c);
                }));
                return { comics: arr, maxPage: page };
            } catch { return { comics: [], maxPage: page }; }
        }},
    ];

    comic = {
        loadInfo: async (book) => {
            const id = String(book == null ? "" : (book.id || book));
            if (!id) throw new Error("缺少作品 code");
            const j = await this.api("/api/contents/details/work?workCode=" + encodeURIComponent(id));
            const w = j.work || {};
            const title = String(w.title || id);
            const cover = this.abs(w.thumbnail || w.originalThumbnail || w.bookCover || "");
            const author = (w.authors || []).map((a) => a.name).filter(Boolean).join("、");
            const description = String(w.summary || "");
            const tags = {};
            const tg = [];
            if (w.genre && w.genre.name) tg.push(w.genre.name);
            (w.tags || []).forEach((t) => { if (t && t.name) tg.push(t.name); });
            if (tg.length) tags["题材"] = tg;

            // 章节：comics[].episodes[]
            const chapters = {};
            (j.comics && j.comics.result ? j.comics.result : []).forEach((c) => {
                (c.episodes || []).forEach((e) => {
                    const code = String(e.code || e.id || "");
                    if (!code) return;
                    chapters[code] = String(e.title || ("第 " + (e.internal && e.internal.episodeNo || "") + " 话"));
                });
            });
            const seriesUrl = this.baseUrl + "/detail/" + encodeURIComponent(id);
            return new ComicDetails({
                id, title, cover, author, description,
                tags: Object.keys(tags).length ? tags : {},
                chapters,
                url: seriesUrl,
                // 标记需要原站阅读（供前端展示提示）
                notice: "カドコミ为正版 DRM 站，正文需在原站登录阅读。点击章节将跳转原站。"
            });
        },
        // 正版 DRM：不提供盗图正文，抛出明确提示，避免前端白屏/花屏困惑
        loadEp: async (_comicId, epId) => {
            const id = String(_comicId == null ? "" : (_comicId.id || _comicId));
            const code = String(epId || "").replace(/^\//, "");
            const url = this.baseUrl + "/detail/" + encodeURIComponent(id) + "/episodes/" + encodeURIComponent(code);
            throw new Error("カドコミ（" + url + "）图片受正版 DRM 保护，请在浏览器打开原站登录后阅读。本源提供搜索/详情/目录。");
        },
        onThumbnailLoad: (url) => ({ headers: { "Referer": this.baseUrl + "/", "User-Agent": this.headers["User-Agent"] } })
    };
}
