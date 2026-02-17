export interface RemoteWriteInput {
  filePath: string;
  path: string;
  content: string;
  encoding: 'utf8' | 'base64';
}

export interface RemoteWriteJob extends RemoteWriteInput {
  generation: number;
}

export interface RemoteWriteResult {
  generation: number;
  status: 'written' | 'canceled';
}

interface RemoteWritePending {
  resolve: (value: RemoteWriteResult) => void;
  reject: (reason?: unknown) => void;
}

export interface RemoteWriteState {
  filePath: string;
  latestGeneration: number;
  timer?: ReturnType<typeof setTimeout>;
  latestJob?: RemoteWriteJob;
  chain: Promise<void>;
  pending: Map<number, RemoteWritePending>;
}

interface RemoteWriteQueueOptions {
  debounceMs?: number;
  write: (job: RemoteWriteJob) => Promise<void>;
}

const DEFAULT_DEBOUNCE_MS = 200;

export class RemoteWriteQueue {
  #debounceMs: number;
  #write: (job: RemoteWriteJob) => Promise<void>;
  #states = new Map<string, RemoteWriteState>();

  constructor(options: RemoteWriteQueueOptions) {
    this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.#write = options.write;
  }

  enqueue(input: RemoteWriteInput): Promise<RemoteWriteResult> {
    const state = this.#getOrCreateState(input.filePath);
    const generation = state.latestGeneration + 1;

    state.latestGeneration = generation;
    state.latestJob = {
      ...input,
      generation,
    };

    const resultPromise = new Promise<RemoteWriteResult>((resolve, reject) => {
      state.pending.set(generation, { resolve, reject });
    });

    this.#schedule(state);

    return resultPromise;
  }

  async flush(filePath?: string): Promise<void> {
    if (filePath) {
      const state = this.#states.get(filePath);

      if (!state) {
        return;
      }

      await this.#flushState(state);

      return;
    }

    const states = [...this.#states.values()];
    await Promise.all(states.map((state) => this.#flushState(state)));
  }

  async flushMatching(predicate: (filePath: string) => boolean): Promise<void> {
    const states = [...this.#states.values()].filter((state) => predicate(state.filePath));
    await Promise.all(states.map((state) => this.#flushState(state)));
  }

  cancel(filePath?: string) {
    if (filePath) {
      const state = this.#states.get(filePath);

      if (!state) {
        return;
      }

      this.#cancelState(state);

      return;
    }

    for (const state of this.#states.values()) {
      this.#cancelState(state);
    }
  }

  cancelMatching(predicate: (filePath: string) => boolean) {
    for (const state of this.#states.values()) {
      if (predicate(state.filePath)) {
        this.#cancelState(state);
      }
    }
  }

  dispose() {
    this.cancel();
    this.#states.clear();
  }

  #getOrCreateState(filePath: string) {
    const existing = this.#states.get(filePath);

    if (existing) {
      return existing;
    }

    const state: RemoteWriteState = {
      filePath,
      latestGeneration: 0,
      chain: Promise.resolve(),
      pending: new Map(),
    };

    this.#states.set(filePath, state);

    return state;
  }

  #schedule(state: RemoteWriteState) {
    if (state.timer) {
      clearTimeout(state.timer);
    }

    state.timer = setTimeout(() => {
      state.timer = undefined;
      this.#dispatch(state);
    }, this.#debounceMs);
  }

  #dispatch(state: RemoteWriteState) {
    const job = state.latestJob;

    if (!job) {
      this.#maybeCleanupState(state);
      return;
    }

    state.latestJob = undefined;

    for (const [generation, pending] of state.pending.entries()) {
      if (generation < job.generation) {
        pending.resolve({
          generation,
          status: 'canceled',
        });
        state.pending.delete(generation);
      }
    }

    state.chain = state.chain
      .then(async () => {
        await this.#write(job);

        const pending = state.pending.get(job.generation);

        if (pending) {
          pending.resolve({
            generation: job.generation,
            status: 'written',
          });
          state.pending.delete(job.generation);
        }
      })
      .catch((error) => {
        const pending = state.pending.get(job.generation);

        if (pending) {
          pending.reject(error);
          state.pending.delete(job.generation);
        }
      })
      .finally(() => {
        this.#maybeCleanupState(state);
      });
  }

  async #flushState(state: RemoteWriteState): Promise<void> {
    while (state.timer || state.latestJob) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }

      this.#dispatch(state);
      await state.chain;
    }

    await state.chain;
    this.#maybeCleanupState(state);
  }

  #cancelState(state: RemoteWriteState) {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }

    state.latestJob = undefined;

    for (const [generation, pending] of state.pending.entries()) {
      pending.resolve({
        generation,
        status: 'canceled',
      });
    }

    state.pending.clear();
    this.#maybeCleanupState(state);
  }

  #maybeCleanupState(state: RemoteWriteState) {
    if (state.timer || state.latestJob || state.pending.size > 0) {
      return;
    }

    this.#states.delete(state.filePath);
  }
}
