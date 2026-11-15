/**
 * 同进程内的任务完成通知（inline 模式：主站等待提交 / 预览结果时不必等轮询间隔）。
 * 跨进程（separate 模式）没有通知，等待方按间隔读数据库（见 dispatch.ts）。
 */
export interface JobSignals {
  notify(jobId: string): void;
  /** 等到 `notify(jobId)` 或 `ms` 毫秒后返回。 */
  wait(jobId: string, ms: number): Promise<void>;
}

export function createJobSignals(): JobSignals {
  const waiters = new Map<string, Set<() => void>>();
  return {
    notify(jobId) {
      const set = waiters.get(jobId);
      if (!set) return;
      waiters.delete(jobId);
      for (const resolve of set) resolve();
    },
    wait(jobId, ms) {
      return new Promise<void>((resolve) => {
        let set = waiters.get(jobId);
        if (!set) {
          set = new Set();
          waiters.set(jobId, set);
        }
        const done = () => {
          clearTimeout(timer);
          const current = waiters.get(jobId);
          current?.delete(done);
          if (current?.size === 0) waiters.delete(jobId);
          resolve();
        };
        const timer = setTimeout(done, Math.max(0, ms));
        set.add(done);
      });
    },
  };
}
