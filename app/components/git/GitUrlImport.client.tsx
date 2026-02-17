import { lazy, Suspense } from 'react';
import { BaseChat } from '~/components/chat/BaseChat';
import { runtimeFeatures } from '~/lib/runtime/features';

const LegacyGitUrlImport = lazy(async () => {
  const module = await import('./GitUrlImport.webcontainer.client');
  return { default: module.GitUrlImport };
});

export function GitUrlImport() {
  if (!runtimeFeatures.gitImport) {
    return <BaseChat />;
  }

  return (
    <Suspense fallback={<BaseChat />}>
      <LegacyGitUrlImport />
    </Suspense>
  );
}
