import AdmZip from 'adm-zip';
import path from 'node:path';
import fs from 'node:fs/promises';

export async function zipArtifacts(baseDir: string) {
  const zip = new AdmZip();
  zip.addLocalFolder(baseDir);
  const out = path.join(baseDir, '..', path.basename(baseDir) + '.zip');
  await fs.writeFile(out, zip.toBuffer());
  return out;
}

