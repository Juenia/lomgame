/**
 * actor 模型（S1 §3.4）：同一把钥匙上的任务严格串行，不同钥匙互不阻塞。
 * 用于「同一角色/同一用户同时点两次晋升」这类并发双花场景。
 */
export class KeyedQueue {
  #tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T> | T): Promise<T> {
    const prev = this.#tails.get(key) ?? Promise.resolve();
    const result = prev.then(() => task());
    const tail: Promise<void> = result.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return result;
  }

  /** 当前仍有排队任务的钥匙数量，用于压测观测 */
  get size(): number {
    return this.#tails.size;
  }
}
