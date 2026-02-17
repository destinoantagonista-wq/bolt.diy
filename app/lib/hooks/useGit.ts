export const GIT_RUNTIME_UNSUPPORTED = 'unsupported_in_v1';

export type GitCloneFile = {
  data: string | Uint8Array;
  encoding?: string;
};

export type GitCloneResult = {
  workdir: string;
  data: Record<string, GitCloneFile>;
};

export type GitUnsupportedError = Error & {
  code: typeof GIT_RUNTIME_UNSUPPORTED;
};

const createUnsupportedError = (): GitUnsupportedError => {
  const error = new Error('Git import is unavailable in Dokploy runtime V1.') as GitUnsupportedError;
  error.code = GIT_RUNTIME_UNSUPPORTED;

  return error;
};

export function useGit() {
  return {
    ready: false,
    unsupportedReason: GIT_RUNTIME_UNSUPPORTED,
    gitClone: async (_url: string): Promise<GitCloneResult> => {
      throw createUnsupportedError();
    },
  };
}
