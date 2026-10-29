import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = path.join(root, 'build');

async function main() {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  const common = {
    bundle: true,
    sourcemap: false,
    logLevel: 'warning',
    absWorkingDir: root,
    define: { 'process.env.NODE_ENV': '"production"' },
  };

  await Promise.all([
    build({
      ...common,
      entryPoints: ['src/main/main.ts'],
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      external: ['electron'],
      outfile: 'build/main.cjs',
    }),
    build({
      ...common,
      entryPoints: ['src/main/preload.ts'],
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      external: ['electron'],
      outfile: 'build/preload.cjs',
    }),
    build({
      ...common,
      entryPoints: ['src/injected/index.ts'],
      platform: 'browser',
      format: 'iife',
      target: 'chrome120',
      outfile: 'build/injected.js',
    }),
    build({
      ...common,
      entryPoints: ['src/renderer/app.ts'],
      platform: 'browser',
      format: 'iife',
      target: 'chrome120',
      outfile: 'build/renderer.js',
    }),
  ]);

  await cp(path.join(root, 'src/renderer/index.html'), path.join(out, 'index.html'));
  await cp(path.join(root, 'src/renderer/styles.css'), path.join(out, 'styles.css'));
  await cp(path.join(root, 'assets'), path.join(out, 'assets'), { recursive: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
