import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { win32 } from 'node:path';

const RELATIVE_UPIA = win32.join('Adobe', 'Adobe Desktop Common', 'RemoteComponents', 'UPI', 'UnifiedPluginInstallerAgent', 'UnifiedPluginInstallerAgent.exe');

export function findUpia({ env = process.env, platform = process.platform, exists = existsSync } = {}) {
  if (platform !== 'win32') return null;
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)']]
    .filter((root) => typeof root === 'string' && win32.isAbsolute(root));
  for (const root of roots) {
    const candidate = win32.join(root, 'Common Files', RELATIVE_UPIA);
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function installCcx({ ccxPath, upiaPath, execFile = execFileSync } = {}) {
  if (!upiaPath) return { status: 'fallback_required', upiaPath: null, error: 'UPIA is not installed.' };
  try {
    execFile(upiaPath, ['/install', ccxPath], { stdio: 'inherit', windowsHide: true });
    return { status: 'installed', upiaPath };
  } catch (error) {
    return { status: 'fallback_required', upiaPath, error: error.message };
  }
}

export function removeCcx({ ccxPath, upiaPath, execFile = execFileSync } = {}) {
  if (!upiaPath) return { status: 'fallback_required', upiaPath: null, error: 'UPIA is not installed.' };
  try {
    execFile(upiaPath, ['/remove', ccxPath], { stdio: 'inherit', windowsHide: true });
    return { status: 'removed', upiaPath };
  } catch (error) {
    return { status: 'fallback_required', upiaPath, error: error.message };
  }
}

export function uxpExitCode(result, remove = false) {
  if (result.status === (remove ? 'removed' : 'installed')) return 0;
  return remove ? 4 : 3;
}
