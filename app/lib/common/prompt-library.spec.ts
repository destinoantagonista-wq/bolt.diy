import { describe, expect, it } from 'vitest';
import { PromptLibrary, type PromptOptions } from './prompt-library';
import { DOKPLOY_FORBIDDEN_TERMS } from './prompts/runtime-profile';
import type { RuntimeProvider } from '~/lib/.server/runtime/types';

const createOptions = (runtimeProvider: RuntimeProvider): PromptOptions => ({
  cwd: '/home/project',
  allowedHtmlElements: ['div', 'p', 'code'],
  modificationTagName: 'modification',
  runtimeProvider,
  supabase: {
    isConnected: false,
    hasSelectedProject: false,
  },
});

describe('PromptLibrary runtime-aware selection', () => {
  it.each(['default', 'original', 'optimized'])('generates Dokploy-safe prompt for "%s"', (promptId) => {
    const prompt = PromptLibrary.getPropmtFromLibrary(promptId, createOptions('dokploy'));
    const lowered = prompt.toLowerCase();

    for (const forbiddenTerm of DOKPLOY_FORBIDDEN_TERMS) {
      expect(lowered).not.toContain(forbiddenTerm.toLowerCase());
    }

    expect(prompt).toContain('<boltAction type="file">');
  });

  it.each(['default', 'original', 'optimized'])('keeps WebContainer prompt behavior for "%s"', (promptId) => {
    const prompt = PromptLibrary.getPropmtFromLibrary(promptId, createOptions('webcontainer'));
    expect(prompt.toLowerCase()).toContain('webcontainer');
  });

  it('falls back to safe Dokploy prompt when forbidden term is detected', () => {
    const existing = PromptLibrary.library.unsafe_runtime_prompt;

    PromptLibrary.library.unsafe_runtime_prompt = {
      label: 'Unsafe',
      description: 'Unsafe prompt for runtime safety test',
      get: () =>
        '<boltArtifact id="unsafe" title="Unsafe"><boltAction type="shell">echo fail</boltAction></boltArtifact>',
    };

    try {
      const prompt = PromptLibrary.getPropmtFromLibrary('unsafe_runtime_prompt', createOptions('dokploy'));
      expect(prompt.toLowerCase()).not.toContain('type="shell"');
      expect(prompt).toContain('<boltAction type="file">');
    } finally {
      if (existing) {
        PromptLibrary.library.unsafe_runtime_prompt = existing;
      } else {
        delete PromptLibrary.library.unsafe_runtime_prompt;
      }
    }
  });
});
