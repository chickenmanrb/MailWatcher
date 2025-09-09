export type Detection =
  | { kind: 'buildout'; domainKey: 'buildout'; urls: string[] }
  | { kind: 'crexi'; domainKey: 'crexi'; urls: string[] }
  | { kind: 'rcm'; domainKey: 'rcm'; urls: string[] }
  | { kind: 'generic'; domainKey: 'generic'; urls: string[] };

export function detectPlatform(urls: string[]): Detection {
  const u = urls.map(s => s.toLowerCase());
  const has = (needle: string) => u.some(x => x.includes(needle));

  if (has('buildout.com') || has('buildout.com/tenant') || has('buildout.com/website')) {
    return { kind: 'buildout', domainKey: 'buildout', urls };
  }
  if (has('crexi.com') || has('app.crexi.com')) {
    return { kind: 'crexi', domainKey: 'crexi', urls };
  }
  // RCM / Juniper / other common RCM domains
  if (has('rcm1.com') || has('junipercapitalmarket') || has('dealroom') || has('intralinks')) {
    return { kind: 'rcm', domainKey: 'rcm', urls };
  }
  return { kind: 'generic', domainKey: 'generic', urls };
}

