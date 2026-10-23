// What a root entry point needs to run `maus` children safely: their ids, a check that root runs only root's code, and
// secrets handed over a pipe instead of the environment (/proc/<pid>/environ stays readable by the same user).
import { spawn, type ChildProcess } from "node:child_process";
import { statSync, type Stats } from "node:fs";
import { dirname, posix } from "node:path";

export const SECRETS_FD = 3;

/** uid/gid from /etc/passwd; Node has no getpwnam. */
export function passwdIds(passwd: string, name: string): { uid: number; gid: number } | null {
  for (const line of passwd.split("\n")) {
    const [user, , uid, gid] = line.split(":");
    if (user === name && /^\d+$/.test(uid ?? "") && /^\d+$/.test(gid ?? "")) return { uid: Number(uid), gid: Number(gid) };
  }
  return null;
}

/** Each file and every folder above it must be root's and not writable by others, and never on the `maus`-owned volume:
 * otherwise `maus` could rewrite what runs as root at the next start. */
export function codeTrustProblem(files: readonly string[], home: string, stat: (path: string) => Pick<Stats, "uid" | "mode"> = statSync): string | null {
  const volume = posix.join(home, "/");
  for (const file of files) {
    if (file === home || file.startsWith(volume)) return `${file} is on the volume`;
    for (let path = file; ; path = dirname(path)) {
      let owner: Pick<Stats, "uid" | "mode">;
      try { owner = stat(path); } catch { return `${path} cannot be checked`; }
      if (owner.uid !== 0) return `${path} is not root's`;
      // A folder with the sticky bit (/tmp) lets nobody replace root's files.
      if (owner.mode & 0o022 && !(path !== file && owner.mode & 0o1000)) return `${path} is writable by others than root`;
      if (dirname(path) === path) break;
    }
  }
  return null;
}

/** Secrets go over an inherited pipe, never the environment; it is written and closed at once. */
export function spawnWithSecrets(command: string, args: string[], env: NodeJS.ProcessEnv, secrets: Record<string, string>,
  ids?: { uid: number; gid: number } | null, capture = false): ChildProcess {
  const child = spawn(command, args, { env,
    stdio: capture ? ["inherit", "pipe", "pipe", "pipe"] : ["inherit", "inherit", "inherit", "pipe"],
    ...(ids ? { uid: ids.uid, gid: ids.gid } : {}) });
  const pipe = child.stdio[SECRETS_FD] as NodeJS.WritableStream | null;
  pipe?.on("error", () => {});
  pipe?.end(JSON.stringify(secrets));
  return child;
}
