import { generateText, type CoreTool, type GenerateTextResult, type Message } from 'ai';
import type { IProviderSetting } from '~/types/model';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, PROVIDER_LIST } from '~/utils/constants';
import { createFilesContext, extractPropertiesFromMessage, simplifyBoltActions } from './utils';
import { createScopedLogger } from '~/utils/logger';
import { LLMManager } from '~/lib/modules/llm/manager';
import type { FileMap } from './constants';

const logger = createScopedLogger('create-agent-plan');

export async function createAgentExecutionPlan(props: {
  messages: Message[];
  env?: Env;
  apiKeys?: Record<string, string>;
  providerSettings?: Record<string, IProviderSetting>;
  contextFiles?: FileMap;
  summary?: string;
  onFinish?: (resp: GenerateTextResult<Record<string, CoreTool<any, any>>, never>) => void;
}) {
  const { messages, env: serverEnv, apiKeys, providerSettings, contextFiles, summary, onFinish } = props;
  let currentModel = DEFAULT_MODEL;
  let currentProvider = DEFAULT_PROVIDER.name;

  const processedMessages = messages.map((message) => {
    if (message.role === 'user') {
      const { model, provider, content } = extractPropertiesFromMessage(message);
      currentModel = model;
      currentProvider = provider;

      return { ...message, content };
    } else if (message.role === 'assistant') {
      let content = message.content;

      content = simplifyBoltActions(content);
      content = content.replace(/<div class=\\"__boltThought__\\">.*?<\/div>/s, '');
      content = content.replace(/<think>.*?<\/think>/s, '');

      return { ...message, content };
    }

    return message;
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
      logger.warn(
        `MODEL [${currentModel}] not found in provider [${provider.name}]. Falling back to first model. ${modelsList[0].name}`,
      );
      modelDetails = modelsList[0];
      currentModel = modelDetails.name;
    }
  }

  const lastUserMessage = processedMessages.filter((x) => x.role === 'user').slice(-1)[0];

  if (!lastUserMessage) {
    throw new Error('No user message found to create agent execution plan');
  }

  const extractTextContent = (message: Message) =>
    Array.isArray(message.content)
      ? (message.content.find((item) => item.type === 'text')?.text as string) || ''
      : message.content;

  const recentConversation = processedMessages
    .slice(-8)
    .map((x) => `[${x.role}] ${extractTextContent(x)}`)
    .join('\n');

  const contextBuffer =
    contextFiles && Object.keys(contextFiles).length > 0
      ? createFilesContext(contextFiles, true)
      : 'No context files selected.';

  const response = await generateText({
    system: `
You are an execution strategist for an autonomous coding agent.
Your output will be consumed by another model that performs edits.

Produce a concise, implementation-ready execution brief in markdown with this exact section structure:
## Objective
## Constraints
## File impact
## Ordered execution steps
## Validation steps
## Risks

Rules:
- Be concrete and file-aware when possible.
- Focus on execution, not high-level theory.
- Keep it concise and practical.
- Do not include code blocks.
`,
    prompt: `
User request:
---
${extractTextContent(lastUserMessage)}
---

Chat summary (if available):
---
${summary || 'No summary available.'}
---

Recent conversation:
---
${recentConversation}
---

Selected code context:
---
${contextBuffer}
---
`,
    model: provider.getModelInstance({
      model: currentModel,
      serverEnv,
      apiKeys,
      providerSettings,
    }),
  });

  if (onFinish) {
    onFinish(response);
  }

  return response.text.trim();
}
