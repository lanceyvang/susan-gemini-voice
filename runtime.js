const RUNNING_PREFIX = 'up ';

export function pickSusanRuntime(dockerPsOutput = '') {
  const rows = dockerPsOutput
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [name = '', status = ''] = line.split('\t');
      return { name, status: status.toLowerCase() };
    });

  const runningAlpha = rows.find(row => row.name === 'alphaclaw' && row.status.startsWith(RUNNING_PREFIX));
  if (runningAlpha) return 'alphaclaw';

  const runningSusan = rows.find(row => row.name === 'susan' && row.status.startsWith(RUNNING_PREFIX));
  if (runningSusan) return 'susan';

  if (rows.some(row => row.name === 'alphaclaw')) return 'alphaclaw';
  if (rows.some(row => row.name === 'susan')) return 'susan';

  return 'susan';
}

export function workspaceRootForContainer(container) {
  return container === 'alphaclaw'
    ? '/data/.openclaw/workspace'
    : '~/.openclaw/workspace';
}
