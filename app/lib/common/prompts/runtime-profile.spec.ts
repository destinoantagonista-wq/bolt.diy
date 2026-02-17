import { describe, expect, it } from 'vitest';
import { DOKPLOY_FORBIDDEN_TERMS, findForbiddenPromptTerm, getRuntimePromptProfile } from './runtime-profile';

describe('runtime-profile', () => {
  it('returns canonical block groups for Dokploy runtime', () => {
    const profile = getRuntimePromptProfile('dokploy');

    expect(profile.systemConstraints.length).toBeGreaterThan(0);
    expect(profile.artifactActionPolicy.length).toBeGreaterThan(0);
    expect(profile.runtimeLimitations.length).toBeGreaterThan(0);
    expect(profile.discussModeConstraints.length).toBeGreaterThan(0);
  });

  it('exposes expected forbidden terms for Dokploy prompt safety checks', () => {
    expect(DOKPLOY_FORBIDDEN_TERMS).toContain('type="shell"');
    expect(DOKPLOY_FORBIDDEN_TERMS).toContain('type="start"');
    expect(DOKPLOY_FORBIDDEN_TERMS).toContain('type="build"');
    expect(DOKPLOY_FORBIDDEN_TERMS).toContain('available shell commands');
  });

  it('detects forbidden Dokploy terms in generated prompts', () => {
    const prompt = 'This output includes type="shell" action and Available shell commands.';
    expect(findForbiddenPromptTerm('dokploy', prompt)).toBeDefined();
  });

  it('does not enforce Dokploy forbidden terms for WebContainer runtime', () => {
    const prompt = 'This output includes type="shell" action.';
    expect(findForbiddenPromptTerm('webcontainer', prompt)).toBeUndefined();
  });
});
