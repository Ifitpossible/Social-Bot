export const METRICS = ['replies', 'reposts', 'likes', 'views'];

// Pure computation. Missing measurements are deliberately not converted to zero.
export function rankPosts(posts, { smoothingHours = 2, topCount = 5 } = {}) {
  if (!(smoothingHours > 0) || !Number.isFinite(smoothingHours)) throw new Error('時間平滑必須大於零');
  const seen = new Set();
  const eligible = [], excluded = [];
  for (const [order, post] of posts.entries()) {
    if (!post.id || seen.has(post.id)) continue;
    seen.add(post.id);
    const created = Date.parse(post.createdAt), observed = Date.parse(post.observedAt);
    let reason = null;
    if (!Number.isFinite(created) || !Number.isFinite(observed)) reason = '缺少有效日期';
    else if (created > observed + 60000) reason = '發布日期晚於觀察時間，請檢查系統時鐘';
    else if (!METRICS.every(k => Number.isFinite(post[k]) && post[k] >= 0)) reason = '四項數字不完整';
    if (reason) { excluded.push({ ...post, excludedReason: reason }); continue; }
    const ageHours = Math.max(0, (observed - created) / 3600000);
    const rates = Object.fromEntries(METRICS.map(k => [k, post[k] / (ageHours + smoothingHours)]));
    eligible.push({ ...post, order, ageHours, rates });
  }
  for (const p of eligible) {
    p.percentiles = {};
    for (const k of METRICS) {
      const lower = eligible.filter(q => q.rates[k] < p.rates[k]).length;
      const tied = eligible.filter(q => q.rates[k] === p.rates[k]).length;
      p.percentiles[k] = eligible.length === 1 ? 100 : 100 * (lower + (tied - 1) / 2) / (eligible.length - 1);
    }
    p.score = METRICS.reduce((sum, k) => sum + p.percentiles[k], 0) / METRICS.length;
  }
  eligible.sort((a, b) => b.score - a.score || b.rates.replies - a.rates.replies || a.order - b.order);
  const ranked = eligible.map((p, i) => ({ ...p, rank: i + 1 }));
  return { ranked, top: ranked.slice(0, Math.max(0, topCount)), excluded };
}
