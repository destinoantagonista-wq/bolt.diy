import { type ActionFunctionArgs } from '@remix-run/cloudflare';
import { createDataStream, generateId } from 'ai';
import { MAX_RESPONSE_SEGMENTS, MAX_TOKENS, type FileMap } from '~/lib/.server/llm/constants';
import { CONTINUE_PROMPT } from '~/lib/common/prompts/prompts';
import { streamText, type Messages, type StreamingOptions } from '~/lib/.server/llm/stream-text';
import SwitchableStream from '~/lib/.server/llm/switchable-stream';
import type { IProviderSetting } from '~/types/model';
import { createScopedLogger } from '~/utils/logger';
import { getFilePaths, selectContext } from '~/lib/.server/llm/select-context';
import type { AgentEventAnnotation, ContextAnnotation, ProgressAnnotation } from '~/types/context';
import { WORK_DIR } from '~/utils/constants';
import { createSummary } from '~/lib/.server/llm/create-summary';
import { createAgentExecutionPlan } from '~/lib/.server/llm/create-agent-plan';
import { extractPropertiesFromMessage } from '~/lib/.server/llm/utils';
import type { DesignScheme } from '~/types/design-scheme';
import { MCPService } from '~/lib/services/mcpService';
import { StreamRecoveryManager } from '~/lib/.server/llm/stream-recovery';

export async function action(args: ActionFunctionArgs) {
  return chatAction(args);
}

const logger = createScopedLogger('api.chat');

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};

  const items = cookieHeader.split(';').map((cookie) => cookie.trim());

  items.forEach((item) => {
    const [name, ...rest] = item.split('=');

    if (name && rest) {
      const decodedName = decodeURIComponent(name.trim());
      const decodedValue = decodeURIComponent(rest.join('=').trim());
      cookies[decodedName] = decodedValue;
    }
  });

  return cookies;
}

