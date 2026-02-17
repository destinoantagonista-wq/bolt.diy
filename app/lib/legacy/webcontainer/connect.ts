export const DEFAULT_WEBCONTAINER_EDITOR_ORIGIN = 'https://stackblitz.com';

export const getWebcontainerEditorOrigin = (request: Request) => {
  const url = new URL(request.url);
  return url.searchParams.get('editorOrigin') || DEFAULT_WEBCONTAINER_EDITOR_ORIGIN;
};

export const buildWebcontainerConnectHtml = (editorOrigin: string) => {
  const safeEditorOrigin = JSON.stringify(editorOrigin);

  return `<!DOCTYPE html>
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
          editorOrigin: ${safeEditorOrigin}
        });
      })();
    </script>
  </body>
</html>`;
};
