import { describe, expect, it, vi } from 'vitest';
import type { ActionCallbackData } from './message-parser';
import { ActionRunner } from './action-runner';

const createShellStub = () =>
  ({
    ready: vi.fn().mockResolvedValue(undefined),
    terminal: {},
    process: {},
    executeCommand: vi.fn().mockResolvedValue({ exitCode: 0, output: '' }),
  }) as any;

const createRunner = (onAlert?: (payload: any) => void) => {
  return new ActionRunner(undefined, () => createShellStub(), onAlert, undefined, undefined, {
    runtimeProvider: 'dokploy',
  });
};

const runSingleAction = async (
  runner: ActionRunner,
  actionId: string,
  action: ActionCallbackData['action'],
): Promise<void> => {
  const payload: ActionCallbackData = {
    artifactId: 'artifact-1',
    messageId: 'message-1',
    actionId,
    action,
  };

  runner.addAction(payload);
  await runner.runAction(payload);
};

describe('ActionRunner (Dokploy V1)', () => {
  it('fails shell actions with unsupported_in_v1', async () => {
    const runner = createRunner();
    await runSingleAction(runner, 'shell-1', {
      type: 'shell',
      content: 'npm install',
    });

    const shellState = runner.actions.get()['shell-1'] as { status: string; error?: string };
    expect(shellState.status).toBe('failed');
    expect(shellState.error).toBe('unsupported_in_v1');
  });

  it('fails start and build actions with unsupported_in_v1', async () => {
    const runner = createRunner();
    await runSingleAction(runner, 'start-1', {
      type: 'start',
      content: 'npm run dev',
    });
    await runSingleAction(runner, 'build-1', {
      type: 'build',
      content: 'npm run build',
    });

    const startState = runner.actions.get()['start-1'] as { status: string; error?: string };
    const buildState = runner.actions.get()['build-1'] as { status: string; error?: string };

    expect(startState.status).toBe('failed');
    expect(startState.error).toBe('unsupported_in_v1');
    expect(buildState.status).toBe('failed');
    expect(buildState.error).toBe('unsupported_in_v1');
  });

  it('emits unsupported alert only once per runner session', async () => {
    const onAlert = vi.fn();
    const runner = createRunner(onAlert);
    await runSingleAction(runner, 'shell-1', {
      type: 'shell',
      content: 'ls',
    });
    await runSingleAction(runner, 'start-1', {
      type: 'start',
      content: 'npm run dev',
    });
    await runSingleAction(runner, 'build-1', {
      type: 'build',
      content: 'npm run build',
    });

    expect(onAlert).toHaveBeenCalledTimes(1);
  });

  it('keeps file actions running after unsupported shell action', async () => {
    const runner = createRunner();
    await runSingleAction(runner, 'shell-1', {
      type: 'shell',
      content: 'npm install',
    });
    await runSingleAction(runner, 'file-1', {
      type: 'file',
      filePath: '/home/project/src/main.ts',
      content: 'export const ready = true;\n',
    });

    const shellState = runner.actions.get()['shell-1'] as { status: string; error?: string };
    const fileState = runner.actions.get()['file-1'] as { status: string; error?: string };

    expect(shellState.status).toBe('failed');
    expect(fileState.status).toBe('complete');
  });

  it('works in dokploy mode without webcontainer promise', async () => {
    const runner = createRunner();
    await runSingleAction(runner, 'file-1', {
      type: 'file',
      filePath: '/home/project/src/app.ts',
      content: 'console.log("ok");\n',
    });

    const fileState = runner.actions.get()['file-1'] as { status: string; error?: string };
    expect(fileState.status).toBe('complete');
  });
});
