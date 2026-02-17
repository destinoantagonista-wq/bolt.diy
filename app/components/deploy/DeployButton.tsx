import { lazy, Suspense } from 'react';
import { runtimeFeatures } from '~/lib/runtime/features';
import { classNames } from '~/utils/classNames';

interface DeployButtonProps {
  onVercelDeploy?: () => Promise<void>;
  onNetlifyDeploy?: () => Promise<void>;
  onGitHubDeploy?: () => Promise<void>;
  onGitLabDeploy?: () => Promise<void>;
}

const LegacyDeployButton = lazy(async () => {
  const module = await import('./DeployButton.webcontainer');
  return { default: module.DeployButton };
});

function DisabledDeployButton({ title }: { title: string }) {
  return (
    <div className="flex border border-bolt-elements-borderColor rounded-md overflow-hidden text-sm">
      <button
        disabled
        title={title}
        className={classNames(
          'rounded-md items-center justify-center',
          'cursor-not-allowed opacity-60',
          'px-3 py-1.5 text-xs bg-accent-500 text-white',
          'outline-accent-500 flex gap-1.5',
        )}
      >
        Deploy (V1 indisponivel)
      </button>
    </div>
  );
}

export const DeployButton = (props: DeployButtonProps) => {
  if (!runtimeFeatures.externalDeploy || !runtimeFeatures.legacyWebcontainerRoutes) {
    return <DisabledDeployButton title="External deploy is unavailable in this runtime." />;
  }

  return (
    <Suspense fallback={<DisabledDeployButton title="Loading deploy controls..." />}>
      <LegacyDeployButton {...props} />
    </Suspense>
  );
};
