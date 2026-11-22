/**
 * 再漫画 · 轻小说源（m.zaimanhua.com，App 内嵌 H5 的公开 API）。
 * 官方移动 H5 用 uni-app，接口走 https://m.zaimanhua.com/api/app/v1/novel/*：
 * - 搜索：/app/v1/search/index?keyword=&source=1（source=1 为轻小说）
 * - 推荐：/app/v1/novel/recommend
 * - 详情：/app/v1/novel/detail/{id}（元信息 + volume 卷列表）
 * - 目录：/app/v1/novel/chapter/{id}（卷 -> chapters，含 chapter_id）
 * - 正文：/app/v1/novel/download/chapter?volumeId=&chapterId=（纯文本，可直接读）
 * 账号/签名：网页 H5 无需登录即可读公开章节；带移动端 UA + Referer 即可。
 */
class ZaiNovel extends ComicSource {
    name = "再漫画轻小说";
    key = "zaimanovel";
    version = "1.0.0";
    minAppVersion = "1.6.0";
    url = "https://m.zaimanhua.com";
    baseUrl = "https://m.zaimanhua.com/api";
    mediaType = "novel";
    headers = {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
        "Referer": "https://m.zaimanhua.com/"
    };

    async api(path) {
        const r = await Network.get(this.baseUrl + path, this.headers);
        if (!r || r.status !== 200 || !r.body) throw new Error("再漫画轻小说请求失败：HTTP " + (r && r.status));
        let j;
        try { j = JSON.parse(String(r.body)); } catch (e) { throw new Error("再漫画轻小说返回解析失败"); }
        if (j.errno !== 0) throw new Error(j.errmsg || "再漫画轻小说请求失败");
        return j.data && j.data.data !== undefined ? j.data.data : j.data;
    }

    card(c) {
        const title = String(c.title || c.name || "").trim();
        if (!title) return null;
        let id = "";
        for (const k of ["id", "novel_id", "lnovel_id", "obj_id"]) {
            const v = Number(c[k]);
            if (Number.isFinite(v) && v > 0) { id = String(v); break; }
        }
        if (!id) return null;
        let cover = String(c.cover || "").replace(/^http:\/\//i, "https://");
        const tags = [];
        if (c.types) (Array.isArray(c.types) ? c.types : String(c.types).split(/[\/,，]/)).forEach((t) => { t = String(t).trim(); if (t) tags.push(t); });
        if (c.authors) tags.push(String(c.authors));
        return new Comic({ id, title, cover, tags, description: String(c.introduction || c.description || "") });
    }

    search = { load: async (keyword, options, page) => {
        keyword = String(keyword || "").trim();
        if (!keyword) return { comics: [], maxPage: page };
        try {
            const d = await this.api("/app/v1/search/index?keyword=" + encodeURIComponent(keyword) + "&source=1&page=" + page + "&size=20");
            const list = (d && d.list) || [];
            const comics = list.map((c) => this.card(c)).filter(Boolean);
            return { comics, maxPage: comics.length ? page + 1 : page };
        } catch (e) { return { comics: [], maxPage: page }; }
    }};

    explore = [{ title: "轻小说推荐", type: "multiPageComicList", load: async (page) => {
        const d = await this.api("/app/v1/novel/recommend");
        const out = [];
        const groups = (d && d.recommendList) || [];
        for (const g of groups) for (const c of (g.data || [])) {
            const card = this.card(c);
            if (card && !out.some((x) => x.id === card.id)) out.push(card);
        }
        return { comics: out, maxPage: 1 };
    }}];

    comic = {
        // 逐章正文 EPUB 适配器：online.js 的 buildTextNovelEpub 通用分支会调用这两个方法
        textNovelCatalog: async (bookId) => {
            const info = await this.api("/app/v1/novel/detail/" + encodeURIComponent(bookId));
            const vols = await this.api("/app/v1/novel/chapter/" + encodeURIComponent(bookId));
            const volumes = [];
            for (const v of (Array.isArray(vols) ? vols : [])) {
                const chapters = (v.chapters || []).map((c) => ({ id: String(c.chapter_id), title: String(c.chapter_name || "正文") }));
                volumes.push({ id: String(v.volume_id), title: String(v.volume_name || "卷"), chapters });
            }
            return {
                title: String(info.name || "在线小说"),
                author: String(info.authors || ""),
                cover: String(info.cover || "").replace(/^http:\/\//i, "https://"),
                description: String(info.introduction || ""),
                volumes
            };
        },
        textNovelChapter: async (bookId, chapterId, volumeId) => {
            let url = "/app/v1/novel/download/chapter?chapterId=" + encodeURIComponent(chapterId);
            if (volumeId) url += "&volumeId=" + encodeURIComponent(volumeId);
            const r = await Network.get(this.baseUrl + url, this.headers);
            if (!r || r.status !== 200) return "";
            const text = String(r.body || "");
            // 纯文本转段落 HTML（保留空行分段）
            const paras = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
            return paras.map((p) => "<p>" + p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + "</p>").join("");
        },
        loadInfo: async (book) => {
            const raw = String(book == null ? "" : (book.id || book));
            const m = raw.match(/\d+/);
            const id = m ? m[0] : raw;
            const info = await this.api("/app/v1/novel/detail/" + encodeURIComponent(id));
            if (!info.name) throw new Error("作品不存在或已下架");
            const vols = await this.api("/app/v1/novel/chapter/" + encodeURIComponent(id));
            const chapters = {};
            for (const v of (Array.isArray(vols) ? vols : [])) {
                for (const c of (v.chapters || [])) {
                    const cid = String(c.chapter_id);
                    if (!cid) continue;
                    chapters[cid] = String(c.chapter_name || "正文");
                }
            }
            const tags = {};
            for (const t of (info.types || [])) { const n = String(t).trim(); if (n) (tags["题材"] || (tags["题材"] = [])).push(n); }
            return new ComicDetails({
                id, title: String(info.name),
                cover: String(info.cover || "").replace(/^http:\/\//i, "https://"),
                description: String(info.introduction || ""), author: String(info.authors || ""),
                tags, chapters, url: "https://m.zaimanhua.com/#/pages/qing/detail?id=" + id
            });
        },
        downloadBook: async (book) => ({ textNovel: true, sourceKey: "zaimanovel" }),
        onThumbnailLoad: () => ({ headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://m.zaimanhua.com/" } })
    };
}
