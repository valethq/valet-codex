/** An unbounded async queue: producers push from notification handlers, one turn consumes. */
export class Channel<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private wake?: () => void;
  private ended = false;

  push(item: T): void {
    if (this.ended) return;
    this.items.push(item);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  get closed(): boolean {
    return this.ended;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      const item = this.items.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((r) => {
        this.wake = r;
      });
      this.wake = undefined;
    }
  }
}
