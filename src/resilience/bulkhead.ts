import { BulkheadRejectedError } from "./errors.js";

export interface BulkheadOptions {
  name: string;
  maxConcurrent: number;
  /** Calls allowed to wait for a slot. 0 = reject as soon as all slots are busy. */
  maxQueue: number;
}

/**
 * Semaphore-style bulkhead: caps concurrent calls to one dependency so a slow dependency cannot
 * consume every connection/worker in the process and starve unrelated work.
 */
export class Bulkhead {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly opts: BulkheadOptions) {
    if (opts.maxConcurrent < 1) throw new RangeError("maxConcurrent must be >= 1");
    if (opts.maxQueue < 0) throw new RangeError("maxQueue must be >= 0");
  }

  get stats() {
    return { active: this.active, queued: this.waiting.length };
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.opts.maxConcurrent) {
      if (this.waiting.length >= this.opts.maxQueue) throw new BulkheadRejectedError(this.opts.name);
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await operation();
    } finally {
      const next = this.waiting.shift();
      if (next)
        next(); // hand the slot directly to the next waiter; `active` is unchanged
      else this.active--;
    }
  }
}
