import { useStore } from '@nanostores/react';
import type { Message } from 'ai';
import { useChat } from '@ai-sdk/react';
import { useAnimate } from 'framer-motion';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { useMessageParser, usePromptEnhancer, useShortcuts } from '~/lib/hooks';
import { description, useChatHistory } from '~/lib/persistence';
import { chatStore } from '~/lib/stores/chat';
import { workbenchStore } from '~/lib/stores/workbench';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, PROMPT_COOKIE_KEY, PROVIDER_LIST } from '~/utils/constants';
import { cubicEasingFn } from '~/utils/easings';
import { createScopedLogger, renderLogger } from '~/utils/logger';
import { BaseChat } from './BaseChat';
import Cookies from 'js-cookie';
import { debounce } from '~/utils/debounce';
import { useSettings } from '~/lib/hooks/useSettings';
import type { ProviderInfo } from '~/types/model';
import { useSearchParams } from '@remix-run/react';
import { createSampler } from '~/utils/sampler';
import { getTemplates, selectStarterTemplate } from '~/utils/selectStarterTemplate';
import { logStore } from '~/lib/stores/logs';
import { streamingState } from '~/lib/stores/streaming';
import { filesToArtifacts } from '~/utils/fileUtils';
import { supabaseConnection } from '~/lib/stores/supabase';
import { defaultDesignScheme, type DesignScheme } from '~/types/design-scheme';
import type { ElementInfo } from '~/components/workbench/Inspector';
import type { TextUIPart, FileUIPart, Attachment } from '@ai-sdk/ui-utils';
import { useMCPStore } from '~/lib/stores/mcp';
import type { LlmErrorAlertType } from '~/types/actions';
import type { AgentQueueItem } from '~/types/agent-queue';

const logger = createScopedLogger('Chat');

export function Chat() {
  renderLogger.trace('Chat');

  const { ready, initialMessages, storeMessageHistory, importChat, exportChat } = useChatHistory();
  const title = useStore(description);
  useEffect(() => {
    workbenchStore.setReloadedMessages(initialMessages.map((m) => m.id));
  }, [initialMessages]);

  return (
    <>
      {ready && (
        <ChatImpl
          description={title}
          initialMessages={initialMessages}
          exportChat={exportChat}
          storeMessageHistory={storeMessageHistory}
          importChat={importChat}
        />
      )}
    </>
  );
}

const processSampledMessages = createSampler(
  (options: {
    messages: Message[];
    initialMessages: Message[];
    isLoading: boolean;
    parseMessages: (messages: Message[], isLoading: boolean) => void;
    storeMessageHistory: (messages: Message[]) => Promise<void>;
  }) => {
    const { messages, initialMessages, isLoading, parseMessages, storeMessageHistory } = options;
    parseMessages(messages, isLoading);

    if (messages.length > initialMessages.length) {
      storeMessageHistory(messages).catch((error) => toast.error(error.message));
    }
  },
  50,
);

