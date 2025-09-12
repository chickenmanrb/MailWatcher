import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';

async function readLocalSettings(funcDir: string): Promise<Record<string, string> | null> {
  try {
    const p = path.join(funcDir, 'local.settings.json');
    const txt = await fs.readFile(p, 'utf8');
    const json = JSON.parse(txt);
    return (json && json.Values) || null;
  } catch {
    return null;
  }
}

function missingKeys(values: Record<string, string> | null, required: string[]): string[] {
  const v = values || {};
  const miss: string[] = [];
  for (const k of required) {
    const val = (v as any)[k];
    if (!val || String(val).trim().length === 0) miss.push(k);
  }
  return miss;
}

function checkFuncInstalled() {
  try {
    const out = spawnSync('func', ['--version'], { stdio: 'ignore', shell: true });
    if (out.error || out.status !== 0) throw out.error || new Error('func returned non-zero');
  } catch (e) {
    console.error('[func:start] Azure Functions Core Tools `func` not found.');
    console.error('Install it with one of:');
    console.error('  - npm:   npm i -g azure-functions-core-tools@4 --unsafe-perm true');
    console.error('  - brew:  brew tap azure/functions; brew install azure-functions-core-tools@4');
    console.error('  - choco: choco install azure-functions-core-tools-4');
    process.exit(1);
  }
}

function main() {
  checkFuncInstalled();
  const cwd = path.join(process.cwd(), 'functions');
  const funcDir = cwd;

  // Preflight: local.settings.json and required envs
  (async () => {
    const values = await readLocalSettings(funcDir);
    const required = [
      'AzureWebJobsStorage',
      'SP_HOSTNAME',
      'GRAPH_TENANT_ID',
      'GRAPH_CLIENT_ID',
      'GRAPH_CLIENT_SECRET'
    ];
    const miss = missingKeys(values, required);
    if (miss.length > 0) {
      console.error('[func:start] Missing required settings in functions/local.settings.json:', miss.join(', '));
      console.error('[func:start] Create or update functions/local.settings.json with:');
      console.error(`{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "WEBHOOK_SECRET": "dev",
    "SP_HOSTNAME": "contoso.sharepoint.com",
    "GRAPH_TENANT_ID": "<tenant-guid>",
    "GRAPH_CLIENT_ID": "<app-id>",
    "GRAPH_CLIENT_SECRET": "<secret>",
    "JOB_MAX_MS": "1800000"
  }
}`);
      console.error('[func:start] If using UseDevelopmentStorage, ensure Azurite is installed and running.');
      process.exit(1);
    }

    const storage = values?.AzureWebJobsStorage || '';
    if (/UseDevelopmentStorage=true/i.test(storage)) {
      console.log('[func:start] Using Azurite (UseDevelopmentStorage=true). Ensure Azurite is running on localhost.');
    }

    // Additional validation for novice devs
    const errors: string[] = [];
    const warnings: string[] = [];

    const spHost = String(values?.SP_HOSTNAME || '').trim();
    if (/^https?:\/\//i.test(spHost)) {
      errors.push('SP_HOSTNAME should be a hostname only (e.g., contoso.sharepoint.com), not a full URL.');
    }
    const isSharepointCom = /\.sharepoint\.com$/i.test(spHost);
    const isSharepointAny = /sharepoint\./i.test(spHost);
    if (!isSharepointAny) {
      errors.push('SP_HOSTNAME does not look like a SharePoint Online hostname (missing "sharepoint."). Example: contoso.sharepoint.com');
    } else if (!isSharepointCom) {
      warnings.push(`SP_HOSTNAME '${spHost}' is not on .sharepoint.com (possibly regional like .sharepoint.us). Ensure this is correct.`);
    }

    const guidRe = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    const tenant = String(values?.GRAPH_TENANT_ID || '').trim();
    const client = String(values?.GRAPH_CLIENT_ID || '').trim();
    if (!guidRe.test(tenant)) errors.push('GRAPH_TENANT_ID must be a GUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).');
    if (!guidRe.test(client)) errors.push('GRAPH_CLIENT_ID must be a GUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).');

    const secret = String(values?.GRAPH_CLIENT_SECRET || '').trim();
    if (!secret || secret.startsWith('<') || secret.endsWith('>')) {
      warnings.push('GRAPH_CLIENT_SECRET looks like a placeholder. Replace it with the real application secret.');
    }

    if (warnings.length) {
      for (const w of warnings) console.warn('[func:start] Warning:', w);
    }
    if (errors.length) {
      for (const e of errors) console.error('[func:start] Error:', e);
      process.exit(1);
    }

    console.log('[func:start] Starting Azure Functions locally from', cwd);
    const child = spawn('func', ['start'], { cwd, stdio: 'inherit', shell: true });
    child.on('exit', (code) => process.exit(code || 0));
  })().catch((e) => {
    console.error('[func:start] preflight error', e?.message || e);
    process.exit(1);
  });
}

main();
