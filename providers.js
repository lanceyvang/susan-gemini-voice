/**
 * MCP client for communicating with voice provider servers via SSE transport.
 *
 * Each provider MCP server exposes:
 *   - list_models  → returns available voice models
 *   - create_session → creates a realtime session with the provider
 *
 * Protocol:
 *   1. GET /sse → SSE stream, receives `endpoint` event with POST URL
 *   2. POST to that endpoint with JSON-RPC { jsonrpc:"2.0", id, method:"tools/call", params:{name, arguments} }
 *   3. Receive result via SSE `message` event
 */

const GEMINI_URL = process.env.MCP_VOICE_GEMINI_URL || 'http://172.17.0.1:8768';
const OPENAI_URL = process.env.MCP_VOICE_OPENAI_URL || 'http://172.17.0.1:8767';

/**
 * Call an MCP tool on a provider server via SSE transport.
 * @param {string} baseUrl - Provider MCP server base URL
 * @param {string} toolName - MCP tool name
 * @param {object} args - Tool arguments
 * @param {number} timeoutMs - Timeout in ms (default 15s)
 * @returns {Promise<object>} Tool result
 */
async function callMcpTool(baseUrl, toolName, args = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Step 1: Open SSE connection to get the POST endpoint
    const sseRes = await fetch(`${baseUrl}/sse`, {
      signal: controller.signal,
      headers: { Accept: 'text/event-stream' },
    });

    if (!sseRes.ok) {
      throw new Error(`SSE connection failed: ${sseRes.status}`);
    }

    // Read the SSE stream to find the endpoint event
    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    let postEndpoint = null;
    let buffer = '';

    while (!postEndpoint) {
      const { value, done } = await reader.read();
      if (done) throw new Error('SSE stream ended before endpoint event');

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('event: endpoint')) {
          // Next data: line has the URL
          const dataIdx = lines.indexOf(line) + 1;
          if (dataIdx < lines.length && lines[dataIdx].startsWith('data: ')) {
            postEndpoint = lines[dataIdx].slice(6).trim();
          }
        }
        if (line.startsWith('data: ') && !postEndpoint && buffer === '') {
          // Some implementations send endpoint in first data line
          const candidate = line.slice(6).trim();
          if (candidate.startsWith('/') || candidate.startsWith('http')) {
            postEndpoint = candidate;
          }
        }
      }
    }

    // Resolve relative endpoint
    const postUrl = postEndpoint.startsWith('http')
      ? postEndpoint
      : `${baseUrl}${postEndpoint}`;

    // Step 2: POST JSON-RPC message
    const rpcId = Date.now();
    const postRes = await fetch(postUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: rpcId,
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      }),
      signal: controller.signal,
    });

    if (!postRes.ok) {
      const errText = await postRes.text();
      throw new Error(`MCP POST failed: ${postRes.status} ${errText}`);
    }

    // Step 3: Read SSE for result message
    let resultBuffer = '';
    let result = null;

    while (!result) {
      const { value: chunk, done: streamDone } = await reader.read();
      if (streamDone) throw new Error('SSE stream ended before result');

      resultBuffer += decoder.decode(chunk, { stream: true });
      const resultLines = resultBuffer.split('\n');
      resultBuffer = resultLines.pop() || '';

      for (const line of resultLines) {
        if (line.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(line.slice(6));
            if (parsed.id === rpcId || parsed.result || parsed.error) {
              result = parsed;
            }
          } catch {
            // Not JSON yet, keep reading
          }
        }
      }
    }

    // Clean up the reader
    reader.cancel().catch(() => {});

    if (result.error) {
      throw new Error(`MCP error: ${JSON.stringify(result.error)}`);
    }

    // Extract content from MCP tool result
    const content = result.result?.content;
    if (Array.isArray(content)) {
      const textPart = content.find(c => c.type === 'text');
      if (textPart) {
        try {
          return JSON.parse(textPart.text);
        } catch {
          return textPart.text;
        }
      }
    }

    return result.result || result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * List models from all configured provider MCP servers.
 * Gracefully skips unreachable providers.
 * @returns {Promise<Array>} Merged array of models from all providers
 */
export async function listModels() {
  const providers = [
    { url: GEMINI_URL, name: 'gemini' },
    { url: OPENAI_URL, name: 'openai' },
  ];

  const results = await Promise.allSettled(
    providers.map(async (p) => {
      try {
        console.log(`[providers] Fetching models from ${p.name} (${p.url})...`);
        const data = await callMcpTool(p.url, 'list_models', {});
        const models = Array.isArray(data) ? data : data?.models || [];
        return models.map(m => ({ ...m, provider: p.name, providerUrl: p.url }));
      } catch (err) {
        console.warn(`[providers] ${p.name} unreachable: ${err.message}`);
        return [];
      }
    })
  );

  return results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
}

/**
 * Create a realtime session on a specific provider.
 * @param {string} providerUrl - Provider MCP server URL
 * @param {object} params - Session parameters (instructions, tools, voice, etc.)
 * @returns {Promise<object>} Session config from provider
 */
export async function createSession(providerUrl, params) {
  console.log(`[providers] Creating session on ${providerUrl}...`);
  return callMcpTool(providerUrl, 'create_session', params, 30000);
}
