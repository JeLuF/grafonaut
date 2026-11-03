import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

// What is running: version, commit (and when it was committed), and when the Docker image was built. Images from the
// release workflow get version, commit and commit time as build arguments (GRAFONAUT_VERSION, GRAFONAUT_COMMIT,
// GRAFONAUT_COMMITTED_AT); without them, git is asked. Every image records its build time in .image-built-at
// (Dockerfile); outside an image there is none.
function git(args) {
  try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim() || null; }
  catch { return null; }
}

export function buildInfo(env = process.env, { packageFile = new URL('../package.json', import.meta.url), imageFile = new URL('../.image-built-at', import.meta.url),
  readGit = git } = {}) {
  let packageVersion = null;
  try { packageVersion = JSON.parse(fs.readFileSync(packageFile, 'utf8')).version ?? null; } catch { /* no package.json */ }
  const commit = env.GRAFONAUT_COMMIT?.trim() || readGit(['rev-parse', 'HEAD']);
  const fromGit = !env.GRAFONAUT_COMMIT?.trim() && commit;
  let imageBuiltAt = null;
  try { imageBuiltAt = fs.readFileSync(imageFile, 'utf8').trim() || null; } catch { /* not a Docker image */ }
  return {
    version: env.GRAFONAUT_VERSION?.trim() || packageVersion,
    commit,
    committedAt: env.GRAFONAUT_COMMITTED_AT?.trim() || (fromGit ? readGit(['log', '-1', '--format=%cI']) : null),
    imageBuiltAt,
    // A checkout with uncommitted changes (development) is marked as such.
    modified: fromGit ? Boolean(readGit(['status', '--porcelain', '--untracked-files=no'])) : false,
    node: process.version,
    startedAt: new Date().toISOString()
  };
}
