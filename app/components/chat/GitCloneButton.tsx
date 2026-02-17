import { lazy, Suspense } from 'react';
import type { Message } from 'ai';
import type { IChatMetadata } from '~/lib/persistence/db';
import { Button } from '~/components/ui/Button';
import { classNames } from '~/utils/classNames';
import { runtimeFeatures } from '~/lib/runtime/features';

interface GitCloneButtonProps {
  className?: string;
  importChat?: (description: string, messages: Message[], metadata?: IChatMetadata) => Promise<void>;
}

const LegacyGitCloneButton = lazy(() => import('./GitCloneButton.webcontainer'));

function DisabledGitCloneButton({ className, title }: { className?: string; title: string }) {
  return (
    <Button
      disabled
      title={title}
      variant="default"
      size="lg"
      className={classNames(
        'gap-2 bg-bolt-elements-background-depth-1',
        'text-bolt-elements-textPrimary',
        'border border-bolt-elements-borderColor',
        'h-10 px-4 py-2 min-w-[120px] justify-center',
        'opacity-60 cursor-not-allowed',
        className,
      )}
    >
      Clone a repo (V1 indisponivel)
    </Button>
  );
}

export default function GitCloneButton(props: GitCloneButtonProps) {
  if (!runtimeFeatures.gitImport) {
    return <DisabledGitCloneButton className={props.className} title="Git import is unavailable in this runtime." />;
  }

  return (
    <Suspense fallback={<DisabledGitCloneButton className={props.className} title="Loading git import controls..." />}>
      <LegacyGitCloneButton {...props} />
    </Suspense>
  );
}
