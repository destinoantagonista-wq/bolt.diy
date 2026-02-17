import { convertToCoreMessages, streamText as _streamText, type Message } from 'ai';
import { MAX_TOKENS, PROVIDER_COMPLETION_LIMITS, isReasoningModel, type FileMap } from './constants';
import { getSystemPrompt } from '~/lib/common/prompts/prompts';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, MODIFICATIONS_TAG_NAME, PROVIDER_LIST, WORK_DIR } from '~/utils/constants';
import type { IProviderSetting } from '~/types/model';
import { PromptLibrary } from '~/lib/common/prompt-library';
import { allowedHTMLElements } from '~/utils/markdown';
import { LLMManager } from '~/lib/modules/llm/manager';
import { createScopedLogger } from '~/utils/logger';
import { createFilesContext, extractPropertiesFromMessage } from './utils';
import { discussPrompt } from '~/lib/common/prompts/discuss-prompt';
import { agentModePrompt } from '~/lib/common/prompts/agent-mode-prompt';
import type { DesignScheme } from '~/types/design-scheme';
import { getRuntimeServerConfig } from '~/lib/.server/runtime/config';

export type Messages = Message[];

export interface StreamingOptions extends Omit<Parameters<typeof _streamText>[0], 'model'> {
  supabaseConnection?: {
    isConnected: boolean;
    hasSelectedProject: boolean;
    credentials?: {
      anonKey?: string;
      supabaseUrl?: string;
    };
  };
}

const logger = createScopedLogger('stream-text');

function getCompletionTokenLimit(modelDetails: any): number {
  // 1. If model specifies completion tokens, use that
  if (modelDetails.maxCompletionTokens && modelDetails.maxCompletionTokens > 0) {
    return modelDetails.maxCompletionTokens;
  }

  // 2. Use provider-specific default
  const providerDefault = PROVIDER_COMPLETION_LIMITS[modelDetails.provider];

  if (providerDefault) {
    return providerDefault;
  }

  // 3. Final fallback to MAX_TOKENS, but cap at reasonable limit for safety
  return Math.min(MAX_TOKENS, 16384);
}

function extractTextValue(input: unknown): string {
  if (typeof input === 'string') {
    return input;
  }

  if (!Array.isArray(input)) {
    return '';
  }

  return input
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
}

function sanitizeText(text: unknown): string {
  const rawText = extractTextValue(text);
  let sanitized = rawText.replace(/<div class=\\"__boltThought__\\">.*?<\/div>/s, '');
  sanitized = sanitized.replace(/<think>.*?<\/think>/s, '');
  sanitized = sanitized.replace(/<boltAction type="file" filePath="package-lock\.json">[\s\S]*?<\/boltAction>/g, '');

  return sanitized.trim();
}

