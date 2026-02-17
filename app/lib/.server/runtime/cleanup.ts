import { DokployClient } from './dokploy-client';
import { parseRuntimeMetadata } from './metadata';

const actorCleanupLocks = new Set<string>();

const isExpired = (lastSeenAt: string, idleTtlSec: number) => {
  const ts = Date.parse(lastSeenAt);

  if (!Number.isFinite(ts)) {
    return false;
  }

  return ts + idleTtlSec * 1000 < Date.now();
};

export const cleanupExpiredActorSessions = async (client: DokployClient, actorId: string, requestId?: string) => {
  if (actorCleanupLocks.has(actorId)) {
    return;
  }

  actorCleanupLocks.add(actorId);

  try {
    const projects = await client.projectAll(requestId);

    for (const project of projects || []) {
      for (const environment of project.environments || []) {
        for (const compose of environment.compose || []) {
          const metadata = parseRuntimeMetadata(compose.description);

          if (!metadata || metadata.actorId !== actorId) {
            continue;
          }

          if (!isExpired(metadata.lastSeenAt, metadata.idleTtlSec)) {
            continue;
          }

          try {
            await client.composeDelete(compose.composeId, true, requestId);
          } catch {
            // Best-effort cleanup.
          }
        }
      }
    }
  } finally {
    actorCleanupLocks.delete(actorId);
  }
};
