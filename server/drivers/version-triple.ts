export type VersionTriple = readonly [number, number, number];

export function parseVersionTriple(value: string): VersionTriple | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function versionAtLeast(installed: VersionTriple, floor: VersionTriple): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (installed[i] !== floor[i]) return installed[i] > floor[i];
  }
  return true;
}
