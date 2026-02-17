import type { Message } from 'ai';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { EnhancedStreamingMessageParser } from '~/lib/runtime/enhanced-message-parser';
import { runtimeProvider } from '~/lib/runtime-provider';
import { workbenchStore } from '~/lib/stores/workbench';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('useMessageParser');

const createMessageParser = (provider: 'webcontainer' | 'dokploy') =>
  new EnhancedStreamingMessageParser({
    runtimeProvider: provider,
    callbacks: {
      onArtifactOpen: (data) => {
        logger.trace('onArtifactOpen', data);

        workbenchStore.showWorkbench.set(true);
        workbenchStore.addArtifact(data);
      },
      onArtifactClose: (data) => {
        logger.trace('onArtifactClose');

        workbenchStore.updateArtifact(data, { closed: true });
      },
      onActionOpen: (data) => {
        logger.trace('onActionOpen', data.action);

        /*
         * File actions are streamed, so we add them immediately to show progress
         * Shell actions are complete when created by enhanced parser, so we wait for close
         */
        if (data.action.type === 'file') {
          workbenchStore.addAction(data);
        }
      },
      onActionClose: (data) => {
        logger.trace('onActionClose', data.action);

        /*
         * Add non-file actions (shell, build, start, etc.) when they close
         * Enhanced parser creates complete shell actions, so they're ready to execute
         */
        if (data.action.type !== 'file') {
          workbenchStore.addAction(data);
        }

        workbenchStore.runAction(data);
      },
      onActionStream: (data) => {
        logger.trace('onActionStream', data.action);
        workbenchStore.runAction(data, true);
      },
    },
  });

const extractTextFromContent = (content: unknown) => {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((item: any) => {
      if (!item || typeof item !== 'object') {
        return '';
      }

      if ((item.type === 'text' || item.type === 'reasoning') && typeof item.text === 'string') {
        return item.text;
      }

      return '';
    })
    .join('');
};

const extractTextFromParts = (message: Message) => {
  const parts = (message as any).parts;

  if (!Array.isArray(parts)) {
    return '';
  }

  return parts
    .map((part: any) => {
      if (!part || typeof part !== 'object') {
        return '';
      }

      if ((part.type === 'text' || part.type === 'reasoning') && typeof part.text === 'string') {
        return part.text;
      }

      return '';
    })
    .join('');
};

const extractTextContent = (message: Message) => {
  const contentText = extractTextFromContent(message.content);

  if (contentText.length > 0) {
    return contentText;
  }

  return extractTextFromParts(message);
};

export function useMessageParser() {
  const [parsedMessages, setParsedMessages] = useState<Record<string, string>>({});
  const messageParser = useMemo(() => createMessageParser(runtimeProvider), [runtimeProvider]);

  useEffect(() => {
    messageParser.reset();
    setParsedMessages({});

    return () => {
      messageParser.reset();
    };
  }, [messageParser]);

  const parseMessages = useCallback(
    (messages: Message[], isLoading: boolean) => {
      let reset = false;

      if (import.meta.env.DEV && !isLoading) {
        reset = true;
        messageParser.reset();
      }

      setParsedMessages((previousParsed) => {
        const nextParsed = reset ? {} : { ...previousParsed };
        const activeAssistantMessageIds = new Set<string>();

        for (const message of messages) {
          if (message.role !== 'assistant') {
            continue;
          }

          const messageId = message.id;
          activeAssistantMessageIds.add(messageId);

          const messageContent = extractTextContent(message);
          const newParsedContent = messageParser.parse(messageId, messageContent);

          if (!isLoading) {
            messageParser.finalize(messageId, messageContent);
          }

          if (newParsedContent.length > 0) {
            nextParsed[messageId] = !reset ? (nextParsed[messageId] || '') + newParsedContent : newParsedContent;
          }
        }

        for (const parsedMessageId of Object.keys(nextParsed)) {
          if (!activeAssistantMessageIds.has(parsedMessageId)) {
            delete nextParsed[parsedMessageId];
          }
        }

        return nextParsed;
      });
    },
    [messageParser],
  );

  return { parsedMessages, parseMessages };
}
