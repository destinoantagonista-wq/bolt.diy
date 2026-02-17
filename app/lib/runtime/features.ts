import { isDokployRuntime, isWebcontainerLegacyEnabled } from '~/lib/runtime-provider';

export interface RuntimeFeatureFlags {
  externalDeploy: boolean;
  gitImport: boolean;
  terminal: boolean;
  expoQr: boolean;
  legacyWebcontainerRoutes: boolean;
}

export const runtimeFeatures: RuntimeFeatureFlags = {
  externalDeploy: !isDokployRuntime && isWebcontainerLegacyEnabled,
  gitImport: !isDokployRuntime && isWebcontainerLegacyEnabled,
  terminal: !isDokployRuntime,
  expoQr: !isDokployRuntime,
  legacyWebcontainerRoutes: !isDokployRuntime && isWebcontainerLegacyEnabled,
};
