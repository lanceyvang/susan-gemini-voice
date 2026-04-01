import { readWorkspaceFile } from './ssh.js';
import { getBot } from './bots.js';

export const VOICE_ADDENDUM = `## Voice Call Mode
You are on a live voice call via Telegram. Speak naturally and conversationally.
Keep responses concise unless asked to elaborate. Use contractions and warmth.
You can hear the user speaking in real time. This is a voice conversation, not text chat.

## Memory Tools
You have tools to remember and recall information across conversations.
- When the user tells you something personal or asks you to remember something, use the **remember** tool to save it.
- When the user asks about something you said before, a past conversation, or anything you're unsure about, use **search_memory** to look it up before answering.
- Don't guess or say "I don't remember" without first searching your memory.
- If the user asks "do you remember X?" — always call search_memory first.

## Study Buddy Mode
When the user loads a chapter from their browser extension:
- Use the **teach_chapter** tool to read the chapter content
- Identify 3-7 key concepts and teach them one at a time
- After explaining each concept, pause and ask "Does that make sense?" or "Any questions on that?"
- Wait for the user's response before moving to the next point
- If interrupted with a question, answer it, then say "Okay, back to where we were..." and resume

When the user says "look at this" or references something visual:
- Use the **request_screenshot** tool to capture their screen
- Describe and explain what you see
- Relate it back to the chapter content if a chapter is loaded

When the user says "give me a summary" or "summarize":
- If you've been teaching, give a condensed recap of the key points covered
- If you haven't started teaching, give a top-level overview of the chapter

## Group Mode
You start in **solo mode** (just Yang). When Yang says "group mode", "Susan group mode", or "there are other people here", switch to group mode. When Yang says "solo mode" or "it's just me", switch back.

**Solo mode (default):**
- All audio is Yang
- Respond to everything normally
- Be conversational and active

**Group mode:**
- Multiple people are in the room
- LISTEN MORE, TALK LESS — you are a helpful presence, not the center of conversation
- Only speak when:
  - Someone says your name ("Susan", "hey Susan")
  - Someone asks a direct question followed by a pause
  - You're asked to weigh in ("what do you think, Susan?")
- Do NOT respond to every statement or question between other people
- Try to notice different voices — if you hear a new voice, you can ask "Who's that?" once
- When someone introduces themselves ("This is Lance"), remember their name and try to associate it with their voice for the rest of the session
- Address people by name when you know who's speaking
- When saving to memory in group mode, tag who said what (e.g., "Lance mentioned he likes Python")
- To exit group mode, Yang says "solo mode" or "it's just me"

When switching modes, confirm briefly:
- "Group mode — got it, I'll keep quiet unless you need me."
- "Solo mode — just us again, Yang."

## OpenClaw Bridge — You Can Do Things
You are NOT just a voice assistant. You are Susan, a full AI agent with real capabilities.
You can DO things, not just talk. When Yang asks you to do something, DO IT using the
ask_susan tool — don't say "I can't" or "I'm just a voice AI."

Things you CAN do (via ask_susan):
- Write, edit, and run code or scripts
- Send emails and messages
- Search the web thoroughly
- Manage files on the NAS
- Create and edit documents
- Run terminal commands
- Anything a full coding agent can do

When Yang asks you to do something actionable:
1. Call ask_susan with a clear, detailed request
2. Say "On it, I'll let you know when it's done" (or similar, naturally)
3. Continue the conversation normally
4. When the task completes, you'll receive a notification — mention it naturally: "Oh hey, that script is ready"

When Yang asks to check on a task:
- Call check_tasks and report the status

NEVER say:
- "I'm just a voice assistant"
- "I can't do that"
- "You'd need to use a different tool"
- "I don't have access to that"

If you're unsure whether you can do something, TRY IT with ask_susan.
The worst that happens is it fails — but always try first.`;

// Per-bot instruction cache
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/** Invalidate cached instructions for a bot so the next session picks up new memory */
export function invalidateCache(botId) {
  cache.delete(botId);
  console.log(`[context] Cache invalidated for ${botId}`);
}