export async function streamText(props: {
  messages: Omit<Message, 'id'>[];
  env?: Env;
  options?: StreamingOptions;
  apiKeys?: Record<string, string>;
  files?: FileMap;
  providerSettings?: Record<string, IProviderSetting>;
  promptId?: string;
  contextOptimization?: boolean;
  contextFiles?: FileMap;
  summary?: string;
  messageSliceId?: number;
  chatMode?: 'discuss' | 'build' | 'agent';
  agentExecutionPlan?: string;
  designScheme?: DesignScheme;
}) {
  const {
    messages,
    env: serverEnv,
    options,
    apiKeys,
    files,
    providerSettings,
    promptId,
    contextOptimization,
    contextFiles,
    summary,
    chatMode,
    agentExecutionPlan,
    designScheme,
  } = props;
  let currentModel = DEFAULT_MODEL;
  let currentProvider = DEFAULT_PROVIDER.name;
  let processedMessages = messages.map((message) => {
    const newMessage = { ...message };

    if (message.role === 'user') {
      const { model, provider, content } = extractPropertiesFromMessage(message);
      currentModel = model;
      currentProvider = provider;
      newMessage.content = sanitizeText(content);
    } else if (message.role == 'assistant') {
      newMessage.content = sanitizeText(message.content);
    }

    // Sanitize all text parts in parts array, if present
    if (Array.isArray(message.parts)) {
      newMessage.parts = message.parts.map((part) =>
        part.type === 'text' ? { ...part, text: sanitizeText(part.text) } : part,
      );
    }

    return newMessage;
  });

  const provider = PROVIDER_LIST.find((p) => p.name === currentProvider) || DEFAULT_PROVIDER;
  const staticModels = LLMManager.getInstance().getStaticModelListFromProvider(provider);
  let modelDetails = staticModels.find((m) => m.name === currentModel);

  if (!modelDetails) {
    const modelsList = [
      ...(provider.staticModels || []),
      ...(await LLMManager.getInstance().getModelListFromProvider(provider, {
        apiKeys,
        providerSettings,
        serverEnv: serverEnv as any,
      })),
    ];

    if (!modelsList.length) {
      throw new Error(`No models found for provider ${provider.name}`);
    }

    modelDetails = modelsList.find((m) => m.name === currentModel);

    if (!modelDetails) {
      // Check if it's a Google provider and the model name looks like it might be incorrect
      if (provider.name === 'Google' && currentModel.includes('2.5')) {
        throw new Error(
          `Model "${currentModel}" not found. Gemini 2.5 Pro doesn't exist. Available Gemini models include: gemini-1.5-pro, gemini-2.0-flash, gemini-1.5-flash. Please select a valid model.`,
        );
      }

      // Fallback to first model with warning
      logger.warn(
        `MODEL [${currentModel}] not found in provider [${provider.name}]. Falling back to first model. ${modelsList[0].name}`,
      );
      modelDetails = modelsList[0];
    }
  }

  const dynamicMaxTokens = modelDetails ? getCompletionTokenLimit(modelDetails) : Math.min(MAX_TOKENS, 16384);

  // Use model-specific limits directly - no artificial cap needed
  const safeMaxTokens = dynamicMaxTokens;

  logger.info(
    `Token limits for model ${modelDetails.name}: maxTokens=${safeMaxTokens}, maxTokenAllowed=${modelDetails.maxTokenAllowed}, maxCompletionTokens=${modelDetails.maxCompletionTokens}`,
  );

  const isAgentMode = chatMode === 'agent';

  let buildSystemPrompt =
    PromptLibrary.getPropmtFromLibrary(promptId || 'default', {
      cwd: WORK_DIR,
      allowedHtmlElements: allowedHTMLElements,
      modificationTagName: MODIFICATIONS_TAG_NAME,
      designScheme,
      supabase: {
        isConnected: options?.supabaseConnection?.isConnected || false,
        hasSelectedProject: options?.supabaseConnection?.hasSelectedProject || false,
        credentials: options?.supabaseConnection?.credentials || undefined,
      },
    }) ?? getSystemPrompt();

  let discussSystemPrompt = discussPrompt();
  let agentSystemPrompt = agentModePrompt(buildSystemPrompt);
  const runtimeProvider = getRuntimeServerConfig(
    serverEnv as unknown as Record<string, unknown> | undefined,
  ).runtimeProvider;

  if (runtimeProvider === 'dokploy') {
    const dokployRuntimeInstructions = `
<dokploy_v1_runtime_constraints>
  - This workspace runs on a remote Dokploy runtime.
  - V1 supports file editing and remote preview only.
  - NEVER emit shell/start/build actions.
  - Focus on <boltAction type="file"> actions.
  - Do not ask the user to run terminal commands manually.
  - Git clone/import, external deploy providers, and Expo QR flows are unavailable in V1.
  - Search capabilities are limited to file name/path, not full-text grep.
</dokploy_v1_runtime_constraints>
`;

    buildSystemPrompt = `${buildSystemPrompt}\n${dokployRuntimeInstructions}`;
    agentSystemPrompt = `${agentSystemPrompt}\n${dokployRuntimeInstructions}`;
    discussSystemPrompt = `${discussSystemPrompt}\n\nFor this project runtime, assume Dokploy V1 constraints: no shell actions, file edits + preview only.`;
  }

  const shouldInjectContext = !!contextFiles && !!contextOptimization && (chatMode === 'build' || isAgentMode);

  if (shouldInjectContext) {
    const codeContext = createFilesContext(contextFiles as FileMap, true);

    const contextIntro =
      chatMode === 'agent'
        ? 'Below is the artifact containing source context for execution. Use it to implement the request end-to-end and verify outcomes.'
        : 'Below is the artifact containing the context loaded into context buffer for you to have knowledge of and might need changes to fullfill current user request.';

    const contextBlock = `
    ${contextIntro}
    CONTEXT BUFFER:
    ---
    ${codeContext}
    ---
    `;

    if (chatMode === 'build') {
      buildSystemPrompt = `${buildSystemPrompt}${contextBlock}`;
    } else if (isAgentMode) {
      agentSystemPrompt = `${agentSystemPrompt}${contextBlock}`;
    } else {
      discussSystemPrompt = `${discussSystemPrompt}${contextBlock}`;
    }

    if (summary) {
      const summaryBlock = `
      below is the chat history till now
      CHAT SUMMARY:
      ---
      ${props.summary}
      ---
      `;

      if (chatMode === 'build') {
        buildSystemPrompt = `${buildSystemPrompt}${summaryBlock}`;
      } else if (isAgentMode) {
        agentSystemPrompt = `${agentSystemPrompt}${summaryBlock}`;
      } else {
        discussSystemPrompt = `${discussSystemPrompt}${summaryBlock}`;
      }

      if (props.messageSliceId) {
        processedMessages = processedMessages.slice(props.messageSliceId);
      } else {
        const lastMessage = processedMessages.pop();

        if (lastMessage) {
          processedMessages = [lastMessage];
        }
      }
    }
  }

  const effectiveLockedFilePaths = new Set<string>();

  if (files) {
    for (const [filePath, fileDetails] of Object.entries(files)) {
      if (fileDetails?.isLocked) {
        effectiveLockedFilePaths.add(filePath);
      }
    }
  }

  if (effectiveLockedFilePaths.size > 0) {
    const lockedFilesListString = Array.from(effectiveLockedFilePaths)
      .map((filePath) => `- ${filePath}`)
      .join('\n');
    const lockedFilesPrompt = `

    IMPORTANT: The following files are locked and MUST NOT be modified in any way. Do not suggest or make any changes to these files. You can proceed with the request but DO NOT make any changes to these files specifically:
    ${lockedFilesListString}
    ---
    `;

    if (chatMode === 'build') {
      buildSystemPrompt = `${buildSystemPrompt}${lockedFilesPrompt}`;
    } else if (isAgentMode) {
      agentSystemPrompt = `${agentSystemPrompt}${lockedFilesPrompt}`;
    }
  } else {
    console.log('No locked files found from any source for prompt.');
  }

  if (isAgentMode && agentExecutionPlan) {
    agentSystemPrompt = `${agentSystemPrompt}

    AGENT EXECUTION BRIEF:
    ---
    ${agentExecutionPlan}
    ---
    `;
  }

  logger.info(`Sending llm call to ${provider.name} with model ${modelDetails.name}`);

  // Log reasoning model detection and token parameters
  const isReasoning = isReasoningModel(modelDetails.name);
  logger.info(
    `Model "${modelDetails.name}" is reasoning model: ${isReasoning}, using ${isReasoning ? 'maxCompletionTokens' : 'maxTokens'}: ${safeMaxTokens}`,
  );

  // Validate token limits before API call
  if (safeMaxTokens > (modelDetails.maxTokenAllowed || 128000)) {
    logger.warn(
      `Token limit warning: requesting ${safeMaxTokens} tokens but model supports max ${modelDetails.maxTokenAllowed || 128000}`,
    );
  }

  // Use maxCompletionTokens for reasoning models (o1, GPT-5), maxTokens for traditional models
  const tokenParams = isReasoning ? { maxCompletionTokens: safeMaxTokens } : { maxTokens: safeMaxTokens };

  // Filter out unsupported parameters for reasoning models
  const filteredOptions =
    isReasoning && options
      ? Object.fromEntries(
          Object.entries(options).filter(
            ([key]) =>
              ![
                'temperature',
                'topP',
                'presencePenalty',
                'frequencyPenalty',
                'logprobs',
                'topLogprobs',
                'logitBias',
              ].includes(key),
          ),
        )
      : options || {};

  // DEBUG: Log filtered options
  logger.info(
    `DEBUG STREAM: Options filtering for model "${modelDetails.name}":`,
    JSON.stringify(
      {
        isReasoning,
        originalOptions: options || {},
        filteredOptions,
        originalOptionsKeys: options ? Object.keys(options) : [],
        filteredOptionsKeys: Object.keys(filteredOptions),
        removedParams: options ? Object.keys(options).filter((key) => !(key in filteredOptions)) : [],
      },
      null,
      2,
    ),
  );

  const selectedSystemPrompt =
    chatMode === 'discuss' ? discussSystemPrompt : chatMode === 'agent' ? agentSystemPrompt : buildSystemPrompt;

  const streamParams = {
    model: provider.getModelInstance({
      model: modelDetails.name,
      serverEnv,
      apiKeys,
      providerSettings,
    }),
    system: selectedSystemPrompt,
    ...tokenParams,
    messages: convertToCoreMessages(processedMessages as any),
    ...filteredOptions,

    // Set temperature to 1 for reasoning models (required by OpenAI API)
    ...(isReasoning ? { temperature: 1 } : {}),
  };

  // DEBUG: Log final streaming parameters
  logger.info(
    `DEBUG STREAM: Final streaming params for model "${modelDetails.name}":`,
    JSON.stringify(
      {
        hasTemperature: 'temperature' in streamParams,
        hasMaxTokens: 'maxTokens' in streamParams,
        hasMaxCompletionTokens: 'maxCompletionTokens' in streamParams,
        paramKeys: Object.keys(streamParams).filter((key) => !['model', 'messages', 'system'].includes(key)),
        streamParams: Object.fromEntries(
          Object.entries(streamParams).filter(([key]) => !['model', 'messages', 'system'].includes(key)),
        ),
      },
      null,
      2,
    ),
  );

  return await _streamText(streamParams);
}
