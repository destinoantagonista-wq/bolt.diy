import type { WebContainer } from '@webcontainer/api';

let webcontainerPromise: Promise<WebContainer> | undefined;

export const getLegacyWebcontainer = async (): Promise<WebContainer> => {
  if (!webcontainerPromise) {
    webcontainerPromise = import('~/lib/webcontainer').then((module) => module.webcontainer);
  }

  return await webcontainerPromise;
};