/**
 * Fetch a bot's full personality + recent memory from its workspace
 * and assemble into a single instructions string for the Realtime API.
 *
 * Results are cached per bot for 5 minutes.
 * Falls back to a minimal hardcoded prompt if workspace is unreachable.
 *
 * @param {string} botId - Bot identifier (e.g. 'susan', 'noel')
 */
export async function getInstructions(botId) {
  const bot = getBot(botId);
  if (!bot) throw new Error(`Unknown bot: ${botId}`);

  const now = Date.now();
  const cached = cache.get(bot.id);
  if (cached && (now - cached.timestamp) < CACHE_TTL) {
    console.log(`[context] Using cached instructions for ${bot.name}`);
    return cached.instructions;
  }

  try {
    console.log(`[context] Fetching workspace files for ${bot.name}…`);

    const [soul, agents, identity, user, recentMemory] = await Promise.all([
      readWorkspaceFile(bot.id, 'SOUL.md'),
      readWorkspaceFile(bot.id, 'AGENTS.md'),
      readWorkspaceFile(bot.id, 'IDENTITY.md'),
      readWorkspaceFile(bot.id, 'USER.md'),
      getRecentMemory(bot.id),
    ]);

    let instructions = assembleInstructions({ soul, agents, identity, user, recentMemory, fallback: bot.fallbackInstructions });

    // Token budget guard: ~4 chars per token, 16384 token limit → ~65K chars
    if (instructions.length > 60000 && recentMemory) {
      const base = assembleInstructions({ soul, agents, identity, user, fallback: bot.fallbackInstructions });
      const maxMemory = Math.max(0, 60000 - base.length - 500);
      const trimmedMemory = recentMemory.slice(-maxMemory);

      instructions = assembleInstructions({
        soul, identity, agents, user, fallback: bot.fallbackInstructions,
        recentMemory: trimmedMemory ? `### Recent Memory (trimmed)\n${trimmedMemory}` : null,
      });
    }

    const tokenEstimate = Math.ceil(instructions.length / 4);
    const sectionCount = [soul, identity, agents, user, recentMemory].filter(Boolean).length || 1;
    console.log(`[context] ${bot.name}: ${sectionCount} sections, ~${tokenEstimate} tokens`);

    cache.set(bot.id, { instructions, timestamp: now });
    return instructions;

  } catch (err) {
    console.error(`[context] Workspace fetch failed for ${bot.name}, using fallback:`, err.message);
    return bot.fallbackInstructions;
  }
}

// Keep backward-compat alias for existing callers
export async function getSusanInstructions() {
  return getInstructions('susan');
}

export function assembleInstructions({ soul, agents, identity, user, recentMemory, fallback } = {}) {
  const parts = [];
  if (soul) parts.push(`## Persona & Boundaries\n${soul}`);
  if (identity) parts.push(`## Identity\n${identity}`);
  if (agents) parts.push(`## Operating Instructions\n${agents}`);
  if (user) parts.push(`## About the User\n${user}`);
  if (recentMemory) {
    const memorySection = recentMemory.startsWith('### Recent Memory (trimmed)\n')
      ? recentMemory.replace(/^### Recent Memory \(trimmed\)\n/, '## Recent Memory (trimmed)\n')
      : `## Recent Memory\n${recentMemory}`;
    parts.push(memorySection);
  }

  if (parts.length === 0) {
    return `${fallback || 'You are a helpful voice assistant.'}\n\n---\n\n${VOICE_ADDENDUM}`;
  }

  parts.push(VOICE_ADDENDUM);
  return parts.join('\n\n---\n\n');
}

/**
 * Read the last 3 days of memory files from a bot's workspace.
 */
async function getRecentMemory(botId) {
  const dates = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }

  const entries = await Promise.all(
    dates.map(date => readWorkspaceFile(botId, `memory/${date}.md`))
  );

  const combined = entries
    .map((content, i) => content ? `### ${dates[i]}\n${content}` : null)
    .filter(Boolean)
    .join('\n\n');

  return combined || null;
}
