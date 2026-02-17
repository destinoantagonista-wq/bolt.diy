import { spawnSync } from 'node:child_process';

const pattern = '@webcontainer/api|~/lib/webcontainer|local-credentialless.webcontainer-api.io';
const allowlist = [
  '!app/components/**/*.webcontainer.*',
  '!app/lib/hooks/useGit.webcontainer.ts',
  '!app/lib/legacy/webcontainer/**',
  '!app/routes/webcontainer.connect.$id.tsx',
  '!app/routes/webcontainer.preview.$id.tsx',
  '!app/lib/webcontainer/**',
  '!app/lib/stores/workbench.ts',
  '!app/lib/stores/files.ts',
  '!app/lib/stores/previews.ts',
  '!app/lib/stores/terminal.ts',
  '!app/lib/runtime/action-runner.ts',
  '!app/utils/shell.ts',
];

const args = ['-n', pattern, 'app'];

for (const entry of allowlist) {
  args.push('--glob', entry);
}

const result = spawnSync('rg', args, { encoding: 'utf8' });

if (result.error) {
  console.error('Failed to run rg for webcontainer cut lint.');
  console.error(result.error.message);
  process.exit(2);
}

if (result.status === 0) {
  console.error('Found WebContainer references outside the allowlist:');
  if (result.stdout) {
    console.error(result.stdout.trim());
  }
  if (result.stderr) {
    console.error(result.stderr.trim());
  }
  process.exit(1);
}

if (result.status === 1) {
  console.log('WebContainer cut lint passed.');
  process.exit(0);
}

console.error('Unexpected rg exit status:', result.status);
if (result.stdout) {
  console.error(result.stdout.trim());
}
if (result.stderr) {
  console.error(result.stderr.trim());
}
process.exit(result.status ?? 2);
