import type { RuntimeRolloutCohort } from './types';

export interface RuntimeRolloutSelection {
  bucket: number;
  percent: number;
  rolloutCohort: RuntimeRolloutCohort;
}

const normalizePercent = (value: number) => {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const bounded = Math.trunc(value);

  if (bounded <= 0) {
    return 0;
  }

  if (bounded >= 100) {
    return 100;
  }

  return bounded;
};

const stableHash32 = (input: string) => {
  let hash = 2166136261;

  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }

  return hash >>> 0;
};

export const resolveRolloutBucket = (actorId: string, chatId: string) => {
  return stableHash32(`${actorId}:${chatId}`) % 100;
};

export const selectRuntimeRolloutCohort = ({
  actorId,
  chatId,
  canaryPercent,
}: {
  actorId: string;
  chatId: string;
  canaryPercent: number;
}): RuntimeRolloutSelection => {
  const percent = normalizePercent(canaryPercent);
  const bucket = resolveRolloutBucket(actorId, chatId);

  return {
    bucket,
    percent,
    rolloutCohort: percent > 0 && bucket < percent ? 'canary' : 'stable',
  };
};
