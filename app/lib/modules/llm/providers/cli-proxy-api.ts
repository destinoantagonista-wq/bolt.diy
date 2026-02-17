import { BaseProvider, getOpenAILikeModel } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { IProviderSetting } from '~/types/model';
import type { LanguageModelV1 } from 'ai';
import { logger } from '~/utils/logger';

interface OpenAIModelEntry extends Record<string, unknown> {
  id: string;
}

interface OpenAIModelsResponse {
  data: OpenAIModelEntry[];
}

interface ModelTokenLimits {
  maxTokenAllowed: number;
  maxCompletionTokens?: number;
}

export default class CLIProxyAPIProvider extends BaseProvider {
  name = 'CLIProxyAPI';
  getApiKeyLink = undefined;
  private static readonly _defaultContextWindow = 128000;

  private static readonly _exactModelLimits: Record<string, ModelTokenLimits> = {
    // OpenAI GPT-5 family: https://platform.openai.com/docs/models
    'gpt-5': { maxTokenAllowed: 400000, maxCompletionTokens: 128000 },
    'gpt-5.1': { maxTokenAllowed: 400000, maxCompletionTokens: 128000 },
    'gpt-5.2': { maxTokenAllowed: 400000, maxCompletionTokens: 128000 },
    'gpt-5.3': { maxTokenAllowed: 400000, maxCompletionTokens: 128000 },
    'gpt-5-codex': { maxTokenAllowed: 400000, maxCompletionTokens: 128000 },
    'gpt-5-codex-mini': { maxTokenAllowed: 400000, maxCompletionTokens: 128000 },
    'gpt-5.1-codex': { maxTokenAllowed: 400000, maxCompletionTokens: 128000 },
    'gpt-5.1-codex-mini': { maxTokenAllowed: 400000, maxCompletionTokens: 128000 },
    'gpt-5.1-codex-max': { maxTokenAllowed: 400000, maxCompletionTokens: 128000 },
    'gpt-5.2-codex': { maxTokenAllowed: 400000, maxCompletionTokens: 128000 },
    'gpt-5.3-codex': { maxTokenAllowed: 400000, maxCompletionTokens: 128000 },
    'gpt-5.3-codex-spark': { maxTokenAllowed: 400000, maxCompletionTokens: 128000 },

    // OpenAI gpt-oss family: https://openai.com/index/introducing-gpt-oss/
    'gpt-oss-120b-medium': { maxTokenAllowed: 131072, maxCompletionTokens: 131072 },

    // Gemini family: https://ai.google.dev/gemini-api/docs/models
    'gemini-2.5-flash': { maxTokenAllowed: 1048576, maxCompletionTokens: 65536 },
    'gemini-2.5-flash-lite': { maxTokenAllowed: 1048576, maxCompletionTokens: 65536 },
    'gemini-3-flash': { maxTokenAllowed: 1048576, maxCompletionTokens: 65536 },

    // "gemini-3-pro-high" appears to be a proxy alias for Gemini 3 Pro models.
    'gemini-3-pro-high': { maxTokenAllowed: 1048576, maxCompletionTokens: 65536 },
    'gemini-3-pro-image': { maxTokenAllowed: 65536, maxCompletionTokens: 32768 },

    // Anthropic Claude family: https://docs.anthropic.com/en/docs/about-claude/models/all-models
    'claude-sonnet-4-5': { maxTokenAllowed: 200000, maxCompletionTokens: 64000 },
    'claude-sonnet-4-5-thinking': { maxTokenAllowed: 200000, maxCompletionTokens: 64000 },
    'claude-opus-4-5-thinking': { maxTokenAllowed: 200000, maxCompletionTokens: 64000 },

    /*
     * Opus 4.6 supports up to 1M context in beta.
     * Source: https://www.anthropic.com/news/claude-opus-4-6
     */
    'claude-opus-4-6-thinking': { maxTokenAllowed: 1000000, maxCompletionTokens: 128000 },

    // Observed local aliases from CLIProxy deployments.
    tab_flash_lite_preview: { maxTokenAllowed: 1048576, maxCompletionTokens: 65536 },
    tab_jump_flash_lite_preview: { maxTokenAllowed: 1048576, maxCompletionTokens: 65536 },
  };

  config = {
    baseUrl: 'http://127.0.0.1:8317/v1',
    baseUrlKey: 'CLI_PROXY_API_BASE_URL',
    apiTokenKey: 'CLI_PROXY_API_KEY',
    modelsKey: 'CLI_PROXY_API_MODELS',
  };

