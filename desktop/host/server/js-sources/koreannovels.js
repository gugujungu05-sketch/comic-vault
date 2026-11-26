/**
 * Korean Novels（koreannovels.com）· 韩国网文英文译站。
 * 站点是 WordPress，每部作品 = 一个 category，章节 = posts：
 * - 书籍列表：GET /wp-json/wp/v2/categories?per_page=100&orderby=count&order=desc
 * - 搜索书：在本地已缓存的分类里按名字过滤（分类总数有限，一次拉取后缓存）
 * - 章节列表：GET /wp-json/wp/v2/posts?categories={catId}&per_page=100&orderby=id&order=asc&_fields=...
 * - 章节正文：GET /wp-json/wp/v2/posts/{postId}?_fields=content ... 取 content.rendered
 * 无需登录，免费阅读，正文走在线 EPUB 通道（textNovelCatalog / textNovelChapter）。
 */
class KoreanNovels extends ComicSource {
    name = "Korean Novels";
    key = "koreannovels";
    version = "1.0.0";
    minAppVersion = "1.6.0";
    url = "https://www.koreannovels.com";
    baseUrl = "https://www.koreannovels.com/wp-json/wp/v2";
    mediaType = "novel";
    textNovel = true;
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept": "application/json"
    };

    _cats = null;
    _catsAt = 0;

    async api(path) {
        const r = await Network.get(this.baseUrl + path, this.headers);
        if (!r || r.status !== 200 || !r.body) throw new Error("Korean Novels 请求失败：HTTP " + (r && r.status));
        let j;
        try { j = JSON.parse(String(r.body)); } catch (e) { throw new Error("Korean Novels 返回解析失败"); }
        return j;
    }

    /** 全部作品分类（每本书一个 category），缓存 30 分钟 */
    async categories() {
        if (this._cats && Date.now() - this._catsAt < 30 * 60 * 1000) return this._cats;
        let all = [], page = 1;
        for (;;) {
            const batch = await this.api("/categories?per_page=100&page=" + page + "&orderby=count&order=desc&_fields=id,name,count,description");
            if (!Array.isArray(batch) || !batch.length) break;
            all = all.concat(batch);
            if (batch.length < 100) break;
            page++;
            if (page > 10) break;
        }
        this._cats = all.filter((c) => Number(c.count) > 0 && c.id !== 3); // 3 = All Stories 聚合分类
        this._catsAt = Date.now();
        return this._cats;
    }

    card(c) {
        const title = String(c.name || "").trim();
        if (!title) return null;
        return new Comic({
            id: String(c.id),
            title,
            cover: "",
            tags: ["韩国网文", "英译"],
            description: String(c.description || "").replace(/<[^>]+>/g, "").trim()
        });
    }

    search = { load: async (keyword, options, page) => {
        keyword = String(keyword || "").trim().toLowerCase();
        if (!keyword) return { comics: [], maxPage: page };
        const cats = await this.categories();
        const matched = cats.filter((c) => String(c.name || "").toLowerCase().includes(keyword));
        const comics = matched.map((c) => this.card(c)).filter(Boolean);
        return { comics, maxPage: 1 };
    }};

    explore = [{ title: "Korean Novels · 热门作品", type: "multiPageComicList", load: async (page) => {
        const cats = await this.categories();
        const comics = cats.map((c) => this.card(c)).filter(Boolean);
        return { comics, maxPage: 1 };
    }}];

    /** 章节列表：按 category 拉 posts。字段名去掉正则特殊字符（WP 的 _fields 不支持正则）。 */
    async chaptersOf(catId) {
        let all = [], page = 1;
        for (;;) {
            const batch = await this.api("/posts?categories=" + encodeURIComponent(catId) + "&per_page=100&page=" + page + "&orderby=id&order=asc&_fields=id,title,link");
            if (!Array.isArray(batch) || !batch.length) break;
            all = all.concat(batch);
            if (batch.length < 100) break;
            page++;
            if (page > 50) break;
        }
        return all;
    }

    stripHtml(s) {
        return String(s || "")
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/p>/gi, "\n")
            .replace(/<[^>]+>/g, "")
            .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#8217;/g, "'")
            .replace(/&#8220;|&#8221;/g, '"').replace(/&#8211;|&#8212;/g, "-")
            .replace(/\?{3,}/g, "") // 站点正文里常见的乱码问号块
            .trim();
    }

    comic = {
        textNovelCatalog: async (bookId) => {
            const cats = await this.categories();
            const cat = cats.find((c) => String(c.id) === String(bookId));
            const posts = await this.chaptersOf(bookId);
            const chapters = posts.map((p, i) => ({
                id: String(p.id),
                title: String(p.title && p.title.rendered || "Chapter " + (i + 1)).replace(/<[^>]+>/g, "").trim()
            }));
            return {
                title: cat ? String(cat.name) : "Korean Novel",
                author: "",
                cover: "",
                description: cat ? this.stripHtml(cat.description) : "",
                volumes: [{ id: "vol1", title: "正文", chapters }]
            };
        },
        textNovelChapter: async (bookId, chapterId, volumeId) => {
            const post = await this.api("/posts/" + encodeURIComponent(chapterId) + "?_fields=content");
            const html = post && post.content && post.content.rendered || "";
            // 去掉 WordPress 分享按钮/相关阅读等噪声
            const clean = String(html).replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
            const paras = this.stripHtml(clean).split(/\n+/).map((s) => s.trim()).filter(Boolean);
            return paras.map((p) => "<p>" + p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + "</p>").join("");
        },
        loadInfo: async (book) => {
            const raw = String(book == null ? "" : (book.id || book));
            const cats = await this.categories();
            const cat = cats.find((c) => String(c.id) === raw);
            const posts = await this.chaptersOf(raw);
            const chapters = {};
            for (let i = 0; i < posts.length; i++) {
                const p = posts[i];
                const name = String(p.title && p.title.rendered || "Chapter " + (i + 1)).replace(/<[^>]+>/g, "").trim();
                chapters[String(p.id)] = name;
            }
            return new ComicDetails({
                id: raw,
                title: cat ? String(cat.name) : "Korean Novel",
                cover: "",
                description: cat ? this.stripHtml(cat.description) : "",
                tags: { "题材": ["韩国网文", "英译"] },
                chapters,
                url: "https://www.koreannovels.com/category/all-stories/"
            });
        },
        downloadBook: async (book) => ({ textNovel: true, sourceKey: "koreannovels" }),
        onThumbnailLoad: () => ({ headers: { "User-Agent": "Mozilla/5.0" } })
    };
}
