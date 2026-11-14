/**
 * 内容安全检查（contracts 16.1）。路由 / 服务边界统一调用 `checkText(kind, text)`：
 *
 * 1. 内置规则：一小份明显违规的写法（诈骗引流、赌博、色情招揽、违禁品交易、拉人头），编号 `B01`–`B05`；
 * 2. 外部词表（`NOWME_BLOCKLIST_FILE`，可选）：每行一个词或 `/正则/`，编号 `F<行号>`；启动时读入，不合法就拒绝启动；
 * 3. 外部审核接口（`NOWME_MODERATION_URL`，可选，默认关闭）：只允许公网 HTTPS（复用 security/model-network.ts：
 *    逐次解析 DNS 并固定连接地址、拒绝重定向）。超时或失败按 `NOWME_MODERATION_ON_FAILURE` 放行（默认，记日志）或拦截。
 *
 * 日志只记检查点类型与命中规则编号，不记原文。拦截提示是中文、友好、不说教。
 * 内置规则很克制：这里不是敏感词大全，更多规则请用外部词表或审核接口补充。
 */
import {
  CONTENT_KINDS,
  MODERATION_TEXT_MAX_CHARS,
  MODERATION_TIMEOUT_MS,
  loadBlocklistFile,
  matchBlocklist,
  squashForMatching,
  type BlocklistEntry,
  type ContentKind,
  type ModerationConfig,
} from '@nowme/contracts';
import { createModelFetch, type ModelLookup } from '../security/model-network.js';

export type { ContentKind };

export type SafetyVerdict = { ok: true } | { ok: false; kind: ContentKind; rule: string; message: string };

export interface ContentSafety {
  /** 检查一段文字。空文字直接放行。 */
  checkText(kind: ContentKind, text: string | null | undefined): Promise<SafetyVerdict>;
  /** 逐段检查，遇到第一处命中就返回（外部审核接口只对未命中本地规则的文字调用）。 */
  checkTexts(kind: ContentKind, texts: ReadonlyArray<string | null | undefined>): Promise<SafetyVerdict>;
}

interface BuiltinRule {
  rule: string;
  /** 在 `squashForMatching` 处理后的文字上匹配（已去掉空白与分隔符、小写、全角转半角）。 */
  pattern: RegExp;
}

/** 内置规则：只放“几乎不会是正常聊天或自我介绍”的写法。 */
export const BUILTIN_RULES: readonly BuiltinRule[] = [
  // B01 诈骗引流：刷单返利、垫付、稳赚不赔一类
  { rule: 'B01', pattern: /刷单(兼职|返利|赚|任务|佣金|群|日结)|(兼职|招募|代|招)刷单|刷信誉|垫付返利|先垫付|稳赚不赔|包赚不赔|日结兼职|兼职日结|轻松日赚|日入[0-9]{3,}|高额返利|内部消息稳赚|解冻保证金/ },
  // B02 赌博
  { rule: 'B02', pattern: /六合彩|百家乐|时时彩|北京赛车|网赌|网络赌博|赌场开户|博彩(平台|网|开户|代理)|澳门.{0,4}(赌场|博彩)|真人荷官|线上.{0,2}(赌场|博彩)/ },
  // B03 色情招揽
  { rule: 'B03', pattern: /约炮|一夜情|裸聊|包夜服务|上门服务.{0,6}(价格|多少|私聊|加)|楼凤|援交|莞式/ },
  // B04 违禁品与证件票据买卖
  { rule: 'B04', pattern: /办假证|办理假证|代开发票|出售枪支|售卖枪支|出售迷药|出售假币|代办假/ },
  // B05 拉人头 / 资金盘
  { rule: 'B05', pattern: /拉人头|发展下线|下线提成|资金盘|入会费返/ },
];

/** 拦截提示：友好、不说教，带上规则编号方便申诉。 */
export function blockedMessage(kind: ContentKind, rule: string): string {
  const where: Record<ContentKind, string> = {
    wall: '墙的名称或介绍里',
    nickname: '这个昵称里',
    interview: '你写的内容里',
    edit: '这条修改要求里',
    message: '这条消息里',
    page: '页面里的文字',
  };
  const next: Record<ContentKind, string> = {
    wall: '换个说法再试试吧。',
    nickname: '换一个再试试吧。',
    interview: '换个说法再试试吧。',
    edit: '换个说法再试试吧。',
    message: '换个说法再发一次吧。',
    page: '请回到修改页调整后再发布。',
  };
  return `${where[kind]}有我们没法放行的内容，${next[kind]}（提示编号 ${rule}；如果觉得是误判，改写后再提交即可。）`;
}

