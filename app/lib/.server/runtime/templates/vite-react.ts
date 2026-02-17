export interface RuntimeTemplate {
  id: string;
  composeFile: string;
  files: Record<string, string>;
}

const composeFile = `services:
  app:
    image: node:20-alpine
    working_dir: /workspace
    command: >
      sh -lc "if [ -f package-lock.json ]; then npm ci || npm install;
      else npm install; fi &&
      npm run dev -- --host 0.0.0.0 --port 4173"
    volumes:
      - ../files:/workspace
    restart: unless-stopped
`;

export const viteReactTemplate: RuntimeTemplate = {
  id: 'vite-react',
  composeFile,
  files: {
    'package.json': JSON.stringify(
      {
        name: 'bolt-runtime-app',
        private: true,
        version: '0.0.1',
        type: 'module',
        scripts: {
          dev: 'vite',
          build: 'vite build',
          preview: 'vite preview --host 0.0.0.0 --port 4173',
        },
        dependencies: {
          react: '^18.3.1',
          'react-dom': '^18.3.1',
        },
        devDependencies: {
          vite: '^5.4.11',
          '@vitejs/plugin-react': '^4.3.4',
        },
      },
      null,
      2,
    ),
    'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Bolt Runtime</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`,
    'vite.config.js': `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});
`,
    'src/main.jsx': `import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';

function App() {
  return (
    <main className="container">
      <h1>Bolt + Dokploy Runtime</h1>
      <p>Projeto inicial provisionado remotamente.</p>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
`,
    'src/styles.css': `:root {
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
}

body {
  margin: 0;
  background: #f7fafc;
  color: #0f172a;
}

.container {
  max-width: 680px;
  margin: 96px auto;
  padding: 24px;
  border: 1px solid #e2e8f0;
  border-radius: 14px;
  background: #ffffff;
}
`,
  },
};

export const getRuntimeTemplate = (templateId?: string): RuntimeTemplate => {
  if (!templateId || templateId === viteReactTemplate.id) {
    return viteReactTemplate;
  }

  return viteReactTemplate;
};
