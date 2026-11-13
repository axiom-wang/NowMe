/**
 * 内存里的固定窗口限流（contracts 10.3）：按“范围 + 键”计数，窗口到期后清零。
 *
 * 用在没有登录态、数据库里没有天然计数的入口（按来源地址：发验证码、验证、换取页面凭证），
 * 以及高频的登录后操作（按用户：发消息）。按邮箱 / 按页面 / 按天的额度仍然在数据库里算，重启不丢。
 *
 * 单进程部署：计数在进程内存里，重启清零——对“短时间内别太猛”这类保护足够；
 * 将来多进程部署时要换成共享存储（这里的接口不变）。
 */
export interface RateRule {
  /** 窗口内允许的次数。 */
  max: number;
  windowMs: number;
}

export interface RateDecision {
  ok: boolean;
  /** 被拒绝时，离窗口结束还有多少秒（至少 1）。 */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  /** 记一次并判断是否放行。超过上限后不再累加（不会因为持续重试把窗口越拖越长）。 */
  hit(scope: string, key: string, rule: RateRule): RateDecision;
  /** 当前记录的键数（测试与诊断）。 */
  readonly size: number;
}

/** 键数超过这个值时清理过期的记录。 */
const SWEEP_THRESHOLD = 5000;

export function createRateLimiter(now: () => Date): RateLimiter {
  const buckets = new Map<string, { start: number; count: number; windowMs: number }>();
  const sweep = (at: number) => {
    for (const [key, bucket] of buckets) if (at - bucket.start >= bucket.windowMs) buckets.delete(key);
  };
  return {
    hit(scope, key, rule) {
      const at = now().getTime();
      if (buckets.size > SWEEP_THRESHOLD) sweep(at);
      const id = `${scope}\u0000${key}`;
      let bucket = buckets.get(id);
      if (!bucket || at - bucket.start >= bucket.windowMs) {
        bucket = { start: at, count: 0, windowMs: rule.windowMs };
        buckets.set(id, bucket);
      }
      if (bucket.count >= rule.max) {
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.start + bucket.windowMs - at) / 1000)) };
      }
      bucket.count += 1;
      return { ok: true, retryAfterSeconds: 0 };
    },
    get size() {
      return buckets.size;
    },
  };
}