export interface ContentSafetyOptions {
  moderation: ModerationConfig;
  /** 审核接口密钥（`NOWME_MODERATION_API_KEY`），只从环境变量读。 */
  apiKey?: string;
  log: (message: string) => void;
  /** 非生产环境允许 http://localhost（测试用，与模型接口同一个开关）。 */
  allowLocal?: boolean;
  lookup?: ModelLookup;
  /** 测试注入的传输层；仍然经过 URL 与 DNS 检查。 */
  transport?: typeof fetch;
}

/** 审核接口返回的规则编号只留短的安全字符，进日志与提示前先清洗。 */
function cleanRule(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,32}$/.test(value) ? `M:${value}` : 'M01';
}

export function createContentSafety(options: ContentSafetyOptions): ContentSafety {
  const { moderation, log } = options;
  // 词表读不到或写错：抛错让主站启动失败（配置了却悄悄不检查，比不配置更糟）
  const blocklist: BlocklistEntry[] = moderation.blocklistFile ? loadBlocklistFile(moderation.blocklistFile) : [];
  const remote = moderation.url
    ? createModelFetch({ allowLocal: options.allowLocal, lookup: options.lookup, transport: options.transport })
    : null;

  function checkLocal(text: string): string | null {
    const squashed = squashForMatching(text);
    for (const { rule, pattern } of BUILTIN_RULES) if (pattern.test(squashed)) return rule;
    return matchBlocklist(blocklist, text);
  }

  type RemoteResult = { ok: true } | { ok: false; rule: string } | { failed: 'timeout' | 'http' | 'format' | 'network' };

  /** 约定：POST JSON `{ kind, text }`，返回 JSON `{ allowed: boolean, rule?: string }`。 */
  async function checkRemote(kind: ContentKind, text: string): Promise<RemoteResult> {
    if (!remote || !moderation.url) return { ok: true };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODERATION_TIMEOUT_MS);
    try {
      const response = await remote(moderation.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}) },
        body: JSON.stringify({ kind, text: text.slice(0, MODERATION_TEXT_MAX_CHARS) }),
        signal: controller.signal,
        redirect: 'manual',
      });
      if (!response.ok) return { failed: 'http' };
      const body = (await response.json()) as { allowed?: unknown; rule?: unknown };
      if (typeof body.allowed !== 'boolean') return { failed: 'format' };
      return body.allowed ? { ok: true } : { ok: false, rule: cleanRule(body.rule) };
    } catch (error) {
      return { failed: controller.signal.aborted || (error as Error)?.name === 'AbortError' ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timer);
    }
  }

  async function checkText(kind: ContentKind, text: string | null | undefined): Promise<SafetyVerdict> {
    if (!(CONTENT_KINDS as readonly string[]).includes(kind)) throw new Error(`未知的检查点类型：${kind}`);
    if (!text || !text.trim()) return { ok: true };
    const local = checkLocal(text);
    if (local) {
      log(`[safety] 拦截 kind=${kind} rule=${local}`);
      return { ok: false, kind, rule: local, message: blockedMessage(kind, local) };
    }
    const result = await checkRemote(kind, text);
    if ('failed' in result) {
      log(`[safety] 审核接口不可用 kind=${kind} reason=${result.failed} action=${moderation.onFailure}`);
      if (moderation.onFailure === 'block') return { ok: false, kind, rule: 'M00', message: blockedMessage(kind, 'M00') };
      return { ok: true };
    }
    if (!result.ok) {
      log(`[safety] 拦截 kind=${kind} rule=${result.rule}`);
      return { ok: false, kind, rule: result.rule, message: blockedMessage(kind, result.rule) };
    }
    return { ok: true };
  }

  return {
    checkText,
    async checkTexts(kind, texts) {
      for (const text of texts) {
        const verdict = await checkText(kind, text);
        if (!verdict.ok) return verdict;
      }
      return { ok: true };
    },
  };
}
