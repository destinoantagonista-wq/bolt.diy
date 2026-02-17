import type { Snapshot } from '~/lib/persistence/types';
import { getLegacyWebcontainer } from './runtime';

const stripWorkdirPrefix = (filePath: string, workdir: string) => {
  if (!filePath.startsWith(workdir)) {
    return filePath;
  }

  return filePath.replace(workdir, '');
};

export const restoreLegacyWebcontainerSnapshot = async (snapshot?: Snapshot) => {
  const validSnapshot = snapshot || { chatIndex: '', files: {} };

  if (!validSnapshot?.files) {
    return;
  }

  const container = await getLegacyWebcontainer();

  for (const [filePath, value] of Object.entries(validSnapshot.files)) {
    if (value?.type !== 'folder') {
      continue;
    }

    const runtimePath = stripWorkdirPrefix(filePath, container.workdir);
    await container.fs.mkdir(runtimePath, { recursive: true });
  }

  for (const [filePath, value] of Object.entries(validSnapshot.files)) {
    if (value?.type !== 'file') {
      continue;
    }

    const runtimePath = stripWorkdirPrefix(filePath, container.workdir);
    await container.fs.writeFile(runtimePath, value.content, { encoding: value.isBinary ? undefined : 'utf8' });
  }
};
