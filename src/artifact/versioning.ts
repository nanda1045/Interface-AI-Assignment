// Small deterministic semantic-version helper used when re-recording a capability
// without replacing the previously reviewed version.
export type VersionBump = "patch" | "minor" | "major";

export function bumpVersion(version: string, bump: VersionBump): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Invalid semantic version: ${version}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}
