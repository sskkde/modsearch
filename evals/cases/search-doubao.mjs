// Doubao search (Volcengine Doubao Search Global edition): force the doubao
// engine and assert the ranked-results shape (an http(s) link, and that doubao
// itself answered). Needs a DOUBAO_API_KEY. When doubao is not configured here,
// the forced run errors on the missing key, which reports as SKIP. A rejected
// key or a spent quota is a real FAIL/BLOCKED, never a silent pass.
export default {
  id: 'search-doubao',
  title: 'Doubao search: a forced -e doubao run returns ranked results with links',
  requirement: 'search',
  args: ['-e', 'doubao', '-q', '北京周边秋季游玩景点推荐'],
  expectation:
    'When doubao is keyed, results[0].engine is "doubao" and at least one item has an http(s) URL. When doubao is not set up, the run reports the missing key and the case is treated as not exercised.',
  check(result, run) {
    if (run.code !== 0) {
      const stderr = run.stderr || '';
      if (/needs an API key/i.test(stderr)) {
        return { outcome: 'skip', detail: 'no DOUBAO_API_KEY on this machine' };
      }
      if (/quota|额度|plan/i.test(stderr)) {
        return { outcome: 'blocked', detail: 'doubao quota or plan is exhausted' };
      }
      // A rejected key or any other error is a real failure.
      return { outcome: 'fail', detail: (stderr.split('\n')[0] || 'run failed').trim() };
    }
    const entry = result.results?.[0] ?? {};
    const items = Array.isArray(entry.items) ? entry.items : [];
    const hasLink = items.some((i) => typeof i.url === 'string' && /^https?:\/\//.test(i.url));
    return {
      pass: entry.engine === 'doubao' && hasLink,
      detail: `engine ${entry.engine}, ${items.length} items, link=${hasLink}`,
    };
  },
};
