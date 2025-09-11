import 'dotenv/config';
import { resolveFolderFromWebUrl, resolveFolderId } from '../upload/sharepoint.js';

function getArg(name: string) {
  const flag = `--${name}=`;
  const hit = process.argv.find(a => a.startsWith(flag));
  return hit ? hit.substring(flag.length) : undefined;
}

async function main() {
  const url = getArg('url');
  const raw = getArg('id') || process.env.SP_ID || process.argv.find(a => !a.startsWith('--') && a !== process.argv[1] && a !== process.argv[0]);
  if (!raw && !url) {
    console.error('Usage: npm run sp:resolve -- --id="<GUID or DriveItem ID>" | --url="<folder web URL>"');
    process.exit(1);
  }

  try {
    const resolved = url ? await resolveFolderFromWebUrl(url) : await resolveFolderId(raw!);
    const out = {
      input: url || raw,
      driveId: resolved.driveId,
      itemId: resolved.itemId,
      webUrl: resolved.webUrl || null
    };
    console.log(JSON.stringify(out, null, 2));
  } catch (e: any) {
    console.error('[sp:resolve] error:', e?.message || e);
    process.exit(2);
  }
}

main().catch(err => { console.error(err); process.exit(3); });
