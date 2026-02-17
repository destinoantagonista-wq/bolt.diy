import { WORK_DIR } from '~/utils/constants';
import { getLegacyWebcontainer } from './runtime';

export interface LegacySearchMatch {
  path: string;
  lineNumber: number;
  previewText: string;
  matchCharStart: number;
  matchCharEnd: number;
}

interface TextSearchRange {
  startLineNumber: number;
  startColumn: number;
  endColumn: number;
}

interface TextSearchPreviewMatch {
  startLineNumber: number;
}

interface TextSearchPreview {
  text: string;
  matches: TextSearchPreviewMatch[];
}

interface TextSearchApiMatch {
  preview: TextSearchPreview;
  ranges: TextSearchRange[];
}

interface TextSearchOptions {
  homeDir: string;
  includes: string[];
  excludes: string[];
  gitignore: boolean;
  requireGit: boolean;
  globalIgnoreFiles: boolean;
  ignoreSymlinks: boolean;
  resultLimit: number;
  isRegex: boolean;
  caseSensitive: boolean;
  isWordMatch: boolean;
  folders: string[];
}

type TextSearchOnProgressCallback = (filePath: string, apiMatches: TextSearchApiMatch[]) => void;

interface LegacySearchableWebcontainer {
  internal?: {
    textSearch?: (
      query: string,
      options: TextSearchOptions,
      onProgress: TextSearchOnProgressCallback,
    ) => Promise<unknown>;
  };
}

const BASE_SEARCH_OPTIONS: Omit<TextSearchOptions, 'folders'> = {
  homeDir: WORK_DIR,
  includes: ['**/*.*'],
  excludes: ['**/node_modules/**', '**/package-lock.json', '**/.git/**', '**/dist/**', '**/*.lock'],
  gitignore: true,
  requireGit: false,
  globalIgnoreFiles: true,
  ignoreSymlinks: false,
  resultLimit: 500,
  isRegex: false,
  caseSensitive: false,
  isWordMatch: false,
};

export const searchLegacyWebcontainer = async (
  query: string,
  onProgress: (results: LegacySearchMatch[]) => void,
): Promise<void> => {
  const instance = (await getLegacyWebcontainer()) as LegacySearchableWebcontainer;

  if (!instance || typeof instance.internal?.textSearch !== 'function') {
    console.error('WebContainer instance not available or internal searchText method is missing/not a function.');
    return;
  }

  const searchOptions: TextSearchOptions = {
    ...BASE_SEARCH_OPTIONS,
    folders: [WORK_DIR],
  };

  const progressCallback: TextSearchOnProgressCallback = (filePath, apiMatches) => {
    const displayMatches: LegacySearchMatch[] = [];

    apiMatches.forEach((apiMatch) => {
      const previewLines = apiMatch.preview.text.split('\n');

      apiMatch.ranges.forEach((range) => {
        let previewLineText = '(Preview line not found)';
        let lineIndexInPreview = -1;

        if (apiMatch.preview.matches.length > 0) {
          const previewStartLine = apiMatch.preview.matches[0].startLineNumber;
          lineIndexInPreview = range.startLineNumber - previewStartLine;
        }

        if (lineIndexInPreview >= 0 && lineIndexInPreview < previewLines.length) {
          previewLineText = previewLines[lineIndexInPreview];
        } else {
          previewLineText = previewLines[0] ?? '(Preview unavailable)';
        }

        displayMatches.push({
          path: filePath,
          lineNumber: range.startLineNumber,
          previewText: previewLineText,
          matchCharStart: range.startColumn,
          matchCharEnd: range.endColumn,
        });
      });
    });

    if (displayMatches.length > 0) {
      onProgress(displayMatches);
    }
  };

  try {
    await instance.internal.textSearch(query, searchOptions, progressCallback);
  } catch (error) {
    console.error('Error during internal text search:', error);
  }
};
