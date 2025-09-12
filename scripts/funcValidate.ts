import { spawnSync } from 'node:child_process';

type Settings = Record<string, string>;

function getArg(name: string): string | undefined {
  const eq = `--${name}=`;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith(eq)) return a.slice(eq.length);
    if (a === `--${name}`) return args[i + 1];
  }
  return undefined;
}

function runAz(args: string[], opts: { json?: boolean } = {}): any {
  const res = spawnSync('az', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (res.status !== 0) {
    throw new Error(`az ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  }
  const out = res.stdout || '';
  return opts.json ? JSON.parse(out) : out.trim();
}

function checkAzInstalled() {
  const res = spawnSync('az', ['--version'], { stdio: 'ignore' });
  if (res.status !== 0) {
    console.error('[func:validate] Azure CLI `az` not found or not working.');
    console.error('Install and login with:');
    console.error('  - https://learn.microsoft.com/cli/azure/install-azure-cli');
    console.error('  - az login');
    process.exit(1);
  }
}

function validateSettings(values: Settings) {
  const errors: string[] = [];
  const warnings: string[] = [];

  const required = ['AzureWebJobsStorage', 'SP_HOSTNAME', 'GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET'];
  for (const k of required) {
    if (!values[k] || String(values[k]).trim().length === 0) errors.push(`Missing required setting: ${k}`);
  }

  const spHost = String(values['SP_HOSTNAME'] || '').trim();
  if (/^https?:\/\//i.test(spHost)) errors.push('SP_HOSTNAME should be a hostname only (e.g., contoso.sharepoint.com), not a full URL.');
  const hasSharepoint = /sharepoint\./i.test(spHost);
  const isSharepointCom = /\.sharepoint\.com$/i.test(spHost);
  if (!hasSharepoint) errors.push('SP_HOSTNAME does not look like a SharePoint Online hostname (missing "sharepoint."). Example: contoso.sharepoint.com');
  else if (!isSharepointCom) warnings.push(`SP_HOSTNAME '${spHost}' is not on .sharepoint.com (could be regional like .sharepoint.us). Ensure this is correct.`);

  const guidRe = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  const tenant = String(values['GRAPH_TENANT_ID'] || '').trim();
  const client = String(values['GRAPH_CLIENT_ID'] || '').trim();
  if (tenant && !guidRe.test(tenant)) errors.push('GRAPH_TENANT_ID must be a GUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).');
  if (client && !guidRe.test(client)) errors.push('GRAPH_CLIENT_ID must be a GUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).');

  const secret = String(values['GRAPH_CLIENT_SECRET'] || '').trim();
  if (!secret || secret.startsWith('<') || secret.endsWith('>')) warnings.push('GRAPH_CLIENT_SECRET looks like a placeholder. Replace it with the real application secret.');

  const fwr = String(values['FUNCTIONS_WORKER_RUNTIME'] || '').trim().toLowerCase();
  if (!fwr) warnings.push('FUNCTIONS_WORKER_RUNTIME is not set; recommended to set to "node".');
  else if (fwr !== 'node') warnings.push(`FUNCTIONS_WORKER_RUNTIME is '${fwr}'. This app expects Node.`);

  return { errors, warnings };
}

async function main() {
  checkAzInstalled();

  const app = getArg('name') || process.argv.slice(2).find(a => !a.startsWith('--')) || process.env.AZURE_FUNCTIONAPP_NAME;
  if (!app) {
    console.error('[func:validate] Missing Function App name. Use:');
    console.error('  npm run func:validate -- <app>');
    console.error('  or: npm run func:validate -- --name=<app>');
    console.error('  or set env: AZURE_FUNCTIONAPP_NAME');
    process.exit(1);
  }
  const rgArg = getArg('resource-group') || getArg('rg');
  const subArg = getArg('subscription') || getArg('sub');
  let rg = rgArg || process.env.AZURE_RESOURCE_GROUP;

  // Subscription selection and report
  const subEnv = process.env.AZURE_SUBSCRIPTION;
  if (subArg || subEnv) {
    const sub = subArg || subEnv!;
    try { runAz(['account', 'set', '--subscription', sub]); } catch (e: any) {
      console.error('[func:validate] Failed to set subscription:', e?.message || e);
      process.exit(1);
    }
  }
  let subId = 'unknown';
  let subName = 'unknown';
  try {
    const acct = runAz(['account', 'show', '-o', 'json'], { json: true }) as any;
    subId = acct?.id || subId;
    subName = acct?.name || subName;
  } catch {}
  console.log(`[func:validate] Subscription: ${subName} (${subId})`);

  if (!rg) {
    // Try to resolve resource group automatically (within current subscription)
    try {
      const out = runAz(['functionapp', 'list', '--query', `[?name=='${app}'].resourceGroup`, '-o', 'tsv']) as string;
      rg = (out || '').split(/\r?\n/)[0]?.trim();
      if (rg) console.log(`[func:validate] Resolved resource group: ${rg}`);
    } catch {}
  }

  if (!rg) {
    console.error('[func:validate] Resource group not provided and could not be resolved. Provide with:');
    console.error('  --resource-group <rg> or env AZURE_RESOURCE_GROUP');
    process.exit(1);
  }

  console.log(`[func:validate] Fetching app settings for ${app} (rg=${rg}) ...`);
  let list: any[] = [];
  try {
    list = runAz(['functionapp', 'config', 'appsettings', 'list', '--name', app, '--resource-group', rg, '-o', 'json'], { json: true });
  } catch (e: any) {
    console.error('[func:validate] Failed to fetch app settings:', e?.message || e);
    process.exit(1);
  }
  const map: Settings = {};
  for (const item of list) {
    if (item && item.name) map[item.name] = item.value || '';
  }

  const { errors, warnings } = validateSettings(map);
  for (const w of warnings) console.warn('[func:validate] Warning:', w);
  if (errors.length) {
    for (const er of errors) console.error('[func:validate] Error:', er);
    console.error('[func:validate] Validation failed. Fix the above settings. Example to set values:');
    console.error(`az functionapp config appsettings set --name ${app} --resource-group ${rg} --settings \\`);
    console.error(`  SP_HOSTNAME=contoso.sharepoint.com GRAPH_TENANT_ID=<tenant-guid> GRAPH_CLIENT_ID=<app-id> GRAPH_CLIENT_SECRET=<secret>`);
    process.exit(1);
  }
  console.log('[func:validate] OK: Required settings are present and look valid.');
}

main().catch(err => { console.error('[func:validate] error:', (err as any)?.message || err); process.exit(1); });
