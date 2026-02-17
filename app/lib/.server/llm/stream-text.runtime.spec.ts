import { describe, expect, it } from 'vitest';
import { buildRuntimeAwareSystemPrompts } from './stream-text';
import { DOKPLOY_FORBIDDEN_TERMS } from '~/lib/common/prompts/runtime-profile';

const assertDokploySafety = (prompt: string) => {
  const lowered = prompt.toLowerCase();

  for (const forbiddenTerm of DOKPLOY_FORBIDDEN_TERMS) {
    expect(lowered).not.toContain(forbiddenTerm.toLowerCase());
  }
};

describe('stream-text runtime prompt selection', () => {
  it('uses Dokploy-safe build prompt without late append constraints', () => {
    const prompts = buildRuntimeAwareSystemPrompts({
      runtimeProvider: 'dokploy',
      promptId: 'default',
    });

    assertDokploySafety(prompts.buildSystemPrompt);
    expect(prompts.buildSystemPrompt.toLowerCase()).toContain('dokploy');
    expect(prompts.buildSystemPrompt).not.toContain('<dokploy_v1_runtime_constraints>');
  });

  it('keeps agent mode wrapper while using Dokploy-safe base prompt', () => {
    const prompts = buildRuntimeAwareSystemPrompts({
      runtimeProvider: 'dokploy',
      promptId: 'original',
    });

    assertDokploySafety(prompts.agentSystemPrompt);
    expect(prompts.agentSystemPrompt).toContain('<agent_mode>');
    expect(prompts.agentSystemPrompt).not.toContain('<dokploy_v1_runtime_constraints>');
  });

  it('uses Dokploy discuss prompt without WebContainer operational instructions', () => {
    const prompts = buildRuntimeAwareSystemPrompts({
      runtimeProvider: 'dokploy',
      promptId: 'optimized',
    });

    assertDokploySafety(prompts.discussSystemPrompt);
    expect(prompts.discussSystemPrompt.toLowerCase()).not.toContain('webcontainer');
  });

  it.each(['default', 'original', 'optimized'])(
    'keeps legacy WebContainer behavior for build prompt "%s"',
    (promptId) => {
      const prompts = buildRuntimeAwareSystemPrompts({
        runtimeProvider: 'webcontainer',
        promptId,
      });

      expect(prompts.buildSystemPrompt.toLowerCase()).toContain('webcontainer');
    },
  );
});