  staticModels: ModelInfo[] = [];

  async getDynamicModels(
    apiKeys?: Record<string, string>,
    settings?: IProviderSetting,
    serverEnv: Record<string, string> = {},
  ): Promise<ModelInfo[]> {
    const { baseUrl, apiKey } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings: settings,
      serverEnv,
      defaultBaseUrlKey: 'CLI_PROXY_API_BASE_URL',
      defaultApiTokenKey: 'CLI_PROXY_API_KEY',
    });

    if (!baseUrl || !apiKey) {
      return [];
    }

    const normalizedBaseUrl = this._normalizeBaseUrl(baseUrl);

    if (!normalizedBaseUrl) {
      return [];
    }

    try {
      const response = await fetch(`${normalizedBaseUrl}/models`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        signal: this.createTimeoutSignal(),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const res = (await response.json()) as OpenAIModelsResponse;

      return (res.data || []).map((model) => ({
        name: model.id,
        label: model.id,
        provider: this.name,
        ...this._resolveModelLimits(model),
      }));
    } catch (error) {
      logger.info(`${this.name}: Could not fetch /models endpoint, checking fallback env`, error);

      // eslint-disable-next-line dot-notation
      const modelsEnv = serverEnv['CLI_PROXY_API_MODELS'] || settings?.CLI_PROXY_API_MODELS;

      if (modelsEnv) {
        logger.info(`${this.name}: Using CLI_PROXY_API_MODELS fallback`);

        return this._parseModelsFromEnv(modelsEnv);
      }

      return [];
    }
  }

  private _normalizeBaseUrl(baseUrl: string): string {
    let normalized = String(baseUrl || '').trim();

    if (!normalized) {
      return '';
    }

    if (!/^https?:\/\//i.test(normalized)) {
      normalized = `http://${normalized}`;
    }

    normalized = normalized
      .replace(/\/+$/g, '')
      .replace(/\/v0\/management\/?$/i, '')
      .replace(/\/v1\/models\/?$/i, '')
      .replace(/\/v1\/chat\/completions\/?$/i, '')
      .replace(/\/chat\/completions\/?$/i, '')
      .replace(/\/models\/?$/i, '')
      .replace(/\/+$/g, '');

    if (normalized.endsWith('/v1')) {
      return normalized;
    }

    return `${normalized}/v1`;
  }

  private _parseModelsFromEnv(modelsEnv: string): ModelInfo[] {
    if (!modelsEnv) {
      return [];
    }

    try {
      const models: ModelInfo[] = [];
      const modelEntries = modelsEnv.split(';');

      for (const entry of modelEntries) {
        const trimmedEntry = entry.trim();

        if (!trimmedEntry) {
          continue;
        }

        const [modelPath, limitStr] = trimmedEntry.split(':');

        if (!modelPath) {
          continue;
        }

        const limit = limitStr ? parseInt(limitStr.trim(), 10) : CLIProxyAPIProvider._defaultContextWindow;
        const modelName = modelPath.trim();
        const inferredLimits = this._inferModelLimitsFromId(modelName);

        models.push({
          name: modelName,
          label: modelName,
          provider: this.name,
          maxTokenAllowed: Number.isNaN(limit) ? inferredLimits.maxTokenAllowed : limit,
          maxCompletionTokens: inferredLimits.maxCompletionTokens,
        });
      }

      logger.info(`${this.name}: Parsed ${models.length} models from env`);

      return models;
    } catch (error) {
      logger.error(`${this.name}: Error parsing CLI_PROXY_API_MODELS:`, error);
      return [];
    }
  }

  private _resolveModelLimits(model: OpenAIModelEntry): ModelTokenLimits {
    const metadataLimits = this._extractLimitsFromMetadata(model);
    const inferredLimits = this._inferModelLimitsFromId(model.id);

    return {
      maxTokenAllowed:
        metadataLimits.maxTokenAllowed || inferredLimits.maxTokenAllowed || CLIProxyAPIProvider._defaultContextWindow,
      maxCompletionTokens: metadataLimits.maxCompletionTokens || inferredLimits.maxCompletionTokens,
    };
  }

  private _extractLimitsFromMetadata(model: OpenAIModelEntry): Partial<ModelTokenLimits> {
    const directContextLimit = this._extractNumericValue(model, [
      'context_window',
      'context_length',
      'max_input_tokens',
      'input_token_limit',
      'max_context_tokens',
      'context_tokens',
      'max_prompt_tokens',
    ]);
    const directCompletionLimit = this._extractNumericValue(model, [
      'max_output_tokens',
      'max_completion_tokens',
      'completion_token_limit',
      'output_token_limit',
      'max_generated_tokens',
      'max_tokens',
    ]);

    const limits = model.limits;

    if (!limits || typeof limits !== 'object') {
      return {
        maxTokenAllowed: directContextLimit,
        maxCompletionTokens: directCompletionLimit,
      };
    }

    const nestedContextLimit = this._extractNumericValue(limits as Record<string, unknown>, [
      'context_window',
      'context_length',
      'max_input_tokens',
      'input_token_limit',
      'max_context_tokens',
      'context_tokens',
      'max_prompt_tokens',
    ]);
    const nestedCompletionLimit = this._extractNumericValue(limits as Record<string, unknown>, [
      'max_output_tokens',
      'max_completion_tokens',
      'completion_token_limit',
      'output_token_limit',
      'max_generated_tokens',
      'max_tokens',
    ]);

    return {
      maxTokenAllowed: directContextLimit || nestedContextLimit,
      maxCompletionTokens: directCompletionLimit || nestedCompletionLimit,
    };
  }

  private _extractNumericValue(record: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
      const value = record[key];
      const parsed = this._toPositiveInt(value);

      if (parsed) {
        return parsed;
      }
    }

    return undefined;
  }

  private _toPositiveInt(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }

    if (typeof value === 'string') {
      const parsed = Number.parseInt(value.trim(), 10);

      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }

    return undefined;
  }

  private _inferModelLimitsFromId(modelId: string): ModelTokenLimits {
    const normalizedId = String(modelId || '')
      .trim()
      .toLowerCase();

    if (!normalizedId) {
      return { maxTokenAllowed: CLIProxyAPIProvider._defaultContextWindow };
    }

    const exactMatch = CLIProxyAPIProvider._exactModelLimits[normalizedId];

    if (exactMatch) {
      return exactMatch;
    }

    if (/^gpt-5([.-]|$)/.test(normalizedId)) {
      return { maxTokenAllowed: 400000, maxCompletionTokens: 128000 };
    }

    if (normalizedId.includes('gpt-oss-120b')) {
      return { maxTokenAllowed: 131072, maxCompletionTokens: 131072 };
    }

    if (normalizedId.includes('claude-opus-4-6')) {
      return { maxTokenAllowed: 1000000, maxCompletionTokens: 128000 };
    }

    if (normalizedId.includes('claude-sonnet-4-5') || normalizedId.includes('claude-opus-4-5')) {
      return { maxTokenAllowed: 200000, maxCompletionTokens: 64000 };
    }

    if (normalizedId.includes('gemini-3-pro-image')) {
      return { maxTokenAllowed: 65536, maxCompletionTokens: 32768 };
    }

    if (normalizedId.includes('gemini-2.5-flash') || normalizedId.includes('gemini-3-flash')) {
      return { maxTokenAllowed: 1048576, maxCompletionTokens: 65536 };
    }

    if (normalizedId.includes('gemini-3-pro')) {
      return { maxTokenAllowed: 1048576, maxCompletionTokens: 65536 };
    }

    if (normalizedId.includes('flash_lite') || normalizedId.includes('flash-lite')) {
      return { maxTokenAllowed: 1048576, maxCompletionTokens: 65536 };
    }

    return { maxTokenAllowed: CLIProxyAPIProvider._defaultContextWindow };
  }

  getModelInstance(options: {
    model: string;
    serverEnv: Env;
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, IProviderSetting>;
  }): LanguageModelV1 {
    const { model, serverEnv, apiKeys, providerSettings } = options;
    const envRecord = this.convertEnvToRecord(serverEnv);

    const { baseUrl, apiKey } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings: providerSettings?.[this.name],
      serverEnv: envRecord,
      defaultBaseUrlKey: 'CLI_PROXY_API_BASE_URL',
      defaultApiTokenKey: 'CLI_PROXY_API_KEY',
    });

    if (!baseUrl || !apiKey) {
      throw new Error(`Missing configuration for ${this.name} provider`);
    }

    const normalizedBaseUrl = this._normalizeBaseUrl(baseUrl);

    if (!normalizedBaseUrl) {
      throw new Error(`Invalid base URL for ${this.name} provider`);
    }

    return getOpenAILikeModel(normalizedBaseUrl, apiKey, model);
  }
}
