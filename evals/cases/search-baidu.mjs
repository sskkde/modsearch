// Baidu search (Baidu Qianfan ai_search web_search): force the baidu engine and
// assert the ranked-results shape (an http(s) link, and that baidu itself
// answered). Needs a BAIDU_API_KEY. When baidu is not configured here, the
// forced run errors on the missing key, which reports as SKIP. A rejected key
// is a real FAIL, and a spent free tier is BLOCKED.
export default {
  id: 'search-baidu',
  title: 'Baidu search: a forced -e baidu run returns ranked results with links',
  requirement: 'search',
  args: ['-e', 'baidu', '-q', '杭州今日天气与出行建议'],
  expectation:
    'When baidu is keyed, results[0].engine is "baidu" and at least one item has an http(s) URL. When baidu is not set up, the run reports the missing key and the case is treated as not exercised.',
  check(result, run) {
    if (run.code !== 0) {
      const stderr = run.stderr || '';
      if (/needs an API key/i.test(stderr)) {
        return { outcome: 'skip', detail: 'no BAIDU_API_KEY on this machine' };
      }
      if (/quota|额度|free tier/i.test(stderr)) {
        return { outcome: 'blocked', detail: 'baidu free tier or quota is spent' };
      }
      // A rejected key or any other error is a real failure.
      return { outcome: 'fail', detail: (stderr.split('\n')[0] || 'run failed').trim() };
    }
    const entry = result.results?.[0] ?? {};
    const items = Array.isArray(entry.items) ? entry.items : [];
    const hasLink = items.some((i) => typeof i.url === 'string' && /^https?:\/\//.test(i.url));
    return {
      pass: entry.engine === 'baidu' && hasLink,
      detail: `engine ${entry.engine}, ${items.length} items, link=${hasLink}`,
    };
  },
};
