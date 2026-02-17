import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteWriteQueue } from './remote-write-queue';

describe('RemoteWriteQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces writes per file and cancels obsolete generations', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const queue = new RemoteWriteQueue({ write, debounceMs: 200 });

    const first = queue.enqueue({
      filePath: '/home/project/src/main.ts',
      path: 'src/main.ts',
      content: 'console.log("v1")',
      encoding: 'utf8',
    });
    const second = queue.enqueue({
      filePath: '/home/project/src/main.ts',
      path: 'src/main.ts',
      content: 'console.log("v2")',
      encoding: 'utf8',
    });

    await vi.advanceTimersByTimeAsync(220);

    await expect(first).resolves.toEqual({
      generation: 1,
      status: 'canceled',
    });
    await expect(second).resolves.toEqual({
      generation: 2,
      status: 'written',
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: 2,
        content: 'console.log("v2")',
      }),
    );
  });

  it('serializes writes for the same file', async () => {
    let firstResolve: (() => void) | undefined;
    const write = vi
      .fn()
      .mockImplementationOnce(
        async () =>
          await new Promise<void>((resolve) => {
            firstResolve = resolve;
          }),
      )
      .mockResolvedValueOnce(undefined);
    const queue = new RemoteWriteQueue({ write, debounceMs: 200 });

    const first = queue.enqueue({
      filePath: '/home/project/src/app.ts',
      path: 'src/app.ts',
      content: 'v1',
      encoding: 'utf8',
    });
    await vi.advanceTimersByTimeAsync(220);
    expect(write).toHaveBeenCalledTimes(1);

    const second = queue.enqueue({
      filePath: '/home/project/src/app.ts',
      path: 'src/app.ts',
      content: 'v2',
      encoding: 'utf8',
    });
    await vi.advanceTimersByTimeAsync(220);
    expect(write).toHaveBeenCalledTimes(1);

    firstResolve?.();
    await first;
    await queue.flush('/home/project/src/app.ts');

    await expect(second).resolves.toEqual({
      generation: 2,
      status: 'written',
    });
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        generation: 2,
        content: 'v2',
      }),
    );
  });

  it('flushes pending debounced write immediately', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const queue = new RemoteWriteQueue({ write, debounceMs: 200 });

    const pending = queue.enqueue({
      filePath: '/home/project/package.json',
      path: 'package.json',
      content: '{"name":"bolt"}',
      encoding: 'utf8',
    });
    await queue.flush('/home/project/package.json');

    await expect(pending).resolves.toEqual({
      generation: 1,
      status: 'written',
    });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('propagates write failures for latest generation', async () => {
    const write = vi.fn().mockRejectedValue(new Error('write failed'));
    const queue = new RemoteWriteQueue({ write, debounceMs: 200 });

    const pending = queue.enqueue({
      filePath: '/home/project/src/fail.ts',
      path: 'src/fail.ts',
      content: 'boom',
      encoding: 'utf8',
    });
    const rejection = expect(pending).rejects.toThrow('write failed');

    await vi.advanceTimersByTimeAsync(220);
    await rejection;
    expect(write).toHaveBeenCalledTimes(1);
  });
});
