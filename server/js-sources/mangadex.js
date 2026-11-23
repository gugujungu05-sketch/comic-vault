/**
 * MangaDex 源（官方公开 API，纯 JSON，移植自 Ciallo mangadex.kt 的官方 API 通道）。
 * 无需登录：搜索 / 发现 / 详情 / 章节 / 图片全部走 api.mangadex.org。
 * 章节按语言过滤（默认中/英/日），图片走 at-home/server 拿到真实文件名后再拼 CDN 地址。
 * 官方 API 对匿名请求有频率限制，脚本内做轻量串行与退避。
 */
class MangaDex extends ComicSource {
    name = "MangaDex";
    key = "mangadex";
    version = "1.0.0";
    minAppVersion = "1.6.0";
    url = "https://mangadex.org";
    baseUrl = "https://api.mangadex.org";
    mediaType = "comic";
    // MangaDex 官方 API 要求自定义 UA；浏览器 UA 会被 302 到限流页再 403。
    headers = {
        "User-Agent": "ComicVault/1.0 (ComicVault MangaDex source)",
        "Accept": "application/json",
    };
    // 章节语言优先级：中文 → 英文 → 日文；详情页优先展示中文翻译
    langs = ["zh", "zh-Hans", "zh-Hant", "en", "ja"];

    // MangaDex 匿名限流较严：全局串行 + 最小间隔，遇 429 退避重试
    _last = 0;
    _queue = Promise.resolve();
    async api(path, _retry) {
        const run = async () => {
            const wait = 220 - (Date.now() - this._last);
            if (wait > 0) await new Promise((r) => setTimeout(r, wait));
            this._last = Date.now();
            const r = await Network.get(this.baseUrl + path, this.headers);
            if (!r || !r.body) throw new Error("MangaDex 无响应");
            if (r.status === 429) {
                if (!_retry) {
                    await new Promise((res) => setTimeout(res, 2500));
                    return this.api(path, true);
                }
                throw new Error("MangaDex 请求过于频繁，请稍后重试");
            }
            if (r.status !== 200) throw new Error("MangaDex 请求失败：HTTP " + r.status);
            let j; try { j = JSON.parse(r.body); } catch { throw new Error("MangaDex 返回解析失败"); }
            return j;
        };
        // 串行化：把本次请求挂到队列尾部
        const result = this._queue.then(run, run);
        this._queue = result.catch(() => {});
        return result;
    }

    /** 取标题：优先中/英，其次任意语言 */
    titleOf(attrs) {
        const t = (attrs && attrs.title) || {};
        return t["zh"] || t["zh-Hans"] || t["en"] || t["ja"] || Object.values(t)[0] || "未命名";
    }

    /** 从 relationships 找封面文件名 */
    coverOf(rels) {
        const c = (rels || []).find((x) => x.type === "cover_art");
        const file = c && c.attributes && c.attributes.fileName;
        return file ? "https://uploads.mangadex.org/covers/" + c.id + "/" + file + ".512.jpg" : "";
    }

    card(m) {
        if (!m || !m.id) return null;
        const a = m.attributes || {};
        const tags = (a.tags || []).map((t) => (t.attributes && t.attributes.name) || {})
            .map((n) => n["zh"] || n["en"] || Object.values(n)[0]).filter(Boolean).slice(0, 6);
        const st = a.status ? { ongoing: "连载", completed: "完结", hiatus: "休刊", cancelled: "弃坑" }[a.status] : null;
        return new Comic({
            id: m.id,
            title: this.titleOf(a),
            cover: this.coverOf(m.relationships),
            tags,
            status: st || null,
            description: (a.description && (a.description["zh"] || a.description["en"])) || "",
            author: (m.relationships || []).filter((x) => x.type === "author").map((x) => x.attributes && x.attributes.name).filter(Boolean).join("、"),
        });
    }

