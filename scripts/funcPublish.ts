import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

function getArg(name: string): string | undefined {
  const eq = `--${name}=`;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith(eq)) return a.slice(eq.length);
    if (a === `--${name}`) {
      const i = process.argv.indexOf(a);
      return process.argv[i + 1];
    }
  }
  return undefined;
}

const appFromArg = getArg('name') || process.argv.slice(2).find(a => !a.startsWith('--'));
const appFromEnv = process.env.AZURE_FUNCTIONAPP_NAME;
const app = appFromArg || appFromEnv;

if (!app) {
  console.error('[func:publish] Missing Function App name. Pass as first arg, --name=<app>, or set AZURE_FUNCTIONAPP_NAME.');
  process.exit(1);
}

// Preflight: ensure `func` is installed
try {
  const out = spawnSync('func', ['--version'], { stdio: 'ignore', shell: true });
  if (out.error || out.status !== 0) throw out.error || new Error('func returned non-zero');
} catch (e) {
  console.error('[func:publish] Azure Functions Core Tools `func` not found.');
  console.error('Install it with one of:');
  console.error('  - npm:   npm i -g azure-functions-core-tools@4 --unsafe-perm true');
  console.error('  - brew:  brew tap azure/functions; brew install azure-functions-core-tools@4');
  console.error('  - choco: choco install azure-functions-core-tools-4');
  process.exit(1);
}

console.log(`[func:publish] Publishing Function App '${app}' ...`);

const cwd = path.join(process.cwd(), 'functions');
const child = spawn('func', ['azure', 'functionapp', 'publish', app], {
  cwd,
  stdio: 'inherit',
  shell: true,
});

child.on('exit', (code) => {
  if (code === 0) {
    console.log('[func:publish] Done.');
    process.exit(0);
  } else {
    console.error(`[func:publish] Failed with code ${code}`);
    process.exit(code || 1);
  }
});
