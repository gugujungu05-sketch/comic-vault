/**
 * 再漫画源（漫画，www/manhua.zaimanhua.com）。官方 Nuxt 站点，走公开 JSON API：
 * - 搜索：/app/v1/search/index?keyword=&source=0（source=0 漫画，1 轻小说）
 * - 发现/更新：/api/v1/comic2/index、/api/v1/comic2/update_list
 * - 详情：/api/v1/comic2/comic/detail?id={数字}（章节按卷分组 chapterList[].data[]）
 * - 图片：/api/v1/comic2/chapter/detail?comic_id=&chapter_id=（page_url 数组）
 * 请求带 Platform: pc 头；图片 CDN images.zaimanhua.com 直连即可。
 */
class Zaimanhua extends ComicSource {
    name = "再漫画";
    key = "zaimanhua";
    version = "1.0.0";
    minAppVersion = "1.6.0";
    url = "https://www.zaimanhua.com";
    baseUrl = "https://manhua.zaimanhua.com";
    mediaType = "comic";
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Platform": "pc",
        "Referer": "https://manhua.zaimanhua.com/"
    };

    ts() { return Date.now().toString(); }
    async api(path) {
        const sep = path.indexOf("?") >= 0 ? "&" : "?";
        const url = this.baseUrl + path + sep + "channel=1&app_name=&version=&timestamp=" + this.ts() + "&uid=1";
        const r = await Network.get(url, this.headers);
        if (!r || r.status !== 200 || !r.body) throw new Error("再漫画请求失败：HTTP " + (r && r.status));
        let j;
        try { j = JSON.parse(String(r.body)); } catch (e) { throw new Error("再漫画返回解析失败"); }
        if (j.errno !== 0) throw new Error(j.errmsg || "再漫画请求失败");
        return j.data;
    }
    coverOf(c) { return String(c.cover || "").replace(/^http:\/\//i, "https://"); }
    card(c) {
        const title = String(c.title || c.name || "").trim();
        if (!title) return null;
        // 各接口 id 字段名/有效性不一（有的 comic_id=0 但 id 有效），取第一个正整数
        let id = "";
        for (const k of ["comic_id", "id", "obj_id", "lnovel_id", "novel_id"]) {
            const v = Number(c[k]);
            if (Number.isFinite(v) && v > 0) { id = String(v); break; }
        }
        if (!id) return null;
        const tags = [];
        if (c.types) String(c.types).split(/[\/,，]/).forEach((t) => { t = t.trim(); if (t) tags.push(t); });
        if (c.authors) tags.push(String(c.authors));
        return new Comic({ id, title, cover: this.coverOf(c), tags, description: String(c.description || c.sub_title || "") });
    }

    search = { load: async (keyword, options, page) => {
        keyword = String(keyword || "").trim();
        if (!keyword) return { comics: [], maxPage: page };
        try {
            const d = await this.api("/app/v1/search/index?keyword=" + encodeURIComponent(keyword) + "&source=0&page=" + page + "&size=20");
            const list = (d && d.list) || [];
            const comics = list.map((c) => this.card(c)).filter(Boolean);
            return { comics, maxPage: comics.length ? page + 1 : page };
        } catch (e) { return { comics: [], maxPage: page }; }
    }};

    explore = [{ title: "最近更新", type: "multiPageComicList", load: async (page) => {
        const d = await this.api("/api/v1/comic2/update_list?status=all&theme=all&zone=all&cate=all&firstLetter=all&sortType=default&page=" + page + "&size=20");
        const list = (d && (d.list || (d.data && d.data.list))) || [];
        const comics = list.map((c) => this.card(c)).filter(Boolean);
        return { comics, maxPage: comics.length ? page + 1 : page };
    }}];

    category = {
        title: "再漫画分类",
        parts: [{
            name: "题材", type: "fixed",
            categories: ["全部", "热血", "恋爱", "奇幻", "冒险", "校园", "悬疑", "搞笑", "都市", "科幻", "后宫", "战斗"],
            itemType: "category",
            categoryParams: ["", "热血", "恋爱", "奇幻", "冒险", "校园", "悬疑", "搞笑", "都市", "科幻", "后宫", "战斗"]
        }],
        enableRankingPage: false
    };
    categoryComics = { load: async (category, param, options, page) => {
        const theme = String(param || "");
        const d = await this.api("/api/v1/comic2/update_list?status=all&theme=" + encodeURIComponent(theme) + "&zone=all&cate=all&firstLetter=all&sortType=default&page=" + page + "&size=20");
        const list = (d && (d.list || (d.data && d.data.list))) || [];
        const comics = list.map((c) => this.card(c)).filter(Boolean);
        return { comics, maxPage: comics.length ? page + 1 : page };
    }};

    comic = {
        loadInfo: async (book) => {
            const raw = String(book == null ? "" : (book.id || book));
            const m = raw.match(/\d+/);
            const id = m ? m[0] : raw;
            const d = await this.api("/api/v1/comic2/comic/detail?id=" + encodeURIComponent(id));
            const info = (d && d.comicInfo) || {};
            if (!info.title) throw new Error("作品不存在或已下架");
            const chapters = {};
            const groups = info.chapterList || [];
            for (const g of groups) {
                for (const ch of (g.data || [])) {
                    const cid = String(ch.chapter_id);
                    if (!cid) continue;
                    chapters[cid] = String(ch.chapter_title || "第" + cid + "话");
                }
            }
            const tags = {};
            const collect = (arr) => { for (const t of (arr || [])) { const n = String(t.tagName || t.name || "").trim(); if (n) (tags["题材"] || (tags["题材"] = [])).push(n); } };
            collect(info.cateTagList); collect(info.themeTagList); collect(info.zoneTagList); collect(info.statusTagList);
            if (info.authorsTagList) collect(info.authorsTagList);
            const author = Array.isArray(info.authorsTagList) && info.authorsTagList.length ? String(info.authorsTagList[0].tagName || "") : "";
            return new ComicDetails({
                id, title: String(info.title), cover: this.coverOf(info),
                description: String(info.description || ""), author, tags, chapters,
                url: "https://www.zaimanhua.com/details/" + id
            });
        },
        loadEp: async (book, chapterPath) => {
            const bookRaw = String(book == null ? "" : (book.id || book));
            const bm = bookRaw.match(/\d+/);
            const comicId = bm ? bm[0] : bookRaw;
            const cid = String(chapterPath || "");
            const d = await this.api("/api/v1/comic2/chapter/detail?comic_id=" + encodeURIComponent(comicId) + "&chapter_id=" + encodeURIComponent(cid));
            const info = (d && d.chapterInfo) || {};
            const arr = info.page_url_hd && info.page_url_hd.length ? info.page_url_hd : (info.page_url || []);
            const imgs = arr.map((u) => String(u)).filter((u) => /^https?:\/\//i.test(u)).map((u) => u.replace(/^http:\/\//i, "https://"));
            if (!imgs.length) throw new Error("该章节没有解析到图片，可能已下架或需要登录");
            return imgs;
        },
        onImageLoad: () => ({ headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://manhua.zaimanhua.com/" } }),
        onThumbnailLoad: () => ({ headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://manhua.zaimanhua.com/" } })
    };
}
