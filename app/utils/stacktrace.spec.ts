import { describe, expect, it } from 'vitest';
import { cleanStackTrace } from './stacktrace';

describe('cleanStackTrace', () => {
  it('normalizes /home/project paths regardless of host', () => {
    const input =
      'Error\n' +
      'at run (https://preview.runtime.test/home/project/src/main.ts:12:3)\n' +
      'at run (https://preview.alt-runtime.test/home/project/src/utils.ts:8:1)';

    const output = cleanStackTrace(input);

    expect(output).toContain('src/main.ts:12:3');
    expect(output).toContain('src/utils.ts:8:1');
    expect(output).not.toContain('/home/project/');
  });

  it('keeps non-url tokens untouched', () => {
    const input = 'TypeError: unexpected token at line 4';
    expect(cleanStackTrace(input)).toBe(input);
  });
});
