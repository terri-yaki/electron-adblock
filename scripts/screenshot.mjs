import { spawn } from 'node:child_process';
import { existsSync as fsExists } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const root = fileURLToPath(new URL('..', import.meta.url));

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  if (index === -1) return fallback;
  const next = process.argv[index + 1];
  return next && !next.startsWith('--') ? next : true;
}

const out = String(arg('out', path.join(root, '_shots', 'ui.png')));
const mock = arg('mock', false) === true;
const delay = String(arg('delay', '1800'));
const width = String(arg('width', '1240'));
const height = String(arg('height', '820'));
const search = String(arg('search', ''));

await mkdir(path.dirname(out), { recursive: true });
await rm(out, { force: true });

const env = {
  ...process.env,
  EAB_SHOT: out,
  EAB_SHOT_DELAY_MS: delay,
  EAB_WINDOW_WIDTH: width,
  EAB_WINDOW_HEIGHT: height,
};
if (mock) env.EAB_MOCK = '1';
if (search) env.EAB_SHOT_SEARCH = search;
// DSH/Electron host sets this; it would run our app as plain Node.
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const child = spawn(electronPath, ['.'], {
  cwd: root,
  env,
  stdio: 'inherit',
  windowsHide: false,
});

const code = await new Promise((resolve) => child.on('exit', resolve));
if (code !== 0) {
  console.error('screenshot run failed with exit code ' + code);
  process.exit(1);
}
if (!fsExists(out)) {
  console.error(
    'screenshot was not written (another Electron Adblock instance may hold the profile lock; set EAB_PROFILE_DIR to isolate)',
  );
  process.exit(1);
}
console.log(out);
