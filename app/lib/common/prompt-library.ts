import { getSystemPrompt } from './prompts/prompts';
import optimized from './prompts/optimized';
import { getFineTunedPrompt } from './prompts/new-prompt';
import type { DesignScheme } from '~/types/design-scheme';
import type { RuntimeProvider } from '~/lib/.server/runtime/types';
import { findForbiddenPromptTerm } from './prompts/runtime-profile';
import { getDokployFineTunedPrompt } from './prompts/new-prompt.dokploy';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('PromptLibrary');

export interface PromptOptions {
  cwd: string;
  allowedHtmlElements: string[];
  modificationTagName: string;
  runtimeProvider: RuntimeProvider;
  designScheme?: DesignScheme;
  supabase?: {
    isConnected: boolean;
    hasSelectedProject: boolean;
    credentials?: {
      anonKey?: string;
      supabaseUrl?: string;
    };
  };
}

export class PromptLibrary {
  static library: Record<
    string,
    {
      label: string;
      description: string;
      get: (options: PromptOptions) => string;
    }
  > = {
    default: {
      label: 'Default Prompt',
      description: 'An fine tuned prompt for better results and less token usage',
      get: (options) =>
        getFineTunedPrompt(options.cwd, options.supabase, options.designScheme, options.runtimeProvider),
    },
    original: {
      label: 'Old Default Prompt',
      description: 'The OG battle tested default system Prompt',
      get: (options) => getSystemPrompt(options.cwd, options.supabase, options.designScheme, options.runtimeProvider),
    },
    optimized: {
      label: 'Optimized Prompt (experimental)',
      description: 'An Experimental version of the prompt for lower token usage',
      get: (options) => optimized(options),
    },
  };
  static getList() {
    return Object.entries(this.library).map(([key, value]) => {
      const { label, description } = value;
      return {
        id: key,
        label,
        description,
      };
    });
  }
  static getPropmtFromLibrary(promptId: string, options: PromptOptions) {
    const prompt = this.library[promptId];

    if (!prompt) {
      throw new Error(`Prompt not found: ${promptId}`);
    }

    const resolvedPrompt = prompt.get(options);
    const forbiddenTerm = findForbiddenPromptTerm(options.runtimeProvider, resolvedPrompt);

    if (!forbiddenTerm) {
      return resolvedPrompt;
    }

    logger.warn('Runtime prompt safety fallback applied', {
      promptId,
      runtimeProvider: options.runtimeProvider,
      forbiddenTerm,
    });

    if (options.runtimeProvider === 'dokploy') {
      return getDokployFineTunedPrompt(options.cwd, options.supabase, options.designScheme);
    }

    return resolvedPrompt;
  }
}
