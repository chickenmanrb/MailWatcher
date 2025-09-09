import fs from 'node:fs/promises';
import path from 'node:path';

export async function writeAudit(dir: string, payload: unknown) {
  const p = path.join(dir, 'audit.json');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(p, JSON.stringify(payload, null, 2), 'utf8');
  return p;
}

