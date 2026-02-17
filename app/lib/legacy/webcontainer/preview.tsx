import { useCallback, useEffect, useRef, useState } from 'react';

const PREVIEW_CHANNEL = 'preview-updates';

export const getWebcontainerPreviewUrl = (previewId: string) => {
  return `https://${previewId}.local-credentialless.webcontainer-api.io`;
};

export function LegacyWebcontainerPreview({ previewId }: { previewId: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const broadcastChannelRef = useRef<BroadcastChannel>();
  const [previewUrl, setPreviewUrl] = useState('');

  const handleRefresh = useCallback(() => {
    if (iframeRef.current && previewUrl) {
      iframeRef.current.src = '';
      requestAnimationFrame(() => {
        if (iframeRef.current) {
          iframeRef.current.src = previewUrl;
        }
      });
    }
  }, [previewUrl]);

  const notifyPreviewReady = useCallback(() => {
    if (broadcastChannelRef.current && previewUrl) {
      broadcastChannelRef.current.postMessage({
        type: 'preview-ready',
        previewId,
        url: previewUrl,
        timestamp: Date.now(),
      });
    }
  }, [previewId, previewUrl]);

  useEffect(() => {
    const supportsBroadcastChannel = typeof window !== 'undefined' && typeof window.BroadcastChannel === 'function';

    if (supportsBroadcastChannel) {
      broadcastChannelRef.current = new window.BroadcastChannel(PREVIEW_CHANNEL);

      broadcastChannelRef.current.onmessage = (event) => {
        if (event.data.previewId === previewId) {
          if (event.data.type === 'refresh-preview' || event.data.type === 'file-change') {
            handleRefresh();
          }
        }
      };
    } else {
      broadcastChannelRef.current = undefined;
    }

    const url = getWebcontainerPreviewUrl(previewId);
    setPreviewUrl(url);

    if (iframeRef.current) {
      iframeRef.current.src = url;
    }

    notifyPreviewReady();

    return () => {
      broadcastChannelRef.current?.close();
    };
  }, [previewId, handleRefresh, notifyPreviewReady]);

  return (
    <div className="w-full h-full">
      <iframe
        ref={iframeRef}
        title="WebContainer Preview"
        className="w-full h-full border-none"
        sandbox="allow-scripts allow-forms allow-popups allow-modals allow-storage-access-by-user-activation allow-same-origin"
        allow="cross-origin-isolated"
        loading="eager"
        onLoad={notifyPreviewReady}
      />
    </div>
  );
}
