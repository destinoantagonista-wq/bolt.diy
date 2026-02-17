import type { RuntimeMetadata } from './types';

export const RUNTIME_METADATA_PREFIX = 'BOLT_RUNTIME:';

export const parseRuntimeMetadata = (description?: string | null): RuntimeMetadata | null => {
  if (!description || !description.startsWith(RUNTIME_METADATA_PREFIX)) {
    return null;
  }

  const payload = description.slice(RUNTIME_METADATA_PREFIX.length);

  try {
    const parsed = JSON.parse(payload) as RuntimeMetadata;

    if (!parsed || parsed.v !== 1 || !parsed.actorId || !parsed.chatId) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
};

export const formatRuntimeMetadata = (metadata: RuntimeMetadata) => {
  return `${RUNTIME_METADATA_PREFIX}${JSON.stringify(metadata)}`;
};
