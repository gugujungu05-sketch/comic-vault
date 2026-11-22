/**
 * 拷贝漫画源（caolib/kira 与 venera-app/venera-configs 的 copy_manga 移植精简版）。
 * 走官方 App 通道 /api/v3/*，需要完整的 15 项业务头 + HMAC 请求签名。
 * 签名密钥是官方 APK 证书的公开协议常量（Venera 开源配置里的 secret），
 * 不写入任何账号数据；设备指纹首次生成后持久化，跨会话保持稳定。
 * 免费漫画免登录可读；受限/会员内容在源管理登录拷贝账号后（Token）解锁。
 */
class CopyManga extends ComicSource {
    name = "拷贝漫画";
    key = "copymanga";
    version = "1.0.0";
    minAppVersion = "1.6.0";
    url = "https://www.copy4000.com";
    baseUrl = "https://api.copy202601.com";
    mediaType = "comic";

    // 官方证书指纹（协议常量，Venera 开源配置公开值）
    _secret = "M2FmMDg1OTAzMTEwMzJlZmUwNjYwNTUwYTA1NjNhNTM=";
    _umstring = "b4c89ca4104ea9a97750314d791520ac";
    _appVersion = "3.1.1";
    _versionCode = "85";

    /* -------------------------- 设备指纹（稳定持久化） -------------------------- */
    _deviceinfo() {
        let v = this.loadData("_deviceinfo");
        if (!v) { v = `${randomInt(1000000, 9999999)}V-${randomInt(1000, 9999)}`; this.saveData("_deviceinfo", v); }
        return v;
    }
    _device() {
        let v = this.loadData("_device");
        if (!v) {
            const cA = () => String.fromCharCode(65 + randomInt(0, 25));
            const cD = () => String.fromCharCode(48 + randomInt(0, 9));
            v = cA() + cA() + cD() + cA() + "." + cD() + cD() + cD() + cD() + cD() + cD() + "." + cD() + cD() + cD();
            this.saveData("_device", v);
        }
        return v;
    }
    _pseudoid() {
        let v = this.loadData("_pseudoid");
        if (!v) {
            const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
            v = ""; for (let i = 0; i < 16; i++) v += chars.charAt(randomInt(0, chars.length - 1));
            this.saveData("_pseudoid", v);
        }
        return v;
    }

