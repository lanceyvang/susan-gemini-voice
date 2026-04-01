import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getInstructions, invalidateCache } from './context.js';
import { readWorkspaceFile, writeMemoryEntry, searchMemory } from './ssh.js';
import { getBot, listBots, DEFAULT_BOT } from './bots.js';
import { listModels, createSession } from './providers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Prevent caching
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
app.use(express.static(join(__dirname, 'public')));
app.use(express.json());

function getBotId(req) {
  return req.query.bot || req.body?.bot || DEFAULT_BOT;
}

// ─── Tools schema (sent to providers in create_session) ────────────────────
const TOOLS = [
  {
    type: 'function',
    name: 'get_current_datetime',
    description: 'Get the current date, time, and day of week.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'search_memory',
    description: 'Search conversation memory for past discussions about a topic.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The topic or keyword to search for' },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'remember',
    description: 'Save an important note to daily memory log.',
    parameters: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'The note to save' },
      },
      required: ['note'],
    },
  },
  {
    type: 'function',
    name: 'read_workspace_file',
    description: 'Read a file from workspace. Available: SOUL.md, AGENTS.md, IDENTITY.md, USER.md, TOOLS.md.',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'The filename to read' },
      },
      required: ['filename'],
    },
  },
  {
    type: 'function',
    name: 'web_search',
    description: 'Search the web for current information.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'set_timer',
    description: 'Set a countdown timer that plays a notification sound when finished.',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'Number of seconds for the timer' },
        label: { type: 'string', description: 'What the timer is for' },
      },
      required: ['seconds'],
    },
  },
  {
    type: 'function',
    name: 'get_weather',
    description: 'Get the current weather for a location.',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City name or location' },
      },
      required: ['location'],
    },
  },
  {
    type: 'function',
    name: 'list_recent_memories',
    description: 'List recent conversation memories from the past few days.',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Number of days to look back (default 3, max 7)' },
      },
    },
  },
];

// ─── Provider endpoints ────────────────────────────────────────────────────

app.get('/models', async (req, res) => {
  try {
    const models = await listModels();
    res.json(models);
  } catch (err) {
    console.error('[models] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/session', async (req, res) => {
  const { provider, bot: botId, voice, thinking } = req.body;
  const bot = getBot(botId || DEFAULT_BOT);

  if (!bot) {
    return res.status(400).json({ error: `Unknown bot: ${botId}` });
  }

  if (!provider) {
    return res.status(400).json({ error: 'Missing provider' });
  }

  try {
    console.log(`[session] Creating ${provider} session for ${bot.name} (voice: ${voice || 'default'})`);
    const instructions = await getInstructions(bot.id);

    const providerUrl = provider === 'gemini'
      ? (process.env.MCP_VOICE_GEMINI_URL || 'http://172.17.0.1:8768')
      : (process.env.MCP_VOICE_OPENAI_URL || 'http://172.17.0.1:8767');

    const sessionParams = {
      instructions,
      tools: TOOLS,
      voice: voice || bot.voice,
      bot: bot.id,
      botName: bot.name,
    };

    if (provider === 'gemini' && thinking) {
      sessionParams.thinkingLevel = thinking;
    }

    const session = await createSession(providerUrl, sessionParams);
    session._bot = { id: bot.id, name: bot.name };
    session._provider = provider;

    res.json(session);
  } catch (err) {
    console.error(`[session] Error for ${bot.name}:`, err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Bot info ──────────────────────────────────────────────────────────────

app.get('/bots', (req, res) => {
  res.json(listBots());
});

// ─── Greeting endpoint ─────────────────────────────────────────────────────

app.get('/greeting', async (req, res) => {
  const botId = getBotId(req);
  try {
    const dates = [];
    for (let i = 0; i < 2; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }

    const entries = await Promise.all(
      dates.map(date => readWorkspaceFile(botId, `memory/${date}.md`))
    );
    const combined = entries.filter(Boolean).join('\n');

    let lastContext = '';
    if (combined) {
      const sections = combined.split(/\n(?=##|###)/).filter(Boolean);
      for (let i = sections.length - 1; i >= 0; i--) {
        const s = sections[i];
        const isGreeting = /^##?\s*Voice Call/i.test(s) && s.split('\n').length <= 4;
        if (!isGreeting && s.trim().length > 50) {
          lastContext = s.slice(-500).trim();
          break;
        }
      }
      if (!lastContext) lastContext = combined.slice(-500).trim();
    }

    let instruction;
    if (lastContext) {
      instruction = `Greet the user warmly by name — their name is Yang, and you're close friends. Based on your recent conversations, here's context from your memory:\n\n${lastContext}\n\nReference the most recent SUBSTANTIVE topic naturally. Keep it to one or two short sentences.`;
    } else {
      instruction = `Greet the user warmly by name — their name is Yang, and you're close friends. Just give a warm, casual greeting. Keep it to one sentence.`;
    }

    res.json({ instruction });
  } catch (err) {
    console.error(`[greeting] ${botId} error:`, err.message);
    res.json({ instruction: "Greet the user warmly — their name is Yang and you're close friends." });
  }
});

// ─── Tool endpoints ────────────────────────────────────────────────────────

app.post('/tools/search-memory', async (req, res) => {
  const botId = getBotId(req);
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Missing query' });
    console.log(`[tool] ${botId} search_memory: "${query}"`);
    const result = await searchMemory(botId, query);
    res.json({ result });
  } catch (err) {
    console.error(`[tool] ${botId} search_memory error:`, err);
    res.json({ result: 'Sorry, I could not search my memory right now.' });
  }
});

app.post('/tools/remember', async (req, res) => {
  const botId = getBotId(req);
  const bot = getBot(botId);
  try {
    const { note } = req.body;
    if (!note) return res.status(400).json({ error: 'Missing note' });
    const date = new Date().toISOString().slice(0, 10);
    const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    const entry = `\n### Remembered (${time}, voice call)\n- ${note}\n`;
    await writeMemoryEntry(botId, date, entry);
    invalidateCache(botId);
    console.log(`[tool] ${bot?.name || botId} remember: "${note}"`);
    res.json({ result: `Saved to memory: ${note}` });
  } catch (err) {
    console.error(`[tool] ${botId} remember error:`, err);
    res.json({ result: 'Sorry, I could not save that right now.' });
  }
});

app.post('/tools/read-workspace', async (req, res) => {
  const botId = getBotId(req);
  try {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: 'Missing filename' });
    const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '');
    console.log(`[tool] ${botId} read_workspace_file: "${safe}"`);
    const content = await readWorkspaceFile(botId, safe);
    res.json({ result: content || `File "${safe}" not found in workspace.` });
  } catch (err) {
    console.error(`[tool] ${botId} read_workspace error:`, err);
    res.json({ result: 'Could not read that file right now.' });
  }
});

app.post('/tools/web-search', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Missing query' });
    console.log(`[tool] web_search: "${query}"`);

    const tavilyKey = process.env.TAVILY_API_KEY;
    if (!tavilyKey) {
      return res.json({ result: 'Web search is not configured. Add TAVILY_API_KEY to .env file.' });
    }

    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: tavilyKey, query, max_results: 3, search_depth: 'basic' }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[tool] Tavily error:', err);
      return res.json({ result: 'Search failed. Try again later.' });
    }

    const data = await response.json();
    const results = (data.results || [])
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.content?.slice(0, 200)}`)
      .join('\n\n');
    res.json({ result: results || 'No results found.' });
  } catch (err) {
    console.error('[tool] web_search error:', err);
    res.json({ result: 'Search failed. Try again later.' });
  }
});

const WX_CODES = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Foggy', 48: 'Depositing rime fog',
  51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle',
  61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
  71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow',
  80: 'Slight rain showers', 81: 'Moderate rain showers', 82: 'Violent rain showers',
  85: 'Slight snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with slight hail', 99: 'Thunderstorm with heavy hail',
};

app.post('/tools/weather', async (req, res) => {
  try {
    const { location } = req.body;
    if (!location) return res.status(400).json({ error: 'Missing location' });
    console.log(`[tool] get_weather: "${location}"`);

    const geoRes = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en`
    );
    const geoData = await geoRes.json();
    if (!geoData.results?.length) {
      return res.json({ result: `Could not find location "${location}".` });
    }

    const { latitude, longitude, name, country } = geoData.results[0];
    const wxRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
      `&current=temperature_2m,apparent_temperature,weathercode,windspeed_10m,relative_humidity_2m` +
      `&temperature_unit=fahrenheit&windspeed_unit=mph`
    );
    const wxData = await wxRes.json();
    const c = wxData.current;

    res.json({
      result: JSON.stringify({
        location: `${name}, ${country}`,
        temperature: `${Math.round(c.temperature_2m)}F`,
        feelsLike: `${Math.round(c.apparent_temperature)}F`,
        condition: WX_CODES[c.weathercode] || 'Unknown',
        humidity: `${c.relative_humidity_2m}%`,
        wind: `${Math.round(c.windspeed_10m)} mph`,
      }),
    });
  } catch (err) {
    console.error('[tool] weather error:', err);
    res.json({ result: 'Could not fetch weather right now.' });
  }
});