async function chatAction({ context, request }: ActionFunctionArgs) {
  const { messages, files, promptId, contextOptimization, supabase, chatMode, designScheme, maxLLMSteps } =
    await request.json<{
      messages: Messages;
      files: any;
      promptId?: string;
      contextOptimization: boolean;
      chatMode: 'discuss' | 'build' | 'agent';
      designScheme?: DesignScheme;
      supabase?: {
        isConnected: boolean;
        hasSelectedProject: boolean;
        credentials?: {
          anonKey?: string;
          supabaseUrl?: string;
        };
      };
      maxLLMSteps: number;
    }>();

  const cookieHeader = request.headers.get('Cookie');
  const apiKeys = JSON.parse(parseCookies(cookieHeader || '').apiKeys || '{}');
  const providerSettings: Record<string, IProviderSetting> = JSON.parse(
    parseCookies(cookieHeader || '').providers || '{}',
  );

  const stream = new SwitchableStream();

  const cumulativeUsage = {
    completionTokens: 0,
    promptTokens: 0,
    totalTokens: 0,
  };
  const encoder: TextEncoder = new TextEncoder();
  let progressCounter: number = 1;
  let agentEventCounter: number = 1;

  try {
    const mcpService = MCPService.getInstance();
    const totalMessageContent = messages.reduce((acc, message) => acc + message.content, '');
    logger.debug(`Total message length: ${totalMessageContent.split(' ').length}, words`);

    let isInsideThoughtBlock = false;
    const streamTextDecoder = new TextDecoder();

    const dataStream = createDataStream({
      async execute(dataStream) {
        const llmAbortController = new AbortController();

        const onClientAbort = () => {
          if (!llmAbortController.signal.aborted) {
            logger.warn('Client disconnected, aborting active LLM stream');
            llmAbortController.abort('client disconnected');
          }
        };

        request.signal.addEventListener('abort', onClientAbort, { once: true });

        // eslint-disable-next-line prefer-const
        let streamRecovery!: StreamRecoveryManager;

        const writeProgress = (annotation: Omit<ProgressAnnotation, 'type' | 'order'>) => {
          dataStream.writeData({
            type: 'progress',
            ...annotation,
            order: progressCounter++,
          } satisfies ProgressAnnotation);

          streamRecovery?.updateActivity();
        };

        const writeAgentEvent = (event: Omit<AgentEventAnnotation, 'type' | 'id' | 'order' | 'timestamp'>) => {
          dataStream.writeData({
            type: 'agent-event',
            id: `agent-event-${Date.now()}-${agentEventCounter}`,
            order: agentEventCounter++,
            timestamp: Date.now(),
            ...event,
          } satisfies AgentEventAnnotation);

          streamRecovery?.updateActivity();
        };

        streamRecovery = new StreamRecoveryManager({
          timeout: chatMode === 'agent' ? 150000 : 60000,
          maxRetries: chatMode === 'agent' ? 3 : 2,
          onRetry: (attempt, maxRetries) => {
            logger.warn(`Stream timeout - attempting recovery (${attempt}/${maxRetries})`);

            writeProgress({
              label: 'stream-recovery',
              status: 'in-progress',
              message: `Recovering stalled stream (${attempt}/${maxRetries})`,
            });

            if (chatMode === 'agent') {
              writeAgentEvent({
                level: 'warning',
                stage: 'recovery',
                message: `No stream activity detected. Retrying (${attempt}/${maxRetries}).`,
              });
            }
          },
          onExhausted: () => {
            logger.error('Stream recovery exhausted, aborting request');

            writeProgress({
              label: 'stream-recovery',
              status: 'error',
              message: 'Stream recovery failed. Request aborted.',
            });

            if (chatMode === 'agent') {
              writeAgentEvent({
                level: 'error',
                stage: 'recovery',
                message: 'Stream stalled for too long and was aborted.',
              });
            }

            if (!llmAbortController.signal.aborted) {
              llmAbortController.abort('stream recovery exhausted');
            }
          },
        });

        streamRecovery.startMonitoring();

        if (chatMode === 'agent') {
          writeAgentEvent({
            level: 'info',
            stage: 'init',
            message: 'Agent mode enabled. Preparing execution context.',
          });
        }

        try {
          const filePaths = getFilePaths(files || {});
          let filteredFiles: FileMap | undefined = undefined;
          let summary: string | undefined = undefined;
          let agentExecutionPlan: string | undefined = undefined;
          let messageSliceId = 0;

          const processedMessages = await mcpService.processToolInvocations(messages, dataStream);
          streamRecovery.updateActivity();

          if (processedMessages.length > 3) {
            messageSliceId = processedMessages.length - 3;
          }

          if (filePaths.length > 0 && contextOptimization) {
            logger.debug('Generating Chat Summary');
            writeProgress({
              label: 'summary',
              status: 'in-progress',
              message: 'Analysing request',
            });

            if (chatMode === 'agent') {
              writeAgentEvent({
                level: 'info',
                stage: 'summary',
                message: 'Summarizing recent conversation context.',
              });
            }

            summary = await createSummary({
              messages: [...processedMessages],
              env: context.cloudflare?.env,
              apiKeys,
              providerSettings,
              promptId,
              contextOptimization,
              onFinish(resp) {
                if (resp.usage) {
                  logger.debug('createSummary token usage', JSON.stringify(resp.usage));
                  cumulativeUsage.completionTokens += resp.usage.completionTokens || 0;
                  cumulativeUsage.promptTokens += resp.usage.promptTokens || 0;
                  cumulativeUsage.totalTokens += resp.usage.totalTokens || 0;
                }
              },
            });

            streamRecovery.updateActivity();

            writeProgress({
              label: 'summary',
              status: 'complete',
              message: 'Analysis complete',
            });

            dataStream.writeMessageAnnotation({
              type: 'chatSummary',
              summary,
              chatId: processedMessages.slice(-1)?.[0]?.id,
            } as ContextAnnotation);

            logger.debug('Updating Context Buffer');
            writeProgress({
              label: 'context',
              status: 'in-progress',
              message: 'Determining files to read',
            });

            if (chatMode === 'agent') {
              writeAgentEvent({
                level: 'info',
                stage: 'context',
                message: 'Selecting relevant files for execution.',
              });
            }

            filteredFiles = await selectContext({
              messages: [...processedMessages],
              env: context.cloudflare?.env,
              apiKeys,
              files,
              providerSettings,
              promptId,
              contextOptimization,
              summary,
              onFinish(resp) {
                if (resp.usage) {
                  logger.debug('selectContext token usage', JSON.stringify(resp.usage));
                  cumulativeUsage.completionTokens += resp.usage.completionTokens || 0;
                  cumulativeUsage.promptTokens += resp.usage.promptTokens || 0;
                  cumulativeUsage.totalTokens += resp.usage.totalTokens || 0;
                }
              },
            });

            streamRecovery.updateActivity();

            if (filteredFiles) {
              logger.debug(`files in context : ${JSON.stringify(Object.keys(filteredFiles))}`);
            }

            dataStream.writeMessageAnnotation({
              type: 'codeContext',
              files: Object.keys(filteredFiles || {}).map((key) => {
                let path = key;

                if (path.startsWith(WORK_DIR)) {
                  path = path.replace(WORK_DIR, '');
                }

                return path;
              }),
            } as ContextAnnotation);

            writeProgress({
              label: 'context',
              status: 'complete',
              message: 'Code files selected',
            });
          }

          if (chatMode === 'agent') {
            writeProgress({
              label: 'agent-plan',
              status: 'in-progress',
              message: 'Planning execution strategy',
            });

            writeAgentEvent({
              level: 'info',
              stage: 'plan',
              message: 'Building execution plan before implementation.',
            });

            try {
              agentExecutionPlan = await createAgentExecutionPlan({
                messages: [...processedMessages],
                env: context.cloudflare?.env,
                apiKeys,
                providerSettings,
                contextFiles: filteredFiles,
                summary,
                onFinish(resp) {
                  if (resp.usage) {
                    logger.debug('createAgentExecutionPlan token usage', JSON.stringify(resp.usage));
                    cumulativeUsage.completionTokens += resp.usage.completionTokens || 0;
                    cumulativeUsage.promptTokens += resp.usage.promptTokens || 0;
                    cumulativeUsage.totalTokens += resp.usage.totalTokens || 0;
                  }
                },
              });
            } catch (error) {
              logger.warn('Failed to create agent execution plan, continuing without pre-plan', error);

              writeAgentEvent({
                level: 'warning',
                stage: 'plan',
                message: 'Plan generation failed, continuing with adaptive execution.',
              });
            }

            streamRecovery.updateActivity();

            writeProgress({
              label: 'agent-plan',
              status: 'complete',
              message: 'Execution strategy ready',
            });
          }

          const effectiveMaxLLMSteps =
            chatMode === 'agent' ? Math.max(8, Number(maxLLMSteps) || 1) : Number(maxLLMSteps) || 1;

          const options: StreamingOptions = {
            supabaseConnection: supabase,
            toolChoice: 'auto',
            tools: mcpService.toolsWithoutExecute,
            maxSteps: effectiveMaxLLMSteps,
            abortSignal: llmAbortController.signal,
            onStepFinish: ({ toolCalls }) => {
              streamRecovery.updateActivity();

              if (chatMode === 'agent' && toolCalls.length === 0) {
                writeAgentEvent({
                  level: 'info',
                  stage: 'step',
                  message: 'Completed an execution step.',
                });
              }

              toolCalls.forEach((toolCall) => {
                mcpService.processToolCall(toolCall, dataStream);

                if (chatMode === 'agent') {
                  writeAgentEvent({
                    level: 'info',
                    stage: 'tool',
                    message: `Tool requested: ${toolCall.toolName}`,
                  });
                }
              });
            },
            onFinish: async ({ text: content, finishReason, usage }) => {
              streamRecovery.updateActivity();
              logger.debug('usage', JSON.stringify(usage));

              if (usage) {
                cumulativeUsage.completionTokens += usage.completionTokens || 0;
                cumulativeUsage.promptTokens += usage.promptTokens || 0;
                cumulativeUsage.totalTokens += usage.totalTokens || 0;
              }

              if (finishReason !== 'length') {
                dataStream.writeMessageAnnotation({
                  type: 'usage',
                  value: {
                    completionTokens: cumulativeUsage.completionTokens,
                    promptTokens: cumulativeUsage.promptTokens,
                    totalTokens: cumulativeUsage.totalTokens,
                  },
                });

                writeProgress({
                  label: 'response',
                  status: 'complete',
                  message: 'Response generated',
                });

                if (chatMode === 'agent') {
                  writeAgentEvent({
                    level: 'info',
                    stage: 'complete',
                    message: 'Agent execution finished successfully.',
                  });
                }

                await new Promise((resolve) => setTimeout(resolve, 0));

                return;
              }

              if (stream.switches >= MAX_RESPONSE_SEGMENTS) {
                throw Error('Cannot continue message: Maximum segments reached');
              }

              const switchesLeft = MAX_RESPONSE_SEGMENTS - stream.switches;
              logger.info(
                `Reached max token limit (${MAX_TOKENS}): Continuing message (${switchesLeft} switches left)`,
              );

              if (chatMode === 'agent') {
                writeAgentEvent({
                  level: 'warning',
                  stage: 'continuation',
                  message: `Token limit reached. Continuing response (${switchesLeft} segments left).`,
                });
              }

              const lastUserMessage = processedMessages.filter((x) => x.role == 'user').slice(-1)[0];
              const { model, provider } = extractPropertiesFromMessage(lastUserMessage);
              processedMessages.push({ id: generateId(), role: 'assistant', content });
              processedMessages.push({
                id: generateId(),
                role: 'user',
                content: `[Model: ${model}]\n\n[Provider: ${provider}]\n\n${CONTINUE_PROMPT}`,
              });

              const result = await streamText({
                messages: [...processedMessages],
                env: context.cloudflare?.env,
                options,
                apiKeys,
                files,
                providerSettings,
                promptId,
                contextOptimization,
                contextFiles: filteredFiles,
                chatMode,
                agentExecutionPlan,
                designScheme,
                summary,
                messageSliceId,
              });

              result.mergeIntoDataStream(dataStream);

              (async () => {
                for await (const part of result.fullStream) {
                  streamRecovery.updateActivity();

                  if (part.type === 'error') {
                    const error: any = part.error;
                    logger.error(`${error}`);

                    writeProgress({
                      label: 'response',
                      status: 'error',
                      message: 'Error while continuing long response',
                    });

                    if (chatMode === 'agent') {
                      writeAgentEvent({
                        level: 'error',
                        stage: 'continuation',
                        message: 'Continuation stream failed.',
                      });
                    }

                    return;
                  }
                }
              })();
            },
          };

          writeProgress({
            label: 'response',
            status: 'in-progress',
            message: 'Generating response',
          });

          if (chatMode === 'agent') {
            writeAgentEvent({
              level: 'info',
              stage: 'execution',
              message: 'Executing implementation steps.',
            });
          }

          const result = await streamText({
            messages: [...processedMessages],
            env: context.cloudflare?.env,
            options,
            apiKeys,
            files,
            providerSettings,
            promptId,
            contextOptimization,
            contextFiles: filteredFiles,
            chatMode,
            agentExecutionPlan,
            designScheme,
            summary,
            messageSliceId,
          });

          result.mergeIntoDataStream(dataStream);

          let lastAgentPulse = Date.now();

          for await (const part of result.fullStream) {
            streamRecovery.updateActivity();

            if (chatMode === 'agent' && Date.now() - lastAgentPulse > 7000) {
              writeAgentEvent({
                level: 'info',
                stage: 'execution',
                message: 'Agent is still working...',
              });
              lastAgentPulse = Date.now();
            }

            if (part.type === 'error') {
              const error: any = part.error;
              logger.error('Streaming error:', error);
              streamRecovery.stop();

              writeProgress({
                label: 'response',
                status: 'error',
                message: 'Streaming failed',
              });

              if (chatMode === 'agent') {
                writeAgentEvent({
                  level: 'error',
                  stage: 'execution',
                  message: 'Streaming failed while executing agent task.',
                });
              }

              if (error.message?.includes('Invalid JSON response')) {
                logger.error('Invalid JSON response detected - likely malformed API response');
              } else if (error.message?.includes('token')) {
                logger.error('Token-related error detected - possible token limit exceeded');
              }

              return;
            }
          }

          streamRecovery.stop();
        } finally {
          streamRecovery.stop();
          request.signal.removeEventListener('abort', onClientAbort);
        }
      },
      onError: (error: any) => {
        // Provide more specific error messages for common issues
        const errorMessage = error.message || 'Unknown error';

        if (errorMessage.includes('model') && errorMessage.includes('not found')) {
          return 'Custom error: Invalid model selected. Please check that the model name is correct and available.';
        }

        if (errorMessage.includes('Invalid JSON response')) {
          return 'Custom error: The AI service returned an invalid response. This may be due to an invalid model name, API rate limiting, or server issues. Try selecting a different model or check your API key.';
        }

        if (
          errorMessage.includes('API key') ||
          errorMessage.includes('unauthorized') ||
          errorMessage.includes('authentication')
        ) {
          return 'Custom error: Invalid or missing API key. Please check your API key configuration.';
        }

        if (errorMessage.includes('token') && errorMessage.includes('limit')) {
          return 'Custom error: Token limit exceeded. The conversation is too long for the selected model. Try using a model with larger context window or start a new conversation.';
        }

        if (errorMessage.includes('rate limit') || errorMessage.includes('429')) {
          return 'Custom error: API rate limit exceeded. Please wait a moment before trying again.';
        }

        if (errorMessage.includes('network') || errorMessage.includes('timeout')) {
          return 'Custom error: Network error. Please check your internet connection and try again.';
        }

        if (errorMessage.includes('aborted') || errorMessage.includes('AbortError')) {
          return 'Custom error: Streaming request was aborted due to timeout or disconnect.';
        }

        return `Custom error: ${errorMessage}`;
      },
    }).pipeThrough(
      new TransformStream({
        transform: (chunk, controller) => {
          const rawChunk = chunk as unknown;
          const chunkText =
            typeof rawChunk === 'string'
              ? rawChunk
              : rawChunk instanceof Uint8Array
                ? streamTextDecoder.decode(rawChunk)
                : null;

          if (chunkText === null) {
            controller.enqueue(rawChunk as any);
            return;
          }

          const isThoughtChunk = chunkText.startsWith('g');

          if (isThoughtChunk && !isInsideThoughtBlock) {
            controller.enqueue(encoder.encode(`0: "<div class=\\"__boltThought__\\">"\n`));
          }

          if (!isThoughtChunk && isInsideThoughtBlock) {
            controller.enqueue(encoder.encode(`0: "</div>\\n"\n`));
          }

          isInsideThoughtBlock = isThoughtChunk;

          let transformedChunk = chunkText;

          if (isThoughtChunk) {
            let content = chunkText.split(':').slice(1).join(':');

            if (content.endsWith('\n')) {
              content = content.slice(0, content.length - 1);
            }

            transformedChunk = `0:${content}\n`;
          }

          controller.enqueue(encoder.encode(transformedChunk));
        },
        flush: (controller) => {
          if (isInsideThoughtBlock) {
            controller.enqueue(encoder.encode(`0: "</div>\\n"\n`));
            isInsideThoughtBlock = false;
          }
        },
      }),
    );

    return new Response(dataStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        Connection: 'keep-alive',
        'Cache-Control': 'no-cache',
        'Text-Encoding': 'chunked',
      },
    });
  } catch (error: any) {
    logger.error(error);

    const errorResponse = {
      error: true,
      message: error.message || 'An unexpected error occurred',
      statusCode: error.statusCode || 500,
      isRetryable: error.isRetryable !== false, // Default to retryable unless explicitly false
      provider: error.provider || 'unknown',
    };

    if (error.message?.includes('API key')) {
      return new Response(
        JSON.stringify({
          ...errorResponse,
          message: 'Invalid or missing API key',
          statusCode: 401,
          isRetryable: false,
        }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
          statusText: 'Unauthorized',
        },
      );
    }

    return new Response(JSON.stringify(errorResponse), {
      status: errorResponse.statusCode,
      headers: { 'Content-Type': 'application/json' },
      statusText: 'Error',
    });
  }
}
