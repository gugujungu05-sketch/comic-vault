/**
 * Flame Comics（flamecomics.xyz）· 韩漫英译站，更新极快、热门新漫多（Solo Leveling / Omniscient Reader 等）。
 * Next.js 服务端直出，无需登录。图片在 cdn.flamecomics.xyz，直链可访问。
 * - 发现/搜索：GET /browse 或 /?s=xxx → <a href="/series/{id}"> + <img alt="标题">
 * - 详情：GET /series/{id} → 标题/封面 + /series/{id}/{chapterHash} 章节
 * - 章节图片：GET /series/{id}/{chapterHash} → /uploads/images/series/{id}/{chapterHash}/NNN-XXX.jpg
 */
class FlameComics extends ComicSource {
    name = "Flame Comics 韩漫";
    key = "flamecomics";
    version = "1.0.0";
    minAppVersion = "1.6.0";
    url = "https://flamecomics.xyz";
    baseUrl = "https://flamecomics.xyz";
    mediaType = "comic";
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9"
    };

    async get(url) {
        const r = await Network.get(url, this.headers);
        if (!r || r.status !== 200 || !r.body) throw new Error("Flame Comics 请求失败：HTTP " + (r && r.status));
        return String(r.body);
    }

    decode(s) {
        return String(s == null ? "" : s)
            .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
            .replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCharCode(parseInt(x, 16)))
            .replace(/&(amp|quot|lt|gt|nbsp|apos);/gi, (_, e) => ({ amp: "&", quot: '"', lt: "<", gt: ">", nbsp: " ", apos: "'" })[e.toLowerCase()] || _)
            .trim();
    }

    cardsFrom(html) {
        const out = [];
        const seen = new Set();
        // 卡片：<a href="/series/ID">...<img alt="标题" ... src="/_next/image?url=...">
        // img 属性顺序不固定（alt 常在 src 前），先截取卡片片段再分别抓属性，避免旧正则漏抓。
        const cardRe = /href="\/series\/(\d+)"[\s\S]{0,800}?<img\b([^>]*?)\/?>/gi;
        let m;
        while ((m = cardRe.exec(html))) {
            const id = m[1];
            if (seen.has(id)) continue;
            const attrs = m[2] || "";
            const altM = /\balt="([^"]*)"/i.exec(attrs);
            const srcM = /\b(?:src|data-src)="([^"]+)"/i.exec(attrs);
            let title = this.decode(altM ? altM[1] : "").replace(/\s+cover$/i, "").trim() || "Series " + id;
            let cover = srcM ? String(srcM[1]).replace(/&amp;/g, "&") : "";
            if (/\/_next\/image\?url=/i.test(cover)) {
                try {
                    const u = new URL(cover, this.baseUrl);
                    const real = u.searchParams.get("url");
                    if (real) cover = real;
                } catch { /* 保留原样 */ }
            }
            if (!cover) continue;
            seen.add(id);
            out.push(new Comic({ id, title, cover, tags: [] }));
        }
        return out;
    }

    search = { load: async (keyword, options, page) => {
        keyword = String(keyword || "").trim();
        if (!keyword) return { comics: [], maxPage: page };
        try {
            const html = await this.get(this.baseUrl + "/?s=" + encodeURIComponent(keyword));
            let comics = this.cardsFrom(html);
            // 该站搜索接口常返回首页推荐，做一次标题匹配过滤；无匹配则保留全部（至少能浏览）
            const kw = keyword.toLowerCase();
            const matched = comics.filter((c) => String(c.title).toLowerCase().includes(kw));
            if (matched.length) comics = matched;
            return { comics, maxPage: page + 1 };
        } catch { return { comics: [], maxPage: page }; }
    }};

    explore = [
        { title: "全部漫画", type: "multiPageComicList", load: async (page) => {
            const comics = this.cardsFrom(await this.get(this.baseUrl + "/browse"));
            return { comics, maxPage: 1 };
        }},
        ...[
            ["action", "动作"], ["adventure", "冒险"], ["fantasy", "奇幻"], ["horror", "恐怖"],
            ["martial%20arts", "武侠"], ["monster", "怪物"], ["murim", "武林"], ["regression", "重生"],
            ["shounen", "少年"], ["supernatural", "超自然"], ["survival", "生存"],
        ].map(([slug, label]) => ({
            title: "题材 · " + label,
            type: "multiPageComicList",
            load: async (page) => {
                const comics = this.cardsFrom(await this.get(this.baseUrl + "/genre/" + slug));
                return { comics, maxPage: 1 };
            },
        })),
    ];

    comic = {
        loadInfo: async (book) => {
            const id = String(book == null ? "" : (book.id || book));
            if (!id) throw new Error("缺少书籍 ID");
            const html = await this.get(this.baseUrl + "/series/" + encodeURIComponent(id));
            const t = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
            const title = t ? this.decode(t[1]) : ((book && book.title) || "Flame Comics");
            // 封面：优先原始 CDN 的 cover.png
            let cover = "";
            const cm = html.match(/https:\/\/cdn\.flamecomics\.xyz\/uploads\/images\/series\/\d+\/[^"]*?(?:cover|thumbnail)[^"]*?\.(?:png|jpg|jpeg|webp)/i);
            if (cm) cover = cm[0].replace(/&amp;/g, "&");
            else {
                const im = html.match(/<img[^>]+src="([^"]+)"/i);
                if (im) cover = String(im[1]).replace(/&amp;/g, "&");
            }
            if (/\/_next\/image\?url=/i.test(cover)) {
                try { cover = new URL(cover, this.baseUrl).searchParams.get("url") || cover; } catch { /* 忽略 */ }
            }
            // 章节：/series/{id}/{chapterHash}
            const chapters = {};
            const seen = new Set();
            const re = new RegExp('href="/series/' + id + '/([a-f0-9]{16,})"[^>]*>([\\s\\S]{0,300}?)</a>', "gi");
            let m;
            while ((m = re.exec(html))) {
                const cid = m[1];
                if (seen.has(cid)) continue;
                seen.add(cid);
                const label = this.decode(String(m[2]).replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
                chapters[cid] = label || ("第 " + seen.size + " 话");
            }
            if (!Object.keys(chapters).length) throw new Error("没有找到章节");
            return new ComicDetails({
                id, title, cover, tags: {}, chapters,
                url: this.baseUrl + "/series/" + id
            });
        },
        loadEp: async (comicId, epId) => {
            const html = await this.get(this.baseUrl + "/series/" + encodeURIComponent(comicId) + "/" + encodeURIComponent(epId));
            const imgs = [];
            // 只取该章节目录下的图片：/uploads/images/series/{id}/{epId}/NNN-XXX.jpg
            const re = new RegExp('https://cdn\\.flamecomics\\.xyz/uploads/images/series/' + comicId + '/' + epId + '/[^"\\\\ ]+?\\.(?:jpg|jpeg|png|webp)', "gi");
            let m;
            while ((m = re.exec(html))) {
                const u = m[0];
                if (!imgs.includes(u)) imgs.push(u);
            }
            if (!imgs.length) throw new Error("这一话没有正文图片");
            return { images: imgs };
        },
        onThumbnailLoad: (url) => ({ headers: { "Referer": "https://flamecomics.xyz/", "User-Agent": this.headers["User-Agent"] } })
    };
}
