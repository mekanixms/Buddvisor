/**
 * Filesystem jail for terminal sessions (Linux and macOS).
 *
 * Hard jail (OS-enforced, used when available and self-test passes):
 *   - Linux:  bubblewrap (`bwrap`): read-only view of the system, writable
 *             workspace + private /tmp, the app directory and the user's home
 *             are hidden, separate PID namespace.
 *   - macOS:  `sandbox-exec`: writes only inside the workspace and temp dirs,
 *             file contents under the app directory and home unreadable.
 * Soft jail (fallback): the shell starts in the workspace and is pulled back if
 * `cd` leaves it. This is NOT a security boundary against a hostile command.
 *
 * TERMINAL_SANDBOX=auto (default) | off | required
 * TERMINAL_JAIL_HIDE_PATHS   extra comma-separated paths to hide
 * TERMINAL_JAIL_ALLOW_READ   comma-separated paths to make readable again
 *                            (e.g. a toolchain installed under the home dir)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const logger = require('../../../utils/logger');

const SYSTEM_DIRS = new Set(['/', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/dev', '/proc', '/sys']);
const SELF_TEST_TIMEOUT_MS = 8000;
const ASSIGNED_DOCUMENTS_DIR = 'assigned_documents';

let detection = null;

function getMode() {
  const mode = String(process.env.TERMINAL_SANDBOX || 'auto').trim().toLowerCase();
  return ['auto', 'off', 'required'].includes(mode) ? mode : 'auto';
}

function splitPaths(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function realPathIfExists(candidate) {
  try {
    return fs.realpathSync(candidate);
  } catch (error) {
    return null;
  }
}

function findExecutable(name) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (error) {
      // keep looking
    }
  }
  return null;
}

function isInside(child, parent) {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/** Paths the jailed shell must not read: app directory, home, plus configured extras. */
function getHiddenPaths() {
  const candidates = [os.homedir(), process.cwd(), ...splitPaths(process.env.TERMINAL_JAIL_HIDE_PATHS)];
  const resolved = candidates
    .map(realPathIfExists)
    .filter((entry) => entry && !SYSTEM_DIRS.has(entry));
  return [...new Set(resolved)].sort((a, b) => a.length - b.length);
}

function getAllowedReadPaths() {
  return splitPaths(process.env.TERMINAL_JAIL_ALLOW_READ).map(realPathIfExists).filter(Boolean);
}

/** Real files behind assigned_documents/ symlinks; they live outside the workspace. */
function getDocumentTargets(workspace) {
  const dir = path.join(workspace, ASSIGNED_DOCUMENTS_DIR);
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch (error) {
    return [];
  }
  const targets = [];
  for (const entry of entries) {
    const target = realPathIfExists(path.join(dir, entry));
    if (target && !isInside(target, workspace)) targets.push(target);
  }
  return targets;
}

function bwrapArgs(workspace, { hide, allowRead, documentTargets }) {
  const args = [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    '--unshare-pid',
    '--unshare-ipc',
    '--die-with-parent',
  ];
  for (const hidden of hide) args.push('--tmpfs', hidden);
  for (const allowed of allowRead) args.push('--ro-bind', allowed, allowed);
  args.push('--bind', workspace, workspace);
  for (const target of documentTargets) args.push('--ro-bind', target, target);
  args.push('--chdir', workspace, '--');
  return args;
}

function sbplString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function sandboxExecProfile(workspace, { hide, allowRead, documentTargets }) {
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* (subpath ${sbplString(workspace)}) (subpath "/private/tmp") (subpath "/private/var/folders")` +
      ' (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper")' +
      ' (regex #"^/dev/ttys[0-9]+$") (regex #"^/dev/fd/[0-9]+$"))',
  ];
  for (const hidden of hide) lines.push(`(deny file-read-data (subpath ${sbplString(hidden)}))`);
  for (const allowed of allowRead) lines.push(`(allow file-read-data (subpath ${sbplString(allowed)}))`);
  lines.push(`(allow file-read-data (subpath ${sbplString(workspace)}))`);
  for (const target of documentTargets) lines.push(`(allow file-read-data (literal ${sbplString(target)}))`);
  return lines.join('\n');
}

/**
 * Build the command prefix that wraps the shell in the jail.
 * @returns {string[]} argv prefix (empty for the soft jail)
 */
function buildWrapper(kind, workspace, overrides = {}) {
  if (!kind) return [];
  const options = {
    hide: overrides.hide || getHiddenPaths(),
    allowRead: overrides.allowRead || getAllowedReadPaths(),
    documentTargets: overrides.documentTargets || getDocumentTargets(workspace),
  };
  if (kind === 'bwrap') return [findExecutable('bwrap') || 'bwrap', ...bwrapArgs(workspace, options)];
  if (kind === 'sandbox-exec') {
    return ['/usr/bin/sandbox-exec', '-p', sandboxExecProfile(workspace, options)];
  }
  throw new Error(`Unknown sandbox kind: ${kind}`);
}

/**
 * Prove the jail works on this host: allowed write succeeds, write outside the
 * workspace is refused.
 */
function selfTest(kind) {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bvd-jail-'));
  const workspace = fs.realpathSync(probeDir);
  const outside = path.join(os.homedir(), `.bvd_jail_probe_${process.pid}`);
  try {
    const wrapper = buildWrapper(kind, workspace, { hide: [], allowRead: [], documentTargets: [] });
    const script = `touch "${workspace}/ok" && ! touch "${outside}" 2>/dev/null`;
    const result = spawnSync(wrapper[0], [...wrapper.slice(1), '/bin/sh', '-c', script], {
      timeout: SELF_TEST_TIMEOUT_MS,
      encoding: 'utf8',
    });
    const worked = result.status === 0 && fs.existsSync(path.join(workspace, 'ok')) && !fs.existsSync(outside);
    const detail = worked ? '' : (result.stderr || result.error?.message || `exit ${result.status}`).toString().trim();
    return { ok: worked, detail };
  } catch (error) {
    return { ok: false, detail: error.message };
  } finally {
    fs.rmSync(outside, { force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function detect() {
  const mode = getMode();
  if (mode === 'off') return { kind: null, mode, reason: 'TERMINAL_SANDBOX=off' };

  let kind = null;
  if (process.platform === 'linux' && findExecutable('bwrap')) kind = 'bwrap';
  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec')) kind = 'sandbox-exec';
  if (!kind) {
    const missing = process.platform === 'linux' ? 'bwrap (bubblewrap) not installed' : 'sandbox-exec not available';
    return { kind: null, mode, reason: missing };
  }

  const test = selfTest(kind);
  if (!test.ok) {
    return { kind: null, mode, reason: `${kind} self-test failed${test.detail ? `: ${test.detail}` : ''}` };
  }
  return { kind, mode, reason: null };
}

/**
 * Decide once per process which jail to use.
 * @throws {Error} in required mode when no hard jail is available
 */
function resolveSandbox() {
  if (!detection) {
    detection = detect();
    if (detection.kind) {
      logger.info(`[terminal] Filesystem jail: ${detection.kind}`);
    } else {
      logger.warn(`[terminal] No OS-level jail (${detection.reason}); using soft jail only`);
    }
  }
  if (detection.mode === 'required' && !detection.kind) {
    throw new Error(`TERMINAL_SANDBOX=required but no OS-level jail is available (${detection.reason})`);
  }
  return detection;
}

function resetDetection() {
  detection = null;
}

module.exports = {
  resolveSandbox,
  resetDetection,
  buildWrapper,
  bwrapArgs,
  sandboxExecProfile,
  getHiddenPaths,
  getDocumentTargets,
  isInside,
};
