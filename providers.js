/**
 * HTTP client for voice provider MCP servers.
 * Uses REST API endpoints (/api/models, /api/session) for simple direct access.
 */

const PROVIDERS = [
  { url: process.env.MCP_VOICE_GEMINI_URL || 'http://172.17.0.1:8768', name: 'gemini' },
  { url: process.env.MCP_VOICE_OPENAI_URL || 'http://172.17.0.1:8767', name: 'openai' },
];

// Add VibeVoice if configured
if (process.env.MCP_VOICE_VIBEVOICE_URL) {
  PROVIDERS.push({ url: process.env.MCP_VOICE_VIBEVOICE_URL, name: 'vibevoice' });
}

/**
 * List models from all configured providers. Skips unreachable providers.
 */
export async function listModels() {
  const results = await Promise.allSettled(
    PROVIDERS.map(async (p) => {
      try {
        console.log(`[providers] Fetching models from ${p.name} (${p.url})...`);
        const res = await fetch(`${p.url}/api/models`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const models = await res.json();
        return (Array.isArray(models) ? models : []).map(m => ({ ...m, providerUrl: p.url }));
      } catch (err) {
        console.warn(`[providers] ${p.name} unreachable: ${err.message}`);
        return [];
      }
    })
  );
  return results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
}

/**
 * Create a session on a specific provider.
 */
export async function createSession(providerUrl, params) {
  console.log(`[providers] Creating session on ${providerUrl}...`);
  const res = await fetch(`${providerUrl}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Provider session failed: ${res.status} ${text}`);
  }
  return res.json();
}
