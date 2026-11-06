/** 串行队列：同一时刻只执行一个任务（共享一个渲染器，提交逐个处理）。 */
export interface SerialQueue {
  run<T>(task: () => Promise<T>): Promise<T>;
  /** 等待已排队的任务全部结束。 */
  idle(): Promise<void>;
  /** 正在执行与排队中的任务数。 */
  readonly size: number;
}

export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let size = 0;
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      size += 1;
      const result = tail.then(task);
      tail = result
        .catch(() => undefined)
        .finally(() => {
          size -= 1;
        });
      return result;
    },
    idle() {
      return tail.then(() => undefined);
    },
    get size() {
      return size;
    },
  };
}
