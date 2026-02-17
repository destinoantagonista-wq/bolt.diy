import { describe, expect, it } from 'vitest';
import { isRedeployTriggerPath, toRuntimePath, toVirtualPath } from './path-mapper';

describe('path-mapper', () => {
  it('maps virtual workdir paths to runtime paths', () => {
    expect(toRuntimePath('/home/project/src/main.ts')).toBe('src/main.ts');
    expect(toRuntimePath('/home/project/')).toBe('');
    expect(toRuntimePath('src\\main.ts')).toBe('src/main.ts');
  });

  it('maps runtime paths back to virtual paths', () => {
    expect(toVirtualPath('src/main.ts')).toBe('/home/project/src/main.ts');
    expect(toVirtualPath('')).toBe('/home/project');
  });

  it('rejects traversal and invalid path encodings', () => {
    expect(() => toRuntimePath('../../etc/passwd')).toThrow('Invalid runtime path');
    expect(() => toRuntimePath('/home/project/../secret.txt')).toThrow('Invalid runtime path');
    expect(() => toRuntimePath('/home/project/%2e%2e/secret.txt')).toThrow('Invalid runtime path');
    expect(() => toRuntimePath('/home/project/%00secret.txt')).toThrow('Invalid runtime path');
    expect(() => toRuntimePath('C:\\temp\\file.txt')).toThrow('Invalid runtime path');
    expect(() => toVirtualPath('../secret.txt')).toThrow('Invalid runtime path');
    expect(() => toRuntimePath('/home/project/%zz')).toThrow('Invalid runtime path');
  });

  it('detects redeploy trigger files only at runtime root', () => {
    expect(isRedeployTriggerPath('/home/project/package.json')).toBe(true);
    expect(isRedeployTriggerPath('/home/project/PNPM-lock.yaml')).toBe(true);
    expect(isRedeployTriggerPath('/home/project/src/package.json')).toBe(false);
    expect(isRedeployTriggerPath('/home/project/src/index.ts')).toBe(false);
  });
});
