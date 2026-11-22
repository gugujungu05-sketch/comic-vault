/**
 * 热辣漫画源（caolib/kira 与 venera-app/venera-configs 的 hot_manga 移植精简版）。
 * 走官方 App 通道 /api/v3/*，请求头简单（无需 HMAC 签名）；免费漫画免登录可读，
 * 会员/受限内容在源管理登录热辣账号（Token）后解锁。默认节点 api.2024manga.com
 * （kira 的备用线路 mapi.hotmangasg.com 等同服务，可在 baseUrl 改）。
 */
class HotManga extends ComicSource {
    name = "热辣漫画";
    key = "hotmanga";
    version = "1.0.0";
    minAppVersion = "1.6.0";
    url = "https://www.manga2026.com";
    baseUrl = "https://api.2024manga.com";
    mediaType = "comic";

    get headers() {
        const token = this.loadData("token");
        return {
            "User-Agent": "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36",
            "Authorization": token ? `Token ${token}` : "",
            "Accept": "application/json",
            "webp": "1",
            "platform": "3",
            "version": "2024.04.28",
            "X-Requested-With": "com.manga2020.app",
        };
    }

    async api(path, _retry) {
        const r = await Network.get(this.baseUrl + path, this.headers);
        if (!r || r.status !== 200 || !r.body) throw new Error("热辣漫画请求失败：HTTP " + (r && r.status));
        let j; try { j = JSON.parse(r.body); } catch { throw new Error("热辣漫画返回解析失败"); }
        if (j.code === 210) {
            if (!_retry) {
                let wait = 8000;
                const m = /(\d+)\s*seconds?/i.exec(String(j.message || ""));
                if (m) wait = Math.min(45000, Math.max(3000, Number(m[1]) * 1000));
                await new Promise((res) => setTimeout(res, wait));
                return this.api(path, true);
            }
            throw new Error("热辣漫画：访问过于频繁，请稍后重试");
        }
        if (j.code !== 200) throw new Error(j.message || "热辣漫画请求失败");
        return j.results;
    }

    parseComic(c) {
        if (!c) return null;
        if (c.comic) c = c.comic;
        const tags = Array.isArray(c.theme) ? c.theme.map((t) => t.name).filter(Boolean) : [];
        const author = Array.isArray(c.author) && c.author.length ? c.author[0].name : "";
        return new Comic({
            id: c.path_word,
            title: c.name || "",
            subTitle: author,
            cover: c.cover || "",
            tags: tags,
            description: c.datetime_updated || "",
        });
    }

    account = {
        login: async (account, pwd) => {
            const salt = randomInt(1000, 9999);
            const encoded = Convert.encodeBase64(Convert.encodeUtf8(`${pwd}-${salt}`));
            const body = `username=${encodeURIComponent(account)}&password=${encodeURIComponent(encoded)}&salt=${salt}&source=Official&version=2.2.0&platform=3`;
            const r = await Network.post(
                this.baseUrl + "/api/v3/login",
                { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8", "X-Requested-With": "com.manga2020.app", "platform": "3", "version": "2024.04.28" },
                body
            );
            if (!r || r.status !== 200) throw `登录失败 HTTP ${r && r.status}`;
            const j = JSON.parse(r.body);
            if (j.code !== 200 || !j.results || !j.results.token) throw (j.message || "登录失败：账号或密码错误");
            this.saveData("token", j.results.token);
            return "ok";
        },
        logout: () => { this.deleteData("token"); },
        registerWebsite: "https://www.manga2026.com/web/login/loginByAccount",
    };

    explore = [{
        title: "热辣漫画",
        type: "singlePageWithMultiPart",
        load: async () => {
            const d = await this.api("/api/v3/h5/homeIndex");
            const arr = (v) => Array.isArray(v) ? v : ((v && Array.isArray(v.list)) ? v.list : []);
            const map = (v) => arr(v).map((x) => this.parseComic(x)).filter(Boolean);
            return {
                "推荐": map(d.recComics),
                "本周免费排行": map(d.rankWeeklyFreeComics),
                "本周收费排行": map(d.rankWeeklyChargeComics),
                "最新免费": map(d.updateWeeklyFreeComics),
                "最新收费": map(d.updateWeeklyChargeComics),
                "推荐动漫": map(d.recCartoons),
            };
        },
    }];

    search = {
        load: async (keyword, options, page) => {
            keyword = String(keyword || "").trim();
            if (!keyword) return { comics: [], maxPage: page };
            const d = await this.api(`/api/v3/search/comic?platform=3&q=${encodeURIComponent(keyword)}&limit=20&offset=${(page - 1) * 20}&free_type=1&_update=true`);
            const list = (d.list || []).map((x) => this.parseComic(x)).filter(Boolean);
            return { comics: list, maxPage: Math.max(1, Math.ceil(Number(d.total || 0) / 20)) };
        },
    };

    comic = {
        loadInfo: async (id) => {
            const d = await this.api(`/api/v3/comic2/${encodeURIComponent(id)}?platform=3`);
            const c = d.comic || d;
            const tags = Array.isArray(c.theme) ? c.theme.map((t) => t.name).filter(Boolean) : [];
            const author = Array.isArray(c.author) && c.author.length ? c.author[0].name : "";
            let group = "default";
            if (d.groups && typeof d.groups === "object" && Object.keys(d.groups).length && !d.groups["default"]) {
                group = Object.keys(d.groups)[0];
            }
            const cd = await this.api(`/api/v3/comic/${encodeURIComponent(id)}/group/${encodeURIComponent(group)}/chapters?limit=100&offset=0`);
            const chapters = {};
            for (const ch of (cd.list || [])) {
                if (!ch.uuid) continue;
                chapters[ch.uuid] = ch.name || `第 ${ch.index + 1} 话`;
            }
            return new ComicDetails({
                id: id,
                title: c.name || "",
                subTitle: author,
                cover: c.cover || "",
                description: (c.alias || "") + (c.brief ? "\n" + String(c.brief).replace(/<[^>]+>/g, "") : ""),
                tags: tags,
                chapters: chapters,
                url: this.baseUrl + "/comic/" + id,
            });
        },
        loadEp: async (comicId, epId) => {
            const d = await this.api(`/api/v3/comic/${encodeURIComponent(comicId)}/chapter/${encodeURIComponent(epId)}?platform=3&_update=true`);
            const ch = d.chapter || d;
            let images = (ch.contents || []).map((x) => (typeof x === "string" ? x : x.url)).filter(Boolean);
            if (Array.isArray(ch.words) && ch.words.length === images.length) {
                const ordered = new Array(images.length);
                for (let i = 0; i < images.length; i++) if (Number.isInteger(ch.words[i])) ordered[ch.words[i]] = images[i];
                images = ordered.filter(Boolean);
            }
            images = images.map((u) => String(u).replace(/\.jpg\.h\d+x\.jpg$/, ".jpg.h1500x.jpg"));
            return { images: images };
        },
        onImageLoad: (url) => new ImageLoadingConfig({ url: url, headers: { "Referer": "https://api.2024manga.com/", "User-Agent": "Mozilla/5.0" } }),
    };
}
