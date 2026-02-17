import type { RuntimeProvider } from '~/lib/.server/runtime/types';

export interface RuntimePromptProfile {
  systemConstraints: string;
  artifactActionPolicy: string;
  runtimeLimitations: string;
  discussModeConstraints: string;
}

export const DOKPLOY_FORBIDDEN_TERMS = [
  'type="shell"',
  'type="start"',
  'type="build"',
  'available shell commands',
  'you are operating in an environment called webcontainer',
  'you operate in webcontainer',
  'operating in webcontainer',
  'webcontainer',
];

const WEBCONTAINER_PROMPT_PROFILE: RuntimePromptProfile = {
  systemConstraints: `
  - Runtime: in-browser WebContainer session.
  - You may use file and terminal based actions.
  - Legacy behavior stays unchanged for compatibility.
  `,
  artifactActionPolicy: `
  - You may use file, shell, and start actions when appropriate.
  - Keep action order deterministic and dependency-safe.
  `,
  runtimeLimitations: `
  - Runtime limitations follow existing WebContainer constraints.
  `,
  discussModeConstraints: `
  - Discuss mode should keep guidance aligned with WebContainer capabilities.
  `,
};

const DOKPLOY_PROMPT_PROFILE: RuntimePromptProfile = {
  systemConstraints: `
  - Runtime: remote Dokploy V1 workspace.
  - Primary capability is editing files and validating via remote preview.
  - Terminal execution flows are unavailable in this runtime.
  - Do not request the user to run commands manually.
  `,
  artifactActionPolicy: `
  - Output must prioritize <boltAction type="file"> updates.
  - Never emit terminal-oriented actions.
  - Keep a single coherent artifact and deterministic file-order updates.
  `,
  runtimeLimitations: `
  - V1 excludes git clone/import workflows.
  - External deploy providers are unavailable.
  - Expo QR workflows are unavailable.
  - Search support is limited to file name/path matching.
  `,
  discussModeConstraints: `
  - Plans must target file edits and preview checks only.
  - Avoid advising command execution or terminal recovery steps.
  `,
};

const RUNTIME_PROMPT_PROFILES: Record<RuntimeProvider, RuntimePromptProfile> = {
  webcontainer: WEBCONTAINER_PROMPT_PROFILE,
  dokploy: DOKPLOY_PROMPT_PROFILE,
};

export const getRuntimePromptProfile = (runtimeProvider: RuntimeProvider): RuntimePromptProfile => {
  return RUNTIME_PROMPT_PROFILES[runtimeProvider];
};

export const findForbiddenPromptTerm = (runtimeProvider: RuntimeProvider, prompt: string): string | undefined => {
  if (runtimeProvider !== 'dokploy') {
    return undefined;
  }

  const lowerPrompt = prompt.toLowerCase();

  return DOKPLOY_FORBIDDEN_TERMS.find((term) => lowerPrompt.includes(term.toLowerCase()));
};
