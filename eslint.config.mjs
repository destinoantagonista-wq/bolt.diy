import blitzPlugin from '@blitz/eslint-plugin';
import { jsFileExtensions } from '@blitz/eslint-plugin/dist/configs/javascript.js';
import { getNamingConventionRule, tsFileExtensions } from '@blitz/eslint-plugin/dist/configs/typescript.js';

export default [
  {
    ignores: ['**/dist', '**/node_modules', '**/.wrangler', '**/bolt/build', '**/.history'],
  },
  ...blitzPlugin.configs.recommended(),
  {
    rules: {
      '@blitz/catch-error-name': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@blitz/comment-syntax': 'off',
      '@blitz/block-scope-case': 'off',
      'array-bracket-spacing': ['error', 'never'],
      'object-curly-newline': ['error', { consistent: true }],
      'keyword-spacing': ['error', { before: true, after: true }],
      'consistent-return': 'error',
      semi: ['error', 'always'],
      curly: ['error'],
      'no-eval': ['error'],
      'linebreak-style': ['error', 'unix'],
      'arrow-spacing': ['error', { before: true, after: true }],
    },
  },
  {
    files: ['**/*.tsx'],
    rules: {
      ...getNamingConventionRule({}, true),
    },
  },
  {
    files: ['**/*.d.ts'],
    rules: {
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  {
    files: [...tsFileExtensions, ...jsFileExtensions, '**/*.tsx'],
    ignores: ['functions/*', 'electron/**/*'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../'],
              message: "Relative imports are not allowed. Please use '~/' instead.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [...tsFileExtensions, ...jsFileExtensions, '**/*.tsx'],
    ignores: [
      'functions/*',
      'electron/**/*',
      'app/components/**/*.webcontainer.*',
      'app/lib/hooks/useGit.webcontainer.ts',
      'app/lib/legacy/webcontainer/**',
      'app/routes/webcontainer.connect.$id.tsx',
      'app/routes/webcontainer.preview.$id.tsx',
      'app/lib/webcontainer/**',
      'app/lib/stores/workbench.ts',
      'app/lib/stores/files.ts',
      'app/lib/stores/previews.ts',
      'app/lib/stores/terminal.ts',
      'app/lib/runtime/action-runner.ts',
      'app/utils/shell.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@webcontainer/api',
              message: 'WebContainer imports are only allowed in legacy modules.',
            },
            {
              name: '~/lib/webcontainer',
              message: 'WebContainer imports are only allowed in legacy modules.',
            },
          ],
          patterns: [
            {
              group: ['../'],
              message: "Relative imports are not allowed. Please use '~/' instead.",
            },
            {
              group: ['~/lib/webcontainer/*'],
              message: 'WebContainer imports are only allowed in legacy modules.',
            },
          ],
        },
      ],
    },
  },
];
