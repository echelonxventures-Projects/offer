/**
 * A minimal async mutex.
 *
 * Needed because the ports are async. Two concurrent `reserve` calls will
 * interleave at every `await`, so an adapter whose critical section spans an
 * await is not safe merely because JavaScript is single-threaded. The memory
 * adapter holds this around each atomic operation and around each transaction;
 * the SQLite adapter uses `BEGIN IMMEDIATE`, which is the database's version of
 * the same idea.
 */
export class Mutex {
  #tail: Promise<void> = Promise.resolve();

  /** Run `work` with exclusive access. Queued strictly in call order. */
  async run<T>(work: () => Promise<T> | T): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}
