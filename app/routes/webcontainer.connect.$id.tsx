import type { LoaderFunctionArgs } from '@remix-run/cloudflare';
import { getRuntimeServerConfig } from '~/lib/.server/runtime/config';

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const env = (context as any)?.cloudflare?.env as Record<string, unknown> | undefined;
  const config = getRuntimeServerConfig(env);

  if (config.runtimeProvider === 'dokploy') {
    throw new Response('Not Found', { status: 404 });
  }

  const url = new URL(request.url);
  const editorOrigin = url.searchParams.get('editorOrigin') || 'https://stackblitz.com';
  console.log('editorOrigin', editorOrigin);

  const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Connect to WebContainer</title>
      </head>
      <body>
        <script type="module">
          (async () => {
            const { setupConnect } = await import('https://cdn.jsdelivr.net/npm/@webcontainer/api@latest/dist/connect.js');
            setupConnect({
              editorOrigin: '${editorOrigin}'
            });
          })();
        </script>
      </body>
    </html>
  `;

  return new Response(htmlContent, {
    headers: { 'Content-Type': 'text/html' },
  });
};
