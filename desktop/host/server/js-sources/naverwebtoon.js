/**
 * NAVER WEBTOON（m.comic.naver.com）· 韩国官方漫画平台，韩文生肉。
 * 无需登录可看大量免费章节（付费/提前看章节会跳过）。
 * - 发现/榜单：GET /webtoon/weekday（按星期分组，含全部作品）
 * - 详情/目录：GET /webtoon/list?titleId=ID
 * - 章节图片：GET /webtoon/detail?titleId=ID&no=N，取 <img data-src="...">
 * 图片走 image-comic.pstatic.net，需带 Referer: https://m.comic.naver.com/
 */
class NaverWebtoon extends ComicSource {
    name = "NAVER 韩漫生肉";
    key = "naverwebtoon";
    version = "1.0.0";
    minAppVersion = "1.6.0";
    url = "https://m.comic.naver.com";
    baseUrl = "https://m.comic.naver.com";
    mediaType = "comic";
    headers = {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
        "Accept-Language": "ko-KR,ko;q=0.9"
    };

    async get(url) {
        const r = await Network.get(url, this.headers);
        if (!r || r.status !== 200 || !r.body) throw new Error("NAVER 请求失败：HTTP " + (r && r.status));
        return String(r.body);
    }

    cardOf(id, title, cover, author) {
        if (!id || !title) return null;
        return new Comic({ id, title, cover: cover || "", author: author || "", tags: ["韩漫", "韩文生肉"] });
    }

    /** 从榜单/列表页解析卡片 */
    cardsFrom(html) {
        const doc = new HtmlDocument(html);
        const out = [];
        try {
            const links = doc.querySelectorAll('a[href*="titleId="]') || [];
            const seen = new Set();
            for (const a of links) {
                const href = String(a.attributes.href || "");
                const m = href.match(/titleId=(\d+)/i);
                if (!m) continue;
                const id = m[1];
                if (seen.has(id)) continue;
                const strong = a.querySelector("strong.title") || a.querySelector(".title_text");
                const title = strong && strong.text ? String(strong.text).trim() : "";
                if (!title || /페이지 없음/i.test(title)) continue;
                let cover = "", author = "";
                const img = a.querySelector("img");
                if (img && img.attributes.src) cover = String(img.attributes.src);
                const au = a.querySelector(".author");
                if (au && au.text) author = String(au.text).trim();
                seen.add(id);
                const c = this.cardOf(id, title, cover, author);
                if (c) out.push(c);
            }
        } finally { doc.dispose(); }
        return out;
    }

    /** Naver 无关键词搜索接口，用已缓存榜单做本地过滤 */
    _all = null;
    _allAt = 0;
    async allComics() {
        if (this._all && Date.now() - this._allAt < 30 * 60 * 1000) return this._all;
        const html = await this.get(this.baseUrl + "/webtoon/weekday");
        this._all = this.cardsFrom(html);
        this._allAt = Date.now();
        return this._all;
    }

    search = { load: async (keyword, options, page) => {
        keyword = String(keyword || "").trim().toLowerCase();
        if (!keyword) return { comics: [], maxPage: page };
        try {
            const all = await this.allComics();
            // 韩文书名多为韩文，用户输入中文/英文时通常搜不到；提示直接看榜单
            const matched = all.filter((c) => String(c.title || "").toLowerCase().includes(keyword));
            return { comics: matched, maxPage: 1 };
        } catch (e) { return { comics: [], maxPage: page }; }
    }};

    explore = [{ title: "NAVER · 韩漫排行榜", type: "multiPageComicList", load: async (page) => {
        const all = await this.allComics();
        return { comics: all, maxPage: 1 };
    }}];

    comic = {
        loadInfo: async (book) => {
            const id = String(book == null ? "" : (book.id || book));
            const html = await this.get(this.baseUrl + "/webtoon/list?titleId=" + encodeURIComponent(id));
            const doc = new HtmlDocument(html);
            let title = "", cover = "", author = "", desc = "";
            try {
                const t = doc.querySelector("h3.title") || doc.querySelector(".title") || doc.querySelector("h1");
                if (t && t.text) title = String(t.text).trim();
                const img = doc.querySelector(".thumb img") || doc.querySelector(".thumbnail img");
                if (img && img.attributes.src) cover = String(img.attributes.src);
                const au = doc.querySelector(".author");
                if (au && au.text) author = String(au.text).trim();
                const d = doc.querySelector(".desc") || doc.querySelector(".summary");
                if (d && d.text) desc = String(d.text).trim();
            } finally { doc.dispose(); }
            // 章节：detail?titleId=ID&no=N
            const chapters = {};
            const eps = [...html.matchAll(/href="[^"]*detail\?titleId=\d+&amp;no=(\d+)[^"]*"/gi)];
            for (const m of eps) chapters[m[1]] = "第 " + m[1] + " 话";
            if (!Object.keys(chapters).length) {
                const nums = [...html.matchAll(/no=(\d+)/gi)].map((m) => m[1]);
                for (const n of [...new Set(nums)]) chapters[n] = "第 " + n + " 话";
            }
            return new ComicDetails({
                id, title: title || "NAVER WEBTOON", cover, author, description: desc,
                tags: { "题材": ["韩漫", "韩文生肉"] }, chapters,
                url: this.baseUrl + "/webtoon/list?titleId=" + id
            });
        },
        loadEp: async (comicId, epId) => {
            const url = this.baseUrl + "/webtoon/detail?titleId=" + encodeURIComponent(comicId) + "&no=" + encodeURIComponent(epId);
            const html = await this.get(url);
            // 正文图在 <img data-src="...image-comic.pstatic.net/mobilewebimg/...">
            const imgs = [...html.matchAll(/data-src="(https:\/\/image-comic\.pstatic\.net\/mobilewebimg\/[^"]+)"/gi)].map((m) => m[1]);
            if (!imgs.length) throw new Error("这一话没有正文图片，可能是付费章节或已下架");
            return { images: [...new Set(imgs)] };
        },
        onImageLoad: (url) => new ImageLoadingConfig({
            url,
            headers: { "Referer": "https://m.comic.naver.com/", "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1" }
        }),
        onThumbnailLoad: (url) => ({ headers: { "Referer": "https://m.comic.naver.com/", "User-Agent": "Mozilla/5.0" } })
    };
}
