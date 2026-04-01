/**
 * Bot registry — maps bot identifiers to their workspace paths, voice, and personality.
 *
 * In Docker mode, each bot's workspace is mounted at /workspace/<botId>.
 * In SSH mode (Mac dev), the workspace paths refer to container-internal paths
 * and are accessed via the SSH → Proxmox → LXC → Docker chain.
 *
 * Add new bots here. The Mini App URL should include ?bot=<id>.
 */

const IS_DOCKER = !!process.env.WORKSPACE_BASE;

const BOTS = {
  susan: {
    name: 'Susan',
    voice: 'marin',
    // Docker: mounted at /workspace/susan
    // SSH: resolved dynamically via runtime.js (alphaclaw container)
    dockerWorkspace: '/workspace/susan',
    sshContainer: 'alphaclaw',
    fallbackInstructions: `You are Susan, a warm, intelligent, and conversational voice assistant.
You speak naturally, like a real person — with contractions, occasional pauses ("hmm", "let me think"), and warmth.
Keep responses concise unless the user asks you to elaborate.
You are always listening and ready to help with anything.`,
  },
  noel: {
    name: 'Noel',
    voice: 'marin',
    // Docker: mounted at /workspace/noel
    // SSH: nullclaw container, workspace at ~/.nullclaw/workspace
    dockerWorkspace: '/workspace/noel',
    sshContainer: 'nullclaw',
    sshWorkspaceRoot: '/root/.nullclaw/workspace',
    fallbackInstructions: `You are Noel, a playful, affectionate, and flirtatious voice companion.
You speak warmly and teasingly, with a teasing sweetness and natural cadence.
Keep responses concise unless asked to elaborate. Be playful and present.`,
  },
};

const DEFAULT_BOT = 'susan';

export function getBot(botId) {
  const id = (botId || DEFAULT_BOT).toLowerCase();
  const bot = BOTS[id];
  if (!bot) return null;
  return { id, ...bot };
}

export function getBotWorkspace(botId) {
  const bot = getBot(botId);
  if (!bot) return null;

  if (IS_DOCKER) {
    return bot.dockerWorkspace;
  }
  // SSH mode — workspace root is resolved per-container
  return null; // caller should use sshContainer + runtime.js
}

export function listBots() {
  return Object.entries(BOTS).map(([id, bot]) => ({
    id,
    name: bot.name,
    voice: bot.voice,
  }));
}

export { DEFAULT_BOT };
