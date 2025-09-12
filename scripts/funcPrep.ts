import fs from 'node:fs/promises';
import path from 'node:path';

async function exists(p: string) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function rimraf(p: string) {
  await fs.rm(p, { recursive: true, force: true });
}

async function mkdirp(p: string) {
  await fs.mkdir(p, { recursive: true });
}

async function copyDir(src: string, dst: string) {
  await mkdirp(dst);
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDir(s, d);
    } else if (entry.isFile()) {
      await fs.copyFile(s, d);
    }
  }
}

async function main() {
  const repoRoot = process.cwd();
  const distSrc = path.join(repoRoot, 'dist');
  const functionsDir = path.join(repoRoot, 'functions');
  const distDst = path.join(functionsDir, 'dist');

  if (!(await exists(distSrc))) {
    console.error('[func:prep] dist/ not found. Run `npm run build` first.');
    process.exit(1);
  }
  if (!(await exists(functionsDir))) {
    console.error('[func:prep] functions/ directory not found. Are you in the repo root?');
    process.exit(1);
  }

  console.log('[func:prep] Removing old functions/dist ...');
  await rimraf(distDst);
  console.log('[func:prep] Copying dist -> functions/dist ...');
  await copyDir(distSrc, distDst);
  console.log('[func:prep] Done. You can now publish from the `functions/` dir.');
}

main().catch(err => { console.error('[func:prep] error:', err?.message || err); process.exit(1); });