const extractTextFromContent = (content: unknown) => {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
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

const getTextFromParts = (message: Message) => {
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

const getTextMessageContent = (message: Message) => {
  const contentText = extractTextFromContent(message.content);

  if (contentText.trim().length > 0) {
    return contentText;
  }

  return getTextFromParts(message);
};

interface ChatProps {
  initialMessages: Message[];
  storeMessageHistory: (messages: Message[]) => Promise<void>;
  importChat: (description: string, messages: Message[]) => Promise<void>;
  exportChat: () => void;
  description?: string;
}

export const ChatImpl = memo(
  ({ description, initialMessages, storeMessageHistory, importChat, exportChat }: ChatProps) => {
    useShortcuts();

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [chatStarted, setChatStarted] = useState(initialMessages.length > 0);
    const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
    const [imageDataList, setImageDataList] = useState<string[]>([]);
    const [searchParams, setSearchParams] = useSearchParams();
    const [fakeLoading, setFakeLoading] = useState(false);
    const files = useStore(workbenchStore.files);
    const [designScheme, setDesignScheme] = useState<DesignScheme>(defaultDesignScheme);
    const actionAlert = useStore(workbenchStore.alert);
    const deployAlert = useStore(workbenchStore.deployAlert);
    const supabaseConn = useStore(supabaseConnection);
    const selectedProject = supabaseConn.stats?.projects?.find(
      (project) => project.id === supabaseConn.selectedProjectId,
    );
    const supabaseAlert = useStore(workbenchStore.supabaseAlert);
    const { activeProviders, promptId, autoSelectTemplate, contextOptimizationEnabled } = useSettings();
    const [llmErrorAlert, setLlmErrorAlert] = useState<LlmErrorAlertType | undefined>(undefined);
    const [model, setModel] = useState(() => {
      const savedModel = Cookies.get('selectedModel');
      return savedModel || DEFAULT_MODEL;
    });
    const [provider, setProvider] = useState(() => {
      const savedProvider = Cookies.get('selectedProvider');
      return (PROVIDER_LIST.find((p) => p.name === savedProvider) || DEFAULT_PROVIDER) as ProviderInfo;
    });
    const { showChat } = useStore(chatStore);
    const [animationScope, animate] = useAnimate();
    const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
    const [chatMode, setChatMode] = useState<'discuss' | 'build' | 'agent'>('build');
    const [agentQueue, setAgentQueue] = useState<AgentQueueItem[]>([]);
    const [isAgentQueuePaused, setIsAgentQueuePaused] = useState(false);
    const [activeAgentQueueItem, setActiveAgentQueueItem] = useState<AgentQueueItem | null>(null);
    const activeAgentQueueItemRef = useRef<AgentQueueItem | null>(null);
    const [selectedElement, setSelectedElement] = useState<ElementInfo | null>(null);
    const mcpSettings = useMCPStore((state) => state.settings);

    const {
      messages,
      isLoading,
      input,
      handleInputChange,
      setInput,
      stop,
      append,
      setMessages,
      reload,
      error,
      data: chatData,
      setData,
      addToolResult,
    } = useChat({
      api: '/api/chat',
      body: {
        apiKeys,
        files,
        promptId,
        contextOptimization: contextOptimizationEnabled,
        chatMode,
        designScheme,
        supabase: {
          isConnected: supabaseConn.isConnected,
          hasSelectedProject: !!selectedProject,
          credentials: {
            supabaseUrl: supabaseConn?.credentials?.supabaseUrl,
            anonKey: supabaseConn?.credentials?.anonKey,
          },
        },
        maxLLMSteps: mcpSettings.maxLLMSteps,
      },
      sendExtraMessageFields: true,
      onError: (e) => {
        if (activeAgentQueueItemRef.current) {
          activeAgentQueueItemRef.current = null;
          setActiveAgentQueueItem(null);
        }

        setFakeLoading(false);
        handleError(e, 'chat');
      },
      onFinish: (message, response) => {
        if (activeAgentQueueItemRef.current) {
          activeAgentQueueItemRef.current = null;
          setActiveAgentQueueItem(null);
        }

        const usage = response.usage;
        setData(undefined);

        if (usage) {
          console.log('Token usage:', usage);
          logStore.logProvider('Chat response completed', {
            component: 'Chat',
            action: 'response',
            model,
            provider: provider.name,
            usage,
            messageLength: getTextMessageContent(message).length,
          });
        }

        logger.debug('Finished streaming');
      },
      initialMessages,
      initialInput: Cookies.get(PROMPT_COOKIE_KEY) || '',
    });
    useEffect(() => {
      const prompt = searchParams.get('prompt');

      // console.log(prompt, searchParams, model, provider);

      if (prompt) {
        setSearchParams({});
        runAnimation();
        append({
          role: 'user',
          content: `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${prompt}`,
        });
      }
    }, [model, provider, searchParams]);

    const { enhancingPrompt, promptEnhanced, enhancePrompt, resetEnhancer } = usePromptEnhancer();
    const { parsedMessages, parseMessages } = useMessageParser();

    const TEXTAREA_MAX_HEIGHT = chatStarted ? 400 : 200;

    useEffect(() => {
      chatStore.setKey('started', initialMessages.length > 0);
    }, []);

    useEffect(() => {
      processSampledMessages({
        messages,
        initialMessages,
        isLoading,
        parseMessages,
        storeMessageHistory,
      });
    }, [messages, isLoading, parseMessages]);

    const scrollTextArea = () => {
      const textarea = textareaRef.current;

      if (textarea) {
        textarea.scrollTop = textarea.scrollHeight;
      }
    };

    const abort = () => {
      stop();
      chatStore.setKey('aborted', true);
      workbenchStore.abortAllActions();

      if (chatMode === 'agent' && activeAgentQueueItemRef.current) {
        setIsAgentQueuePaused(true);
        activeAgentQueueItemRef.current = null;
        setActiveAgentQueueItem(null);
      }

      logStore.logProvider('Chat response aborted', {
        component: 'Chat',
        action: 'abort',
        model,
        provider: provider.name,
      });
    };

    const handleError = useCallback(
      (error: any, context: 'chat' | 'template' | 'llmcall' = 'chat') => {
        logger.error(`${context} request failed`, error);

        stop();
        setFakeLoading(false);

        let errorInfo = {
          message: 'An unexpected error occurred',
          isRetryable: true,
          statusCode: 500,
          provider: provider.name,
          type: 'unknown' as const,
          retryDelay: 0,
        };

        if (error.message) {
          try {
            const parsed = JSON.parse(error.message);

            if (parsed.error || parsed.message) {
              errorInfo = { ...errorInfo, ...parsed };
            } else {
              errorInfo.message = error.message;
            }
          } catch {
            errorInfo.message = error.message;
          }
        }

        let errorType: LlmErrorAlertType['errorType'] = 'unknown';
        let title = 'Request Failed';

        if (errorInfo.statusCode === 401 || errorInfo.message.toLowerCase().includes('api key')) {
          errorType = 'authentication';
          title = 'Authentication Error';
        } else if (errorInfo.statusCode === 429 || errorInfo.message.toLowerCase().includes('rate limit')) {
          errorType = 'rate_limit';
          title = 'Rate Limit Exceeded';
        } else if (errorInfo.message.toLowerCase().includes('quota')) {
          errorType = 'quota';
          title = 'Quota Exceeded';
        } else if (errorInfo.statusCode >= 500) {
          errorType = 'network';
          title = 'Server Error';
        }

        logStore.logError(`${context} request failed`, error, {
          component: 'Chat',
          action: 'request',
          error: errorInfo.message,
          context,
          retryable: errorInfo.isRetryable,
          errorType,
          provider: provider.name,
        });

        // Create API error alert
        setLlmErrorAlert({
          type: 'error',
          title,
          description: errorInfo.message,
          provider: provider.name,
          errorType,
        });
        setData([]);
      },
      [provider.name, stop],
    );

    const clearApiErrorAlert = useCallback(() => {
      setLlmErrorAlert(undefined);
    }, []);

    useEffect(() => {
      const textarea = textareaRef.current;

      if (textarea) {
        textarea.style.height = 'auto';

        const scrollHeight = textarea.scrollHeight;

        textarea.style.height = `${Math.min(scrollHeight, TEXTAREA_MAX_HEIGHT)}px`;
        textarea.style.overflowY = scrollHeight > TEXTAREA_MAX_HEIGHT ? 'auto' : 'hidden';
      }
    }, [input, textareaRef]);

    const runAnimation = async () => {
      if (chatStarted) {
        return;
      }

      await Promise.all([
        animate('#examples', { opacity: 0, display: 'none' }, { duration: 0.1 }),
        animate('#intro', { opacity: 0, flex: 1 }, { duration: 0.2, ease: cubicEasingFn }),
      ]);

      chatStore.setKey('started', true);

      setChatStarted(true);
    };

    // Helper function to create message parts array from text and images
    const createMessageParts = (text: string, images: string[] = []): Array<TextUIPart | FileUIPart> => {
      // Create an array of properly typed message parts
      const parts: Array<TextUIPart | FileUIPart> = [
        {
          type: 'text',
          text,
        },
      ];

      // Add image parts if any
      images.forEach((imageData) => {
        // Extract correct MIME type from the data URL
        const mimeType = imageData.split(';')[0].split(':')[1] || 'image/jpeg';

        // Create file part according to AI SDK format
        parts.push({
          type: 'file',
          mimeType,
          data: imageData.replace(/^data:image\/[^;]+;base64,/, ''),
        });
      });

      return parts;
    };

    // Helper function to convert File[] to Attachment[] for AI SDK
    const filesToAttachments = async (files: File[]): Promise<Attachment[] | undefined> => {
      if (files.length === 0) {
        return undefined;
      }

      const attachments = await Promise.all(
        files.map(
          (file) =>
            new Promise<Attachment>((resolve) => {
              const reader = new FileReader();

              reader.onloadend = () => {
                resolve({
                  name: file.name,
                  contentType: file.type,
                  url: reader.result as string,
                });
              };
              reader.readAsDataURL(file);
            }),
        ),
      );

      return attachments;
    };

    const createAgentQueueId = () => `agent-queue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const clearComposerState = () => {
      setInput('');
      Cookies.remove(PROMPT_COOKIE_KEY);
      setUploadedFiles([]);
      setImageDataList([]);
      resetEnhancer();
      textareaRef.current?.blur();
    };

    const applySelectedElementContext = (messageContent: string) => {
      if (!selectedElement) {
        return messageContent;
      }

      const elementInfo = `<div class=\"__boltSelectedElement__\" data-element='${JSON.stringify(selectedElement)}'>${JSON.stringify(`${selectedElement.displayText}`)}</div>`;

      return messageContent + elementInfo;
    };

    const createAgentQueueItem = (messageContent: string): AgentQueueItem => {
      return {
        id: createAgentQueueId(),
        prompt: messageContent,
        createdAt: Date.now(),
        uploadedFiles: [...uploadedFiles],
        imageDataList: [...imageDataList],
      };
    };

    const dispatchMessage = async (
      messageContent: string,
      options?: {
        queuedUploadedFiles?: File[];
        queuedImageDataList?: string[];
        clearComposer?: boolean;
      },
    ) => {
      if (!messageContent?.trim()) {
        return;
      }

      if (isLoading) {
        abort();
        return;
      }

      const effectiveUploadedFiles = options?.queuedUploadedFiles ?? uploadedFiles;
      const effectiveImageDataList = options?.queuedImageDataList ?? imageDataList;
      const shouldClearComposer = options?.clearComposer !== false;
      const finalMessageContent = messageContent;

      runAnimation();

      if (!chatStarted) {
        setFakeLoading(true);

        if (autoSelectTemplate) {
          const { template, title } = await selectStarterTemplate({
            message: finalMessageContent,
            model,
            provider,
          });

          if (template !== 'blank') {
            const temResp = await getTemplates(template, title).catch((e) => {
              if (e.message.includes('rate limit')) {
                toast.warning('Rate limit exceeded. Skipping starter template\n Continuing with blank template');
              } else {
                toast.warning('Failed to import starter template\n Continuing with blank template');
              }

              return null;
            });

            if (temResp) {
              const { assistantMessage, userMessage } = temResp;
              const userMessageText = `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${finalMessageContent}`;

              setMessages([
                {
                  id: `1-${new Date().getTime()}`,
                  role: 'user',
                  content: userMessageText,
                  parts: createMessageParts(userMessageText, effectiveImageDataList),
                },
                {
                  id: `2-${new Date().getTime()}`,
                  role: 'assistant',
                  content: assistantMessage,
                },
                {
                  id: `3-${new Date().getTime()}`,
                  role: 'user',
                  content: `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${userMessage}`,
                  annotations: ['hidden'],
                },
              ]);

              const reloadOptions =
                effectiveUploadedFiles.length > 0
                  ? { experimental_attachments: await filesToAttachments(effectiveUploadedFiles) }
                  : undefined;

              reload(reloadOptions);
              setFakeLoading(false);

              if (shouldClearComposer) {
                clearComposerState();
              }

              return;
            }
          }
        }

        const userMessageText = `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${finalMessageContent}`;
        const attachments =
          effectiveUploadedFiles.length > 0 ? await filesToAttachments(effectiveUploadedFiles) : undefined;

        setMessages([
          {
            id: `${new Date().getTime()}`,
            role: 'user',
            content: userMessageText,
            parts: createMessageParts(userMessageText, effectiveImageDataList),
            experimental_attachments: attachments,
          },
        ]);
        reload(attachments ? { experimental_attachments: attachments } : undefined);
        setFakeLoading(false);

        if (shouldClearComposer) {
          clearComposerState();
        }

        return;
      }

      if (error != null) {
        setMessages(messages.slice(0, -1));
      }

      const modifiedFiles = workbenchStore.getModifiedFiles();
      chatStore.setKey('aborted', false);

      if (modifiedFiles !== undefined) {
        const userUpdateArtifact = filesToArtifacts(modifiedFiles, `${Date.now()}`);
        const messageText = `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${userUpdateArtifact}${finalMessageContent}`;
        const attachmentOptions =
          effectiveUploadedFiles.length > 0
            ? { experimental_attachments: await filesToAttachments(effectiveUploadedFiles) }
            : undefined;

        append(
          {
            role: 'user',
            content: messageText,
            parts: createMessageParts(messageText, effectiveImageDataList),
          },
          attachmentOptions,
        );

        workbenchStore.resetAllFileModifications();
      } else {
        const messageText = `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${finalMessageContent}`;
        const attachmentOptions =
          effectiveUploadedFiles.length > 0
            ? { experimental_attachments: await filesToAttachments(effectiveUploadedFiles) }
            : undefined;

        append(
          {
            role: 'user',
            content: messageText,
            parts: createMessageParts(messageText, effectiveImageDataList),
          },
          attachmentOptions,
        );
      }

      if (shouldClearComposer) {
        clearComposerState();
      }
    };

    const sendMessage = async (_event: React.UIEvent, messageInput?: string) => {
      const rawContent = messageInput || input;

      if (!rawContent?.trim()) {
        return;
      }

      const preparedContent = applySelectedElementContext(rawContent);

      if (chatMode === 'agent') {
        const queueItem = createAgentQueueItem(preparedContent);
        setAgentQueue((previousQueue) => [...previousQueue, queueItem]);
        runAnimation();

        if (
          isLoading ||
          fakeLoading ||
          activeAgentQueueItemRef.current ||
          agentQueue.length > 0 ||
          isAgentQueuePaused
        ) {
          toast.info('Task added to Agent queue');
        }

        clearComposerState();

        return;
      }

      await dispatchMessage(preparedContent, { clearComposer: true });
    };

    useEffect(() => {
      if (chatMode !== 'agent') {
        return;
      }

      if (
        isAgentQueuePaused ||
        isLoading ||
        fakeLoading ||
        activeAgentQueueItemRef.current ||
        agentQueue.length === 0
      ) {
        return;
      }

      const [nextQueueItem, ...remainingQueue] = agentQueue;

      setAgentQueue(remainingQueue);
      activeAgentQueueItemRef.current = nextQueueItem;
      setActiveAgentQueueItem(nextQueueItem);

      void dispatchMessage(nextQueueItem.prompt, {
        queuedUploadedFiles: nextQueueItem.uploadedFiles,
        queuedImageDataList: nextQueueItem.imageDataList,
        clearComposer: false,
      }).catch((error) => {
        logger.error('Failed to dispatch queued Agent task', error);
        activeAgentQueueItemRef.current = null;
        setActiveAgentQueueItem(null);
      });
    }, [chatMode, isAgentQueuePaused, isLoading, fakeLoading, agentQueue]);

    const toggleAgentQueuePause = () => {
      setIsAgentQueuePaused((previous) => !previous);
    };

    const clearAgentQueue = () => {
      setAgentQueue([]);
    };

    const moveAgentQueueItem = (id: string, direction: 'up' | 'down') => {
      setAgentQueue((previousQueue) => {
        const currentIndex = previousQueue.findIndex((item) => item.id === id);

        if (currentIndex === -1) {
          return previousQueue;
        }

        const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;

        if (targetIndex < 0 || targetIndex >= previousQueue.length) {
          return previousQueue;
        }

        const reorderedQueue = [...previousQueue];
        const [selectedItem] = reorderedQueue.splice(currentIndex, 1);
        reorderedQueue.splice(targetIndex, 0, selectedItem);

        return reorderedQueue;
      });
    };

    const editAgentQueueItem = (id: string, prompt: string) => {
      const trimmedPrompt = prompt.trim();

      if (!trimmedPrompt) {
        return;
      }

      setAgentQueue((previousQueue) =>
        previousQueue.map((item) =>
          item.id === id
            ? {
                ...item,
                prompt: trimmedPrompt,
              }
            : item,
        ),
      );
    };

    const copyAgentQueueItem = (id: string) => {
      setAgentQueue((previousQueue) => {
        const itemIndex = previousQueue.findIndex((item) => item.id === id);

        if (itemIndex === -1) {
          return previousQueue;
        }

        const sourceItem = previousQueue[itemIndex];
        const copyItem: AgentQueueItem = {
          ...sourceItem,
          id: createAgentQueueId(),
          createdAt: Date.now(),
          uploadedFiles: [...sourceItem.uploadedFiles],
          imageDataList: [...sourceItem.imageDataList],
        };
        const nextQueue = [...previousQueue];
        nextQueue.splice(itemIndex + 1, 0, copyItem);

        return nextQueue;
      });
    };

    const removeAgentQueueItem = (id: string) => {
      setAgentQueue((previousQueue) => previousQueue.filter((item) => item.id !== id));
    };

    const repeatAgentQueueItem = (id: string, count: number) => {
      const safeCount = Math.min(50, Math.max(1, Math.floor(count || 1)));

      setAgentQueue((previousQueue) => {
        const itemIndex = previousQueue.findIndex((item) => item.id === id);

        if (itemIndex === -1) {
          return previousQueue;
        }

        const sourceItem = previousQueue[itemIndex];
        const repeatedItems: AgentQueueItem[] = Array.from({ length: safeCount }).map(() => ({
          ...sourceItem,
          id: createAgentQueueId(),
          createdAt: Date.now(),
          uploadedFiles: [...sourceItem.uploadedFiles],
          imageDataList: [...sourceItem.imageDataList],
        }));
        const nextQueue = [...previousQueue];
        nextQueue.splice(itemIndex + 1, 0, ...repeatedItems);

        return nextQueue;
      });
    };

    /**
     * Handles the change event for the textarea and updates the input state.
     * @param event - The change event from the textarea.
     */
    const onTextareaChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      handleInputChange(event);
    };

    /**
     * Debounced function to cache the prompt in cookies.
     * Caches the trimmed value of the textarea input after a delay to optimize performance.
     */
    const debouncedCachePrompt = useCallback(
      debounce((event: React.ChangeEvent<HTMLTextAreaElement>) => {
        const trimmedValue = event.target.value.trim();
        Cookies.set(PROMPT_COOKIE_KEY, trimmedValue, { expires: 30 });
      }, 1000),
      [],
    );

    useEffect(() => {
      const storedApiKeys = Cookies.get('apiKeys');

      if (storedApiKeys) {
        setApiKeys(JSON.parse(storedApiKeys));
      }
    }, []);

    const handleModelChange = (newModel: string) => {
      setModel(newModel);
      Cookies.set('selectedModel', newModel, { expires: 30 });
    };

    const handleProviderChange = (newProvider: ProviderInfo) => {
      setProvider(newProvider);
      Cookies.set('selectedProvider', newProvider.name, { expires: 30 });
    };

    const handleWebSearchResult = useCallback(
      (result: string) => {
        const currentInput = input || '';
        const newInput = currentInput.length > 0 ? `${result}\n\n${currentInput}` : result;

        // Update the input via the same mechanism as handleInputChange
        const syntheticEvent = {
          target: { value: newInput },
        } as React.ChangeEvent<HTMLTextAreaElement>;
        handleInputChange(syntheticEvent);
      },
      [input, handleInputChange],
    );

    return (
      <BaseChat
        ref={animationScope}
        textareaRef={textareaRef}
        input={input}
        showChat={showChat}
        chatStarted={chatStarted}
        isStreaming={isLoading || fakeLoading}
        onStreamingChange={(streaming) => {
          streamingState.set(streaming);
        }}
        enhancingPrompt={enhancingPrompt}
        promptEnhanced={promptEnhanced}
        sendMessage={sendMessage}
        model={model}
        setModel={handleModelChange}
        provider={provider}
        setProvider={handleProviderChange}
        providerList={activeProviders}
        handleInputChange={(e) => {
          onTextareaChange(e);
          debouncedCachePrompt(e);
        }}
        handleStop={abort}
        description={description}
        importChat={importChat}
        exportChat={exportChat}
        messages={messages.map((message) => {
          if (message.role === 'user') {
            return message;
          }

          const parsedContent = parsedMessages[message.id];
          const fallbackContent = getTextMessageContent(message);
          const hasRenderableParsedContent = typeof parsedContent === 'string' && parsedContent.trim().length > 0;

          return {
            ...message,
            content: hasRenderableParsedContent ? parsedContent : fallbackContent,
          };
        })}
        enhancePrompt={() => {
          enhancePrompt(
            input,
            (input) => {
              setInput(input);
              scrollTextArea();
            },
            model,
            provider,
            apiKeys,
          );
        }}
        uploadedFiles={uploadedFiles}
        setUploadedFiles={setUploadedFiles}
        imageDataList={imageDataList}
        setImageDataList={setImageDataList}
        actionAlert={actionAlert}
        clearAlert={() => workbenchStore.clearAlert()}
        supabaseAlert={supabaseAlert}
        clearSupabaseAlert={() => workbenchStore.clearSupabaseAlert()}
        deployAlert={deployAlert}
        clearDeployAlert={() => workbenchStore.clearDeployAlert()}
        llmErrorAlert={llmErrorAlert}
        clearLlmErrorAlert={clearApiErrorAlert}
        data={chatData}
        chatMode={chatMode}
        setChatMode={setChatMode}
        append={append}
        designScheme={designScheme}
        setDesignScheme={setDesignScheme}
        selectedElement={selectedElement}
        setSelectedElement={setSelectedElement}
        addToolResult={addToolResult}
        onWebSearchResult={handleWebSearchResult}
        agentQueue={agentQueue}
        activeAgentQueueItem={activeAgentQueueItem}
        isAgentQueuePaused={isAgentQueuePaused}
        onToggleAgentQueuePause={toggleAgentQueuePause}
        onClearAgentQueue={clearAgentQueue}
        onMoveAgentQueueItem={moveAgentQueueItem}
        onEditAgentQueueItem={editAgentQueueItem}
        onCopyAgentQueueItem={copyAgentQueueItem}
        onRemoveAgentQueueItem={removeAgentQueueItem}
        onRepeatAgentQueueItem={repeatAgentQueueItem}
      />
    );
  },
);
