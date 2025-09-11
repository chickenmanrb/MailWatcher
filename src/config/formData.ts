import fs from 'node:fs/promises';
import path from 'node:path';

export type CanonicalKey =
  | 'EMAIL' | 'PASSWORD' | 'USERNAME' | 'FULL_NAME'
  | 'FIRST_NAME' | 'LAST_NAME'
  | 'COMPANY' | 'TITLE' | 'PHONE' | 'WEBSITE'
  | 'ADDRESS1' | 'ADDRESS2' | 'CITY' | 'STATE' | 'POSTAL_CODE' | 'COUNTRY';

export type FormDataMap = Partial<Record<CanonicalKey, string>>;

const FIELD_SYNONYMS: Array<[CanonicalKey, RegExp[]]> = [
  ['EMAIL', [/^email$/i, /e-?mail/i]],
  ['PASSWORD', [/^password$/i, /pass(code|word)?|pwd/i]],
  ['USERNAME', [/^username$/i, /user.?name(?!.*email)/i]],
  ['FIRST_NAME', [/^first(_|\s)?name$/i, /given[-\s]?name/i, /^fname$/i]],
  ['LAST_NAME', [/^last(_|\s)?name$/i, /family[-\s]?name/i, /^lname$/i, /surname/i]],
  ['FULL_NAME', [/^full(_|\s)?name$/i, /^(?<!first|last)name$/i]],
  ['COMPANY', [/company|organisation|organization|employer|business/i]],
  ['TITLE', [/title|role|position|job.?title/i]],
  ['PHONE', [/phone|mobile|cell|tel/i]],
  ['WEBSITE', [/website|url|homepage/i]],
  ['ADDRESS1', [/^address(?!.*(2|line\s*2))/i, /street(\s*1)?/i, /address[-_\s]*line[-_\s]*1/i]],
  ['ADDRESS2', [/address.*(2|line\s*2)/i, /apt|suite|unit/i]],
  ['CITY', [/city|town/i]],
  ['STATE', [/state|province|region/i]],
  ['POSTAL_CODE', [/zip|postal/i]],
  ['COUNTRY', [/country/i]],
];

export async function loadFormData(cwd = process.cwd()): Promise<FormDataMap> {
  const userPath = process.env.FORMDATA_PATH || path.join(cwd, 'formdata.md');
  let text: string | undefined;
  try {
    text = await fs.readFile(userPath, 'utf8');
  } catch {
    return {};
  }
  if (!text) return {};

  // Attempt to parse simple YAML-like front matter first
  const fm = parseFrontMatter(text);
  const pairs: Record<string, string> = fm ?? parseKeyValueLines(text);
  return mapToCanonical(pairs);
}

function parseFrontMatter(text: string): Record<string, string> | undefined {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return undefined;
  const body = m[1];
  const out: Record<string, string> = {};
  for (const line of body.split(/\r?\n/)) {
    const kv = line.match(/^\s*([A-Za-z0-9 _-]+)\s*:\s*(.+)\s*$/);
    if (kv) out[kv[1].trim()] = kv[2].trim();
  }
  return out;
}

function parseKeyValueLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  let inCode = false;
  for (let raw of lines) {
    const line = raw.trim();
    if (line.startsWith('```')) { inCode = !inCode; continue; }
    if (!line || inCode) continue;
    // bullets or plain k:v
    const m = line.match(/^[-*+]?\s*([A-Za-z0-9 _\-/]+)\s*[:=]\s*(.+)$/);
    if (m) {
      const key = m[1].trim();
      const val = m[2].trim();
      out[key] = val;
    }
  }
  return out;
}

function mapToCanonical(src: Record<string, string>): FormDataMap {
  const out: FormDataMap = {};
  for (const [kRaw, v] of Object.entries(src)) {
    const k = normalize(kRaw);
    const canon = findCanonical(k);
    if (canon && v) out[canon] = v;
  }
  return out;
}

function normalize(s: string) {
  return s.trim().toLowerCase();
}

function findCanonical(normKey: string): CanonicalKey | undefined {
  for (const [canon, res] of FIELD_SYNONYMS) {
    if (res.some(r => r.test(normKey))) return canon;
  }
  return undefined;
}

