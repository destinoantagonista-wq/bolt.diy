/**
 * Cleans runtime URLs from stack traces to show compact paths.
 */
export function cleanStackTrace(stackTrace: string): string {
  const cleanUrl = (url: string): string => {
    try {
      const parsed = new URL(url);
      const normalizedPath = parsed.pathname.replace(/^\/+/, '');

      if (!normalizedPath) {
        return url;
      }

      if (normalizedPath.startsWith('home/project/')) {
        return normalizedPath.slice('home/project/'.length);
      }

      if (normalizedPath.includes('/src/')) {
        const srcIndex = normalizedPath.indexOf('src/');
        return normalizedPath.slice(srcIndex);
      }

      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return url;
    }
  };

  return stackTrace
    .split('\n')
    .map((line) => line.replace(/(https?:\/\/[^\s\)]+)/g, (match) => cleanUrl(match)))
    .join('\n');
}