app.post('/tools/recent-memories', async (req, res) => {
  const botId = getBotId(req);
  try {
    let { days } = req.body;
    days = Math.min(Math.max(days || 3, 1), 7);
    console.log(`[tool] ${botId} list_recent_memories: ${days} days`);

    const dates = [];
    for (let i = 0; i < days; i++) {
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

    res.json({ result: combined || 'No recent memories found.' });
  } catch (err) {
    console.error(`[tool] ${botId} recent_memories error:`, err);
    res.json({ result: 'Could not retrieve recent memories.' });
  }
});

app.post('/tools/transcript', async (req, res) => {
  const botId = getBotId(req);
  const bot = getBot(botId);
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'No messages provided' });
    }

    const date = new Date().toISOString().slice(0, 10);
    const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

    const lines = messages
      .map(m => `- **${m.role === 'user' ? 'Yang' : (bot?.name || 'Assistant')}**: ${m.text}`)
      .join('\n');

    const entry = `\n## Voice Call (${time})\n${lines}\n`;
    await writeMemoryEntry(botId, date, entry);
    console.log(`[transcript] ${bot?.name || botId}: saved ${messages.length} messages`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[transcript] ${botId} save error:`, err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/tools/get-current-datetime', (req, res) => {
  const now = new Date();
  res.json({
    result: JSON.stringify({
      date: now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
      time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
  });
});

app.post('/tools/set-timer', (req, res) => {
  const { seconds, label } = req.body;
  const secs = seconds || 60;
  res.json({ result: `Timer set for ${secs} seconds: ${label || 'Timer'}` });
});

app.post('/tools/list-recent-messages', (req, res) => {
  // Placeholder — transcript is managed client-side
  res.json({ result: 'Recent messages are available in the transcript panel.' });
});

// ─── Start server ──────────────────────────────────────────────────────────

app.listen(PORT, () => {
  const bots = listBots().map(b => b.id).join(', ');
  console.log(`Voice server ready -> http://localhost:${PORT}`);
  console.log(`Available bots: ${bots}`);
});
