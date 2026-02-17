export type RuntimeProvider = 'webcontainer' | 'dokploy';

export type RuntimeSessionStatus = 'creating' | 'deploying' | 'ready' | 'error' | 'deleted';

export type RuntimeDeployStatus = 'queued' | 'running' | 'done' | 'error';

export interface RuntimeSession {
  projectId: string;
  environmentId: string;
  composeId: string;
  domain: string;
  previewUrl: string;
  status: RuntimeSessionStatus;
  expiresAt: string;
}

export interface RuntimeTokenClaims {
  v: 1;
  actorId: string;
  chatId: string;
  projectId: string;
  environmentId: string;
  composeId: string;
  domain: string;
  iat: number;
  exp: number;
}

export interface RuntimeFileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  extension?: string;
  modifiedAt: string;
  createdAt?: string;
}

export interface RuntimeMetadata {
  v: 1;
  actorId: string;
  chatId: string;
  createdAt: string;
  lastSeenAt: string;
  idleTtlSec: number;
}
