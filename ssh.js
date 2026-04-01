import { readFile, appendFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { getBot, getBotWorkspace } from './bots.js';

const execFile = promisify(execFileCb);

// When WORKSPACE_BASE is set (Docker mode), use direct filesystem access.
// When not set (Mac dev mode), use SSH → Proxmox → LXC → Docker.
const IS_DOCKER = !!process.env.WORKSPACE_BASE;

if (IS_DOCKER) {
  console.log(`[workspace] Direct filesystem mode (base: ${process.env.WORKSPACE_BASE})`);
} else {
  console.log('[workspace] SSH mode: Mac → Proxmox → LXC 100 → Docker');
}

// ─── SSH mode (Mac Mini local dev) ──────────────────────────────────────────

const SSH_HOST = 'root@192.168.0.99';

async function ssh(command) {
  const { stdout } = await execFile('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=5',
    '-o', 'BatchMode=yes',
    SSH_HOST,
    command,
  ], { timeout: 15_000 });

  return stdout;
}

/**
 * Execute a command inside a Docker container via SSH.
 * Path: Mac Mini → SSH → Proxmox → LXC 100 → Docker container
 */
async function sshDockerExec(container, command) {
  const dockerCmd = `pct exec 100 -- docker exec ${container} bash -lc '${command.replace(/'/g, "'\\''")}'`;
  return ssh(dockerCmd);
}

// ─── Direct filesystem mode (Docker container) ─────────────────────────────

async function fsReadWorkspaceFile(workspacePath, filename) {
  try {
    const content = await readFile(join(workspacePath, filename), 'utf8');
    return content.trim() || null;
  } catch {
    return null;
  }
}

async function fsWriteMemoryEntry(workspacePath, date, content) {
  const memDir = join(workspacePath, 'memory');
  await mkdir(memDir, { recursive: true });
  await appendFile(join(memDir, `${date}.md`), content);
}

async function fsSearchMemory(workspacePath, query) {
  try {
    const memDir = join(workspacePath, 'memory');
    const files = await readdir(memDir);
    const mdFiles = files.filter(f => f.endsWith('.md')).sort().reverse();

    const lowerQuery = query.toLowerCase();
    const matches = [];

    for (const file of mdFiles.slice(0, 30)) {
      const content = await readFile(join(memDir, file), 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(lowerQuery)) {
          const start = Math.max(0, i - 1);
          const end = Math.min(lines.length, i + 2);
          matches.push(`${file}:\n${lines.slice(start, end).join('\n')}`);
          if (matches.length >= 15) break;
        }
      }
      if (matches.length >= 15) break;
    }

    return matches.join('\n---\n') || 'No matching memories found.';
  } catch {
    return 'No matching memories found.';
  }
}

// ─── SSH mode implementations ───────────────────────────────────────────────

function getSSHWorkspaceRoot(bot) {
  // Noel has a custom workspace path; Susan/alphaclaw uses the runtime.js path
  if (bot.sshWorkspaceRoot) return bot.sshWorkspaceRoot;
  // Default for alphaclaw-style containers
  return '/data/.openclaw/workspace';
}

async function sshReadWorkspaceFile(bot, filename) {
  try {
    const root = getSSHWorkspaceRoot(bot);
    const content = await sshDockerExec(bot.sshContainer, `cat ${root}/${filename}`);
    return content.trim() || null;
  } catch {
    return null;
  }
}

async function sshWriteMemoryEntry(bot, date, content) {
  const root = getSSHWorkspaceRoot(bot);
  const escaped = content.replace(/'/g, "'\\''");
  await sshDockerExec(
    bot.sshContainer,
    `mkdir -p ${root}/memory && printf '%s\\n' '${escaped}' >> ${root}/memory/${date}.md`
  );
}

async function sshSearchMemory(bot, query) {
  try {
    const root = getSSHWorkspaceRoot(bot);
    const escaped = query
      .replace(/'/g, "'\\''")
      .replace(/[\\*?[\]{}().+^$|]/g, '\\$&');
    const result = await sshDockerExec(
      bot.sshContainer,
      `grep -r -i -C 1 '${escaped}' ${root}/memory/ 2>/dev/null | head -30`
    );
    return result.trim() || 'No matching memories found.';
  } catch {
    return 'No matching memories found.';
  }
}

// ─── Exported interface (bot-aware, auto-selects mode) ──────────────────────

/**
 * Read a file from a bot's workspace.
 * @param {string} botId - Bot identifier (e.g. 'susan', 'noel')
 * @param {string} filename - File to read (e.g. 'SOUL.md', 'memory/2026-03-13.md')
 * @returns {Promise<string|null>}
 */
export async function readWorkspaceFile(botId, filename) {
  const bot = getBot(botId);
  if (!bot) return null;

  if (IS_DOCKER) {
    return fsReadWorkspaceFile(bot.dockerWorkspace, filename);
  }
  return sshReadWorkspaceFile(bot, filename);
}

/**
 * Append a memory entry to a bot's daily memory file.
 * @param {string} botId - Bot identifier
 * @param {string} date - Date string (YYYY-MM-DD)
 * @param {string} content - Markdown content to append
 */
export async function writeMemoryEntry(botId, date, content) {
  const bot = getBot(botId);
  if (!bot) throw new Error(`Unknown bot: ${botId}`);

  if (IS_DOCKER) {
    return fsWriteMemoryEntry(bot.dockerWorkspace, date, content);
  }
  return sshWriteMemoryEntry(bot, date, content);
}

/**
 * Search a bot's memory files for a topic.
 * @param {string} botId - Bot identifier
 * @param {string} query - Search query
 * @returns {Promise<string>}
 */
export async function searchMemory(botId, query) {
  const bot = getBot(botId);
  if (!bot) return 'No matching memories found.';

  if (IS_DOCKER) {
    return fsSearchMemory(bot.dockerWorkspace, query);
  }
  return sshSearchMemory(bot, query);
}