    explore = [
        {
            title: "MangaDex · 热门",
            type: "multiPageComicList",
            load: async (page) => {
                const offset = Math.max(0, (Number(page) - 1) * 20);
                const j = await this.api("/manga?limit=20&offset=" + offset + "&includes[]=cover_art&order[followedCount]=desc&contentRating[]=safe&contentRating[]=suggestive");
                const comics = (j.data || []).map((m) => this.card(m)).filter(Boolean);
                const maxPage = Math.max(1, Math.ceil((j.total || 0) / 20));
                return { comics, maxPage };
            },
        },
        {
            title: "MangaDex · 最新更新",
            type: "multiPageComicList",
            load: async (page) => {
                const offset = Math.max(0, (Number(page) - 1) * 20);
                const j = await this.api("/manga?limit=20&offset=" + offset + "&includes[]=cover_art&order[updatedAt]=desc&contentRating[]=safe&contentRating[]=suggestive");
                const comics = (j.data || []).map((m) => this.card(m)).filter(Boolean);
                const maxPage = Math.max(1, Math.ceil((j.total || 0) / 20));
                return { comics, maxPage };
            },
        },
    ];

    search = {
        load: async (keyword, options, page) => {
            keyword = String(keyword || "").trim();
            if (!keyword) return { comics: [], maxPage: page };
            const offset = Math.max(0, (Number(page) - 1) * 20);
            const j = await this.api("/manga?title=" + encodeURIComponent(keyword) + "&limit=20&offset=" + offset + "&includes[]=cover_art");
            const comics = (j.data || []).map((m) => this.card(m)).filter(Boolean);
            const maxPage = Math.max(page, Math.ceil((j.total || 0) / 20));
            return { comics, maxPage };
        },
    };

    comic = {
        loadInfo: async (id) => {
            const j = await this.api("/manga/" + encodeURIComponent(id) + "?includes[]=cover_art&includes[]=author");
            const m = j.data || {};
            const a = m.attributes || {};
            // 拉全部章节（按章号升序），按语言分组命名
            const feed = await this.api("/manga/" + encodeURIComponent(id) + "/feed?limit=500&includes[]=user&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica");
            const chapters = {};
            const langOrder = ["zh", "zh-Hans", "zh-Hant", "en", "ja"];
            const list = (feed.data || []).slice().sort((a, b) => {
                const la = (a.attributes || {}).translatedLanguage || "en";
                const lb = (b.attributes || {}).translatedLanguage || "en";
                const ia = langOrder.indexOf(la), ib = langOrder.indexOf(lb);
                const pa = ia < 0 ? 99 : ia, pb = ib < 0 ? 99 : ib;
                if (pa !== pb) return pa - pb; // 中文排前
                const na = Number((a.attributes || {}).chapter) || 0;
                const nb = Number((b.attributes || {}).chapter) || 0;
                return na - nb; // 同语言按话数升序
            });
            for (const c of list) {
                const at = c.attributes || {};
                // feed 里混有已删除/外链章节（pages=0 或 externalUrl），点进去 at-home 会 404
                // （表现为「加载不出来」）。只保留本站有图片的正经章节。
                if (at.externalUrl || !(Number(at.pages) > 0)) continue;
                const lang = at.translatedLanguage || "en";
                const num = at.chapter != null ? String(at.chapter) : "";
                const title = at.title || "";
                let name = (num ? "第 " + num + " 话" : "章节") + (title ? " " + title : "");
                const langTag = { zh: "中", "zh-Hans": "简", "zh-Hant": "繁", en: "英", ja: "日" }[lang] || lang;
                name = "[" + langTag + "] " + name;
                // 同话多语言用 id 区分，全部保留
                chapters[c.id] = name;
            }
            return new ComicDetails({
                id: id,
                title: this.titleOf(a),
                cover: this.coverOf(m.relationships),
                description: (a.description && (a.description["zh"] || a.description["en"])) || "",
                tags: {},
                chapters,
                url: "https://mangadex.org/title/" + id,
            });
        },
        loadEp: async (comicId, epId) => {
            // at-home 给出 baseUrl / chapter.hash / data[] 真实文件名
            const j = await this.api("/at-home/server/" + encodeURIComponent(epId));
            const c = j.chapter || {};
            const base = String(j.baseUrl || "").replace(/\/+$/, "");
            const hash = c.hash || "";
            // 优先原图 data，缺失时用 data-saver
            const files = (c.data && c.data.length ? c.data : c.dataSaver) || [];
            const saver = !(c.data && c.data.length);
            const imgs = files.map((f) => base + "/" + (saver ? "data-saver" : "data") + "/" + hash + "/" + f);
            return { images: imgs };
        },
        onImageLoad: (url) => new ImageLoadingConfig({ url: url, headers: { "Referer": "https://mangadex.org/" } }),
    };
}
