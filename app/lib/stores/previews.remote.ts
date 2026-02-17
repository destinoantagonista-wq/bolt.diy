import { atom } from 'nanostores';
import type { PreviewInfo } from './previews';
import { runtimeSessionStore } from './runtimeSession';

const RUNTIME_PREVIEW_PORT = 4173;

export class RemotePreviewsStore {
  previews = atom<PreviewInfo[]>([]);
  #syncSessionState = () => {
    const state = runtimeSessionStore.sessionState.get();
    const previewUrl = state.session?.previewUrl || '';

    if (!previewUrl) {
      this.previews.set([]);
      return;
    }

    const status = state.sessionStatus || state.session?.status;
    const ready = status === 'ready' || status === 'deploying';

    this.previews.set([
      {
        port: RUNTIME_PREVIEW_PORT,
        ready,
        baseUrl: previewUrl,
      },
    ]);
  };

  constructor() {
    runtimeSessionStore.sessionState.subscribe(this.#syncSessionState);
    this.#syncSessionState();
  }

  refreshAllPreviews() {
    this.#syncSessionState();
    runtimeSessionStore.refreshSession().catch(() => {
      // best-effort refresh for remote runtime
    });
  }
}
