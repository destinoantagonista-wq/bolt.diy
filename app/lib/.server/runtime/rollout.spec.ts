import { describe, expect, it } from 'vitest';
import { resolveRolloutBucket, selectRuntimeRolloutCohort } from './rollout';

describe('runtime rollout', () => {
  it('is deterministic for the same actor/chat pair', () => {
    const first = resolveRolloutBucket('actor-1', 'chat-1');
    const second = resolveRolloutBucket('actor-1', 'chat-1');

    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(100);
  });

  it('uses stable cohort when canary percent is 0', () => {
    const selection = selectRuntimeRolloutCohort({
      actorId: 'actor-a',
      chatId: 'chat-a',
      canaryPercent: 0,
    });

    expect(selection.percent).toBe(0);
    expect(selection.rolloutCohort).toBe('stable');
  });

  it('uses canary cohort for all traffic at 100 percent', () => {
    const selection = selectRuntimeRolloutCohort({
      actorId: 'actor-a',
      chatId: 'chat-a',
      canaryPercent: 100,
    });

    expect(selection.percent).toBe(100);
    expect(selection.rolloutCohort).toBe('canary');
  });

  it('uses bucket threshold for intermediate percent', () => {
    const bucket = resolveRolloutBucket('actor-threshold', 'chat-threshold');
    const belowBucket = Math.max(0, bucket - 1);
    const atBucket = bucket;
    const aboveBucket = Math.min(100, bucket + 1);

    const below = selectRuntimeRolloutCohort({
      actorId: 'actor-threshold',
      chatId: 'chat-threshold',
      canaryPercent: belowBucket,
    });
    const equal = selectRuntimeRolloutCohort({
      actorId: 'actor-threshold',
      chatId: 'chat-threshold',
      canaryPercent: atBucket,
    });
    const above = selectRuntimeRolloutCohort({
      actorId: 'actor-threshold',
      chatId: 'chat-threshold',
      canaryPercent: aboveBucket,
    });

    expect(below.rolloutCohort).toBe('stable');
    expect(equal.rolloutCohort).toBe('stable');
    expect(above.rolloutCohort).toBe('canary');
  });
});
