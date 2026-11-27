/**
 * 漫小肆（jjmh.cc）· 韩漫中文站，更新快、内容多（源自 Venera 的 mxs.js，适配到本项目）。
 * 服务端直出 HTML，无登录。图片在 /static/upload/book/{id}/ 或备用 CDN，直链可访问。
 * - 搜索：GET /search?keyword=xxx
 * - 发现：GET / 、/update?page=N 、/rank
 * - 详情：GET /book/{id} → .info + #detail-list-select 章节
 * - 章节图片：GET /chapter/{epId} → img.lazy[data-original]
 */
class ManXiaoSi extends ComicSource {
    name = "漫小肆 韩漫";
    key = "manxiaosi";
    version = "1.0.0";
    minAppVersion = "1.6.0";
    url = "https://www.jjmh.cc";
    baseUrl = "https://www.jjmh.cc";
    mediaType = "comic";
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept-Language": "zh-CN,zh;q=0.9"
    };

    async get(url) {
        const r = await Network.get(url, this.headers);
        if (!r || r.status !== 200 || !r.body) throw new Error("漫小肆 请求失败：HTTP " + (r && r.status));
        return String(r.body);
    }

    /** 解析 .mh-item 卡片（首页/搜索/更新/分类通用） */
    cardsFrom(html) {
        const out = [];
        const seen = new Set();
        try {
            const doc = new HtmlDocument(html);
            const items = doc.querySelectorAll(".mh-item") || [];
            for (const item of items) {
                const a = item.querySelector("a[href^='/book/']");
                if (!a || !a.attributes.href) continue;
                const id = String(a.attributes.href).split("/").pop();
                if (!id || seen.has(id)) continue;
                const titleNode = item.querySelector("h2.title a") || item.querySelector(".title a");
                let title = titleNode && titleNode.text ? String(titleNode.text).trim() : "";
                if (!title) continue;
                seen.add(id);
                // 封面：优先卡片背景图（含备用 CDN 域名），否则用默认路径
                let cover = "";
                const coverNode = item.querySelector(".mh-cover");
                const style = coverNode && coverNode.attributes ? String(coverNode.attributes.style || "") : "";
                const bg = style.match(/url\(([^)]+)\)/);
                if (bg) cover = bg[1].replace(/['"]/g, "").trim();
                if (!cover) cover = this.baseUrl + "/static/upload/book/" + id + "/cover.jpg";
                let desc = "";
                const ch = item.querySelector(".chapter");
                if (ch && ch.text) desc = String(ch.text).replace(/^更新/, "").replace(/\s+/g, " ").trim();
                out.push(new Comic({ id, title, cover, description: desc, tags: [] }));
            }
            doc.dispose();
        } catch { /* 忽略 */ }
        return out;
    }

    search = { load: async (keyword, options, page) => {
        keyword = String(keyword || "").trim();
        if (!keyword) return { comics: [], maxPage: page };
        try {
            const html = await this.get(this.baseUrl + "/search?keyword=" + encodeURIComponent(keyword));
            return { comics: this.cardsFrom(html), maxPage: page };
        } catch { return { comics: [], maxPage: page }; }
    }};

    explore = [
        { title: "漫小肆 · 最近更新", type: "multiPageComicList", load: async (page) => {
            const url = page > 1 ? this.baseUrl + "/update?page=" + page : this.baseUrl + "/";
            return { comics: this.cardsFrom(await this.get(url)), maxPage: page + 1 };
        }},
        { title: "漫小肆 · 排行榜", type: "multiPageComicList", load: async (page) => {
            return { comics: this.cardsFrom(await this.get(this.baseUrl + "/rank")), maxPage: 1 };
        }},
    ];

    comic = {
        loadInfo: async (book) => {
            const id = String(book == null ? "" : (book.id || book));
            if (!id) throw new Error("缺少书籍 ID");
            const url = this.baseUrl + "/book/" + encodeURIComponent(id);
            const html = await this.get(url);
            const doc = new HtmlDocument(html);
            let title = "", author = "", desc = "";
            const tags = [];
            try {
                const h1 = doc.querySelector(".info h1");
                if (h1 && h1.text) title = String(h1.text).trim();
                // 副标题：别名/作者
                for (const el of (doc.querySelectorAll(".info .subtitle") || [])) {
                    const t = el.text || "";
                    if (t.includes("作者：") && !author) author = t.replace("作者：", "").trim();
                }
                const content = doc.querySelector(".info .content");
                if (content && content.text) desc = String(content.text).trim();
                // 标签：.info .tip a[href*=tag=]
                for (const el of (doc.querySelectorAll(".info .tip a") || [])) {
                    const href = el.attributes && el.attributes.href ? String(el.attributes.href) : "";
                    const t = el.text ? String(el.text).trim() : "";
                    if (t && /tag=|label/i.test(href)) tags.push(t);
                }
            } finally { doc.dispose(); }
            // 封面
            const cm = html.match(/https?:\/\/[^"'\s]+\/static\/upload\/book\/\d+\/cover\.jpg/i);
            const cover = cm ? cm[0] : this.baseUrl + "/static/upload/book/" + id + "/cover.jpg";
            // 章节：#detail-list-select li a
            const chapters = {};
            const seen = new Set();
            const re = /href="\/chapter\/(\d+)"[^>]*>([\s\S]{0,200}?)<\/a>/gi;
            let m;
            while ((m = re.exec(html))) {
                const cid = m[1];
                if (seen.has(cid)) continue;
                seen.add(cid);
                const label = String(m[2]).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
                chapters[cid] = label || ("第 " + seen.size + " 话");
            }
            if (!Object.keys(chapters).length) throw new Error("没有找到章节");
            return new ComicDetails({
                id, title: title || (book && book.title) || "漫小肆", cover, author, description: desc,
                tags: tags.length ? { "题材": tags.slice(0, 20) } : {}, chapters, url
            });
        },
        loadEp: async (comicId, epId) => {
            const html = await this.get(this.baseUrl + "/chapter/" + encodeURIComponent(epId));
            const imgs = [];
            // img.lazy[data-original]，站点常把域名替换为备用图床
            for (const m of html.matchAll(/<img[^>]+data-original="([^"]+)"[^>]*class="[^"]*lazy[^"]*"[^>]*>/gi)) {
                let u = String(m[1]).replace(/&amp;/g, "&");
                if (/^\/\//.test(u)) u = "https:" + u;
                if (/^\//.test(u)) u = this.baseUrl + u;
                if (/^https?:\/\//i.test(u) && !imgs.includes(u)) imgs.push(u);
            }
            // 兼容 class 在前的写法
            if (!imgs.length) {
                for (const m of html.matchAll(/<img[^>]+class="[^"]*lazy[^"]*"[^>]+data-original="([^"]+)"/gi)) {
                    let u = String(m[1]).replace(/&amp;/g, "&");
                    if (/^\/\//.test(u)) u = "https:" + u;
                    if (/^\//.test(u)) u = this.baseUrl + u;
                    if (/^https?:\/\//i.test(u) && !imgs.includes(u)) imgs.push(u);
                }
            }
            if (!imgs.length) throw new Error("这一话没有正文图片");
            return { images: imgs };
        },
        onThumbnailLoad: (url) => ({ headers: { "Referer": "https://www.jjmh.cc/", "User-Agent": this.headers["User-Agent"] } })
    };
}