    /** 完整签名头：服务端对 version/versioncode/referer/dt 与 HMAC 交叉校验，缺一即静默返回空。 */
    get headers() {
        const now = new Date();
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, "0");
        const d = String(now.getDate()).padStart(2, "0");
        const ts = Math.floor(now.getTime() / 1000).toString();
        const sig = Convert.hmacString(Convert.decodeBase64(this._secret), Convert.encodeUtf8(ts), "sha256");
        // UTC+8 日期（与官方 App 一致）
        const shifted = new Date(now.getTime() + 8 * 3600 * 1000);
        const dt = `${shifted.getUTCFullYear()}.${String(shifted.getUTCMonth() + 1).padStart(2, "0")}.${String(shifted.getUTCDate()).padStart(2, "0")}`;
        const token = this.loadData("token");
        return {
            "User-Agent": `COPY/${this._appVersion}`,
            "source": "copyApp",
            "deviceinfo": this._deviceinfo(),
            "dt": dt,
            "platform": "3",
            "referer": `com.copymanga.app-${this._appVersion}`,
            "version": this._appVersion,
            "versioncode": this._versionCode,
            "region": "1",
            "webp": "1",
            "device": this._device(),
            "pseudoid": this._pseudoid(),
            "Accept": "application/json",
            "authorization": token ? `Token ${token}` : "Token",
            "umstring": this._umstring,
            "x-auth-timestamp": ts,
            "x-auth-signature": sig,
        };
    }

    async api(path, headers, _retry) {
        const url = this.baseUrl + path;
        const r = await Network.get(url, Object.assign({}, this.headers, headers || {}));
        if (!r || r.status !== 200 || !r.body) throw new Error("拷贝漫画请求失败：HTTP " + (r && r.status));
        let j; try { j = JSON.parse(r.body); } catch { throw new Error("拷贝漫画返回解析失败"); }
        // 210 = 官方限流/需更新：解析等待秒数，自动重试一次。
        if (j.code === 210) {
            if (!_retry) {
                let wait = 8000;
                const m = /(\d+)\s*seconds?/i.exec(String(j.message || ""));
                if (m) wait = Math.min(45000, Math.max(3000, Number(m[1]) * 1000));
                await new Promise((res) => setTimeout(res, wait));
                return this.api(path, headers, true);
            }
            throw new Error("拷贝漫画：访问过于频繁，请稍后重试");
        }
        if (j.code !== 200) throw new Error(j.message || "拷贝漫画请求失败");
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

    /* ------------------------------ 账号登录 ------------------------------ */
    account = {
        login: async (account, pwd) => {
            const salt = randomInt(1000, 9999);
            const encoded = Convert.encodeBase64(Convert.encodeUtf8(`${pwd}-${salt}`));
            const body = `username=${encodeURIComponent(account)}&password=${encodeURIComponent(encoded)}&salt=${salt}&authorization=Token+`;
            const r = await Network.post(
                this.baseUrl + "/api/v3/login",
                Object.assign({}, this.headers, { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" }),
                body
            );
            if (!r || r.status !== 200) throw `登录失败 HTTP ${r && r.status}`;
            const j = JSON.parse(r.body);
            if (j.code !== 200 || !j.results || !j.results.token) throw (j.message || "登录失败：账号或密码错误");
            this.saveData("token", j.results.token);
            return "ok";
        },
        logout: () => { this.deleteData("token"); },
        registerWebsite: "https://www.copy4000.com/",
    };

    /* ------------------------------ 发现页 ------------------------------ */
    explore = [{
        title: "拷贝漫画",
        type: "singlePageWithMultiPart",
        load: async () => {
            const d = await this.api("/api/v3/h5/homeIndex");
            const arr = (v) => Array.isArray(v) ? v : ((v && Array.isArray(v.list)) ? v.list : []);
            const map = (v) => arr(v).map((x) => this.parseComic(x)).filter(Boolean);
            return {
                "推荐": map(d.recComics),
                "热门": map(d.hotComics),
                "最新": map(d.newComics),
                "完结": map(d.finishComics),
                "今日排行": map(d.rankDayComics),
                "本周排行": map(d.rankWeekComics),
                "本月排行": map(d.rankMonthComics),
            };
        },
    }];

    /* ------------------------------ 搜索 ------------------------------ */
    search = {
        load: async (keyword, options, page) => {
            keyword = String(keyword || "").trim();
            if (!keyword) return { comics: [], maxPage: page };
            const d = await this.api(`/api/v3/search/comic?platform=3&q=${encodeURIComponent(keyword)}&limit=21&offset=${(page - 1) * 21}&free_type=1`);
            const list = (d.list || []).map((x) => this.parseComic(x)).filter(Boolean);
            const total = Number(d.total || 0);
            return { comics: list, maxPage: Math.max(1, Math.ceil(total / 21)) };
        },
    };

    /* ------------------------------ 详情/章节/图片 ------------------------------ */
    // 章节 uuid → 漫画 path_word 的进程内映射（loadEp 需要 path_word + uuid）
    _pathOf = {};
    comic = {
        loadInfo: async (id) => {
            const d = await this.api(`/api/v3/comic2/${encodeURIComponent(id)}?platform=3`);
            const c = d.comic || d;
            const tags = Array.isArray(c.theme) ? c.theme.map((t) => t.name).filter(Boolean) : [];
            const author = Array.isArray(c.author) && c.author.length ? c.author[0].name : "";
            // 分组：优先 default，否则取第一个
            let group = "default";
            if (d.groups && typeof d.groups === "object" && Object.keys(d.groups).length && !d.groups["default"]) {
                group = Object.keys(d.groups)[0];
            }
            const cd = await this.api(`/api/v3/comic/${encodeURIComponent(id)}/group/${encodeURIComponent(group)}/chapters?limit=100&offset=0&in_mainland=true&platform=3`);
            const chapters = {};
            for (const ch of (cd.list || [])) {
                if (!ch.uuid) continue;
                chapters[ch.uuid] = ch.name || `第 ${ch.index + 1} 话`;
                this._pathOf[ch.uuid] = id;
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
            const pathWord = comicId || this._pathOf[epId] || "";
            let d = null;
            try {
                d = await this.api(`/api/v3/comic/${encodeURIComponent(pathWord)}/chapter/${encodeURIComponent(epId)}?platform=3&_update=true`);
            } catch (e) {
                d = await this.api(`/api/v3/comic/${encodeURIComponent(pathWord)}/chapter2/${encodeURIComponent(epId)}?platform=3&in_mainland=true`);
            }
            const ch = (d && d.chapter) || d || {};
            const contents = ch.contents || [];
            let images = contents.map((x) => (typeof x === "string" ? x : x.url)).filter(Boolean);
            if (Array.isArray(ch.words) && ch.words.length === images.length) {
                const ordered = new Array(images.length);
                for (let i = 0; i < images.length; i++) if (Number.isInteger(ch.words[i])) ordered[ch.words[i]] = images[i];
                images = ordered.filter(Boolean);
            }
            images = images.map((u) => String(u).replace(/([./])c\d+x\.[a-zA-Z]+$/, `$1c1500x.webp`));
            return { images: images };
        },
        onImageLoad: (url) => new ImageLoadingConfig({ url: url, headers: { "Referer": "https://api.copy202601.com/", "User-Agent": "Mozilla/5.0" } }),
    };
}
