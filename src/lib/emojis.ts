import { withCredential } from './util';
import type { Sticker } from '../types';

/** 内置 Unicode 表情：不依赖服务端，随时可用 */
export interface BuiltinEmoji {
  char: string;
  name: string;
  keys: string[];
}

const E = (char: string, name: string, keys: string): BuiltinEmoji => ({
  char, name, keys: keys.split(/\s+/).filter(Boolean),
});

export const BUILTIN_EMOJIS: BuiltinEmoji[] = [
  E('😂', '笑哭', '笑 哭 哈哈 好笑 乐 xs 爆笑'),
  E('🤣', '笑到打滚', '笑 哈哈 滚 乐'),
  E('😆', '大笑', '笑 哈哈 开心 嗨'),
  E('😄', '微笑', '笑 开心 高兴'),
  E('😊', '害羞', '笑 温柔 腼腆'),
  E('🥹', '感动', '哭 泪 感动 呜'),
  E('😭', '大哭', '哭 泪 难过 呜呜'),
  E('😢', '流泪', '哭 泪 伤心'),
  E('😍', '喜欢', '爱 喜欢 心动 花痴'),
  E('🥰', '喜爱', '爱 喜欢 幸福'),
  E('😘', '飞吻', '爱 亲亲 么么'),
  E('😎', '酷', '帅 酷 墨镜 得意'),
  E('🤔', '思考', '想 疑问 思索 嗯'),
  E('😴', '睡觉', '困 睡 累 zzz'),
  E('🥱', '打哈欠', '困 累 无聊'),
  E('😱', '惊吓', '惊 吓 震惊 害怕'),
  E('😨', '害怕', '怕 惊 慌'),
  E('😡', '生气', '怒 气 火大 愤怒'),
  E('🤬', '暴怒', '怒 骂 气炸'),
  E('😤', '哼', '气 不服 哼'),
  E('🥺', '可怜', '求 委屈 可怜拜托'),
  E('😳', '脸红', '害羞 尴尬 震惊'),
  E('🫠', '融化', '累 崩溃 无奈'),
  E('🤡', '小丑', '尬 搞笑 自嘲 寄'),
  E('💀', '笑死', '死 笑 寄 绝了'),
  E('👍', '点赞', '好 赞 支持 棒'),
  E('👎', '踩', '差 不行 反对'),
  E('👏', '鼓掌', '棒 厉害 掌声'),
  E('🙏', '拜托', '谢谢 求 感谢 拜'),
  E('💪', '加油', '努力 加油 强'),
  E('👌', 'OK', '好 可以 没问题'),
  E('✌️', '耶', '胜利 开心 比耶'),
  E('🤝', '握手', '合作 成交 友好'),
  E('🫡', '敬礼', '收到 明白 遵命'),
  E('🤌', '绝了', '好吃 完美 意大利'),
  E('❤️', '爱心', '爱 喜欢 红心'),
  E('💔', '心碎', '难过 失恋 伤心'),
  E('✨', '闪亮', '新 棒 星星 闪'),
  E('🔥', '火', '热 火 爆 绝'),
  E('💯', '满分', '百分 赞 完美'),
  E('🎉', '庆祝', '恭喜 庆祝 撒花'),
  E('📚', '漫画', '书 漫画 看书 学习'),
  E('📖', '读书', '书 看 阅读 翻页'),
  E('🖼️', '插画', '图 画 封面'),
  E('🎬', '动画', '电影 番 视频'),
  E('🍿', '爆米花', '看剧 吃 追番'),
  E('☕', '闲聊', '咖啡 灌水 摸鱼'),
  E('🔎', '找书', '求 搜索 找 求助'),
  E('📦', '资源', '分享 包 下载 资源'),
  E('⚡', '剧透', '闪电 快 剧透'),
];

/** 正文中自定义表情包的标记：[emoji:文件名] */
const MARK = '[A-Za-z0-9_-]+\\.[A-Za-z0-9]+';
export const EMOJI_SPLIT_RE = new RegExp(`(\\[emoji:${MARK}\\])`, 'g');
export const EMOJI_MATCH_RE = /^\[emoji:([A-Za-z0-9_-]+\.[A-Za-z0-9]+)\]$/;

export function emojiMark(file: string) {
  return `[emoji:${file}]`;
}

/** 广场附件 / 表情包图片的地址；走 withCredential 保证托管环境下带 sharecode */
export function plazaMediaUrl(file: string) {
  return withCredential(`/api/plaza/media/${file}`);
}

export interface EmojiCandidate {
  key: string;
  label: string;
  /** 插入到正文的内容 */
  insert: string;
  /** 预览图地址（内置表情没有图片） */
  image?: string;
  char?: string;
  /** 触发这次匹配的词，插入时会从正文末尾移除 */
  term: string;
}

/**
 * 从刚输入的文字里取出末尾的一小段作为关键词，匹配内置表情与自定义表情包。
 * 中文没有分词，额外尝试末尾 2/3/4 字，让用户打「哈哈」「笑死」这类词就能命中。
 */
export function searchEmojis(text: string, stickers: Sticker[]): EmojiCandidate[] {
  const tail = text.slice(-40);
  const seg = tail.split(/[\s,，。!！?？、\n]+/).pop() || '';
  const q = seg.trim().toLowerCase();
  if (!q) return [];
  const terms = [...new Set([q, q.slice(-2), q.slice(-3), q.slice(-4)].filter((s) => s.length >= 1))];
  const hit = (haystack: string) => terms.some((t) => haystack.toLowerCase().includes(t));

  const custom: EmojiCandidate[] = stickers
    .filter((s) => hit(`${s.name} ${(s.tags || []).join(' ')}`))
    .slice(0, 5)
    .map((s) => ({
      key: `s-${s.id}`, label: s.name, insert: emojiMark(s.file),
      image: plazaMediaUrl(s.file), term: q,
    }));
  const builtin: EmojiCandidate[] = BUILTIN_EMOJIS
    .filter((e) => hit(`${e.name} ${e.keys.join(' ')}`))
    .slice(0, 8)
    .map((e) => ({ key: `b-${e.char}`, label: e.name, insert: e.char, char: e.char, term: q }));
  return [...custom, ...builtin].slice(0, 10);
}

/** 面板内手动搜索：同时过滤内置与自定义表情 */
export function filterEmojis(q: string, stickers: Sticker[]) {
  const key = q.trim().toLowerCase();
  const builtin = BUILTIN_EMOJIS.filter(
    (e) => !key || `${e.name} ${e.keys.join(' ')}`.toLowerCase().includes(key),
  );
  const custom = stickers.filter(
    (s) => !key || `${s.name} ${(s.tags || []).join(' ')}`.toLowerCase().includes(key),
  );
  return { builtin, custom };
}
