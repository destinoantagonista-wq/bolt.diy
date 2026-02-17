import { WORK_DIR } from '~/utils/constants';
import { path } from '~/utils/path';

const normalize = (value: string) => value.replaceAll('\\', '/');
const stripLeadingSlash = (value: string) => value.replace(/^\/+/, '');

const ensureNoTraversal = (value: string) => {
  const segments = normalize(value).split('/').filter(Boolean);

  if (segments.some((segment) => segment === '..')) {
    throw new Error('Invalid runtime path');
  }
};

export const toRuntimePath = (virtualPath: string) => {
  const normalized = normalize(virtualPath);

  if (normalized === WORK_DIR || normalized === `${WORK_DIR}/`) {
    return '';
  }

  if (normalized.startsWith(`${WORK_DIR}/`)) {
    const candidate = normalized.slice(WORK_DIR.length + 1);
    ensureNoTraversal(candidate);

    return stripLeadingSlash(candidate);
  }

  const candidate = stripLeadingSlash(normalized);
  ensureNoTraversal(candidate);

  return candidate;
};

export const toVirtualPath = (runtimePath: string) => {
  const safePath = stripLeadingSlash(normalize(runtimePath));
  ensureNoTraversal(safePath);

  if (!safePath) {
    return WORK_DIR;
  }

  return path.join(WORK_DIR, safePath);
};

export const isRedeployTriggerPath = (virtualPath: string) => {
  const runtimePath = toRuntimePath(virtualPath);
  const normalized = runtimePath.toLowerCase();

  return [
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lockb',
    'docker-compose.yml',
  ].includes(normalized);
};
