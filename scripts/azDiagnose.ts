import { spawnSync } from 'node:child_process';

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

function runAz(args: string[], opts: { json?: boolean } = {}) {
  const res = spawnSync('az', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (res.status !== 0) {
    const msg = res.stderr || res.stdout || `az ${args.join(' ')} failed`;
    throw new Error(msg);
  }
  const out = res.stdout || '';
  return opts.json ? JSON.parse(out) : out.trim();
}

function ensureAz() {
  const res = spawnSync('az', ['--version'], { stdio: 'ignore' });
  if (res.status !== 0) {
    console.error('[az:diagnose] Azure CLI `az` not found. Install and login:');
    console.error('  - Install: https://learn.microsoft.com/cli/azure/install-azure-cli');
    console.error('  - Login:   az login');
    process.exit(1);
  }
}

function classifyPlan(sku: any): string {
  const name = (sku?.name || '').toUpperCase();
  const tier = (sku?.tier || '').toUpperCase();
  if (name === 'Y1' || tier === 'DYNAMIC') return 'Consumption (Y1)';
  if (name.startsWith('EP') || tier.includes('ELASTICP')) return 'Premium (Elastic Premium)';
  if (['F1','B1','B2','B3','S1','S2','S3','P1V3','P2V3','P3V3'].includes(name) || tier) return `App Service Plan (${tier || name})`;
  return 'Unknown';
}

async function main() {
  ensureAz();

  const app = getArg('name') || process.argv.slice(2).find(a => !a.startsWith('--')) || process.env.AZURE_FUNCTIONAPP_NAME;
  if (!app) {
    console.error('[az:diagnose] Missing Function App name. Use:');
    console.error('  npm run az:diagnose -- <app>');
    console.error('  or: npm run az:diagnose -- --name=<app>');
    console.error('  or set env: AZURE_FUNCTIONAPP_NAME');
    process.exit(1);
  }

  const sub = getArg('subscription') || getArg('sub') || process.env.AZURE_SUBSCRIPTION;
  if (sub) {
    try { runAz(['account', 'set', '--subscription', sub]); } catch (e: any) {
      console.error('[az:diagnose] Failed to set subscription:', e?.message || e);
      process.exit(1);
    }
  }
  try {
    const acct = runAz(['account', 'show', '-o', 'json'], { json: true });
    console.log(`[az:diagnose] Subscription: ${acct?.name || 'unknown'} (${acct?.id || 'unknown'})`);
  } catch {}

  // Resolve resource group if not provided
  let rg = getArg('resource-group') || getArg('rg') || process.env.AZURE_RESOURCE_GROUP;
  if (!rg) {
    try {
      const out = runAz(['functionapp', 'list', '--query', `[?name=='${app}'].resourceGroup`, '-o', 'tsv']) as string;
      rg = (out || '').split(/\r?\n/)[0]?.trim();
      if (rg) console.log(`[az:diagnose] Resolved resource group: ${rg}`);
    } catch {}
  }
  if (!rg) {
    console.error('[az:diagnose] Resource group not provided and could not be resolved. Provide with --resource-group or set AZURE_RESOURCE_GROUP.');
    process.exit(1);
  }

  // Function App details
  let fa: any;
  try {
    fa = runAz(['functionapp', 'show', '--name', app, '--resource-group', rg, '-o', 'json'], { json: true });
  } catch (e: any) {
    console.error('[az:diagnose] Failed to fetch function app:', e?.message || e);
    process.exit(1);
  }
  const siteConfig = fa?.siteConfig || {};
  console.log(`[az:diagnose] FunctionApp: ${fa?.name} (${fa?.location}) runtime=${siteConfig?.linuxFxVersion || siteConfig?.windowsFxVersion || 'node'} alwaysOn=${siteConfig?.alwaysOn ?? 'n/a'}`);

  // Hosting plan
  const serverFarmId: string = fa?.serverFarmId || '';
  let planName = 'unknown', planRg = rg;
  const m = serverFarmId.match(/providers\/Microsoft\.Web\/serverfarms\/([^\/]*)$/i);
  if (m) planName = m[1];
  const rgMatch = serverFarmId.match(/resourceGroups\/([^\/]*)/i);
  if (rgMatch) planRg = rgMatch[1];
  let plan: any = null;
  try {
    plan = runAz(['appservice', 'plan', 'show', '--name', planName, '--resource-group', planRg, '-o', 'json'], { json: true });
  } catch (e: any) {
    console.warn('[az:diagnose] Warning: failed to fetch app service plan. Raw id:', serverFarmId);
  }
  const sku = plan?.sku || {};
  const planType = classifyPlan(sku);
  console.log(`[az:diagnose] Plan: ${planName} (${planType}) sku=${sku?.tier || ''}/${sku?.name || ''} location=${plan?.location || 'unknown'}`);
  if (planType !== 'Consumption (Y1)') {
    console.warn('[az:diagnose] Heads-up: Non-consumption plans (Premium/App Service Plan) incur hourly charges even when idle.');
  }

  // App settings: look for App Insights keys
  let settings: any[] = [];
  try {
    settings = runAz(['functionapp', 'config', 'appsettings', 'list', '--name', app, '--resource-group', rg, '-o', 'json'], { json: true });
  } catch {}
  const toMap: Record<string,string> = {};
  for (const s of settings) toMap[s.name] = s.value;
  const ikey = toMap['APPINSIGHTS_INSTRUMENTATIONKEY'] || '';
  const conn = toMap['APPLICATIONINSIGHTS_CONNECTION_STRING'] || '';
  if (ikey) console.log(`[az:diagnose] App Insights instrumentation key found (APPINSIGHTS_INSTRUMENTATIONKEY=****${ikey.slice(-6)})`);
  if (conn) console.log('[az:diagnose] App Insights connection string found (APPLICATIONINSIGHTS_CONNECTION_STRING=present)');

  // Try to locate the App Insights component in this resource group
  if (ikey) {
    try {
      const comps: any[] = runAz(['monitor', 'app-insights', 'component', 'list', '--resource-group', rg, '-o', 'json'], { json: true });
      const match = comps.find(c => (c?.InstrumentationKey || c?.instrumentationKey) === ikey);
      if (match) {
        console.log(`[az:diagnose] App Insights: ${match?.name} (${match?.location}) retention=${match?.RetentionInDays ?? match?.retentionInDays ?? 'n/a'} days`);
        if (match?.workspaceResourceId) console.log(`[az:diagnose] Workspace-based: ${match.workspaceResourceId}`);
      } else {
        console.warn('[az:diagnose] Could not match instrumentation key to an App Insights resource in this RG.');
      }
    } catch (e: any) {
      console.warn('[az:diagnose] Warning: failed to list App Insights components:', e?.message || e);
    }
  }

  // Optional: if workspace is known, try to query ingestion over last 1 day
  try {
    const comps: any[] = runAz(['monitor', 'app-insights', 'component', 'list', '--resource-group', rg, '-o', 'json'], { json: true });
    const w = comps.find(c => c?.workspaceResourceId);
    if (w?.workspaceResourceId) {
      console.log('[az:diagnose] Querying Log Analytics Usage for last 1 day ...');
      const q = 'Usage | where TimeGenerated > ago(1d) | summarize MB=sum(Quantity) by DataType | sort by MB desc | take 10';
      const usage = runAz(['monitor', 'log-analytics', 'query', '--workspace', w.workspaceResourceId, '--analytics-query', q, '-o', 'json'], { json: true });
      const rows = usage?.tables?.[0]?.rows || [];
      for (const row of rows) {
        console.log(`[az:diagnose] LA Usage: ${row[0]} ${row[1]} MB`);
      }
    }
  } catch (e: any) {
    console.warn('[az:diagnose] Skipping Log Analytics usage query (missing permissions or workspace).');
  }

  console.log('\n[az:diagnose] Tip: For exact $$, open Cost Management in Azure Portal and group by Resource.');
  console.log('[az:diagnose] If plan is not Consumption (Y1), switch plans or offload long jobs to Container Apps Jobs.');
}

main().catch(err => { console.error('[az:diagnose] error:', (err as any)?.message || err); process.exit(1); });

