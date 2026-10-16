// Self-contained function, injected by chrome.scripting into the isolated world.
// Reads the rendered DOM only. No private endpoints, page state, cookies or tokens.
export async function pageAction(operation, options = {}) {
  try {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const canonical = value => {
    try {
      const u = new URL(value, location.href);
      const m = u.pathname.match(/^\/([A-Za-z0-9_]+)\/status\/(\d+)(?:\/|$)/);
      return u.hostname === 'x.com' && m ? { id: m[2], author: m[1], url: `https://x.com/${m[1]}/status/${m[2]}` } : null;
    } catch { return null; }
  };
  const countValue = text => {
    if (text == null || text.trim() === '') return { value: null, approximate: false };
    const match = text.replace(/[,，\s\u00a0]/g, '').match(/^(\d+(?:\.\d+)?)(K|M|B|千|萬|万|億|亿)?$/i);
    if (!match) return { value: null, approximate: false };
    const factor = { K: 1e3, M: 1e6, B: 1e9, 千: 1e3, 萬: 1e4, 万: 1e4, 億: 1e8, 亿: 1e8 }[match[2]?.toUpperCase()] || 1;
    return { value: Math.round(Number(match[1]) * factor), approximate: factor !== 1 };
  };
  const blocked = () => {
    const alerts = [...document.querySelectorAll('[role="alert"], [data-testid="toast"]')].map(e => e.innerText).join(' ');
    if (/rate.?limit|too many requests|操作.*頻繁|頻率限制|超出.*限制|請求過多/i.test(alerts)) return 'X 頻率限制，已停止';
    if (/\/i\/flow\/(?:login|signup)|\/account\/access/.test(location.pathname)) return '需要登入或帳號驗證，請自行在 X 完成';
    if (document.querySelector('iframe[src*="captcha"], iframe[src*="arkoselabs"]')) return '需要人工驗證，已停止';
    if (!document.querySelector('article') && /Something went wrong|發生錯誤|出了點問題/i.test(document.body.innerText)) return 'X 頁面載入失敗';
    return null;
  };
  const check = () => { const error = blocked(); if (error) throw new Error(error); };
  const metric = (article, key, word, control) => {
    const labels = [...article.querySelectorAll('[role="group"][aria-label]')].map(e => e.getAttribute('aria-label'));
    for (const label of labels) {
      const m = label.match(new RegExp(`([0-9][0-9,.，]*(?:\\s*[KMB千萬万億亿])?)\\s+${word}`, 'i'));
      if (m) return { ...countValue(m[1]), source: 'group-label' };
    }
    const element = article.querySelector(control);
    if (!element) return { value: null, approximate: false, source: 'missing' };
    const label = element.getAttribute('aria-label') || '';
    const m = label.match(/([0-9][0-9,.，]*(?:\s*[KMB千萬万億亿])?)/i);
    if (m) return { ...countValue(m[1]), source: 'control-label' };
    const text = element.innerText?.trim();
    if (text) return { ...countValue(text), source: 'control-text' };
    // Empty engagement buttons on X represent zero; missing elements stay unknown.
    if (key !== 'views') return { value: 0, approximate: false, source: 'empty-control' };
    return { value: null, approximate: false, source: 'missing' };
  };
  const extract = article => {
    // The first timestamp belongs to the outer post, not its quoted post.
    const time = article.querySelector('time');
    const identity = canonical(time?.closest('a')?.href);
    if (!identity) return null;
    const tweetTexts = [...article.querySelectorAll('[data-testid="tweetText"]')];
    const user = article.querySelector('[data-testid="User-Name"]');
    const metrics = {
      replies: metric(article, 'replies', 'repl(?:y|ies)', '[data-testid="reply"]'),
      reposts: metric(article, 'reposts', 'reposts?', '[data-testid="retweet"], [data-testid="unretweet"]'),
      likes: metric(article, 'likes', 'likes?', '[data-testid="like"], [data-testid="unlike"]'),
      views: metric(article, 'views', 'views?', 'a[href$="/analytics"]')
    };
    const images = [...article.querySelectorAll('[data-testid="tweetPhoto"] img')].map(img => ({
      url: img.currentSrc || img.src || null, alt: img.alt || '', pageUrl: img.closest('a')?.href || null
    }));
    const videos = [...article.querySelectorAll('video')].map(video => ({
      poster: video.poster || null, url: /^(https?):/.test(video.currentSrc || video.src) ? video.currentSrc || video.src : null,
      status: /^(https?):/.test(video.currentSrc || video.src) ? 'visible-direct-url' : 'stream-not-exported'
    }));
    if (!videos.length && article.querySelector('[data-testid="videoPlayer"]')) videos.push({ poster: null, url: null, status: 'stream-not-exported' });
    const quoted = tweetTexts.slice(1).map(el => ({ text: el.innerText, status: 'visible-excerpt-only' }));
    const links = [...article.querySelectorAll('a[href]')].map(a => ({ text: a.innerText || a.getAttribute('aria-label') || '', url: a.href }))
      .filter(a => { try { const host = new URL(a.url).hostname; return !['x.com', 'twitter.com', 'pbs.twimg.com'].includes(host); } catch { return false; } });
    const showMore = article.querySelector('[data-testid="tweet-text-show-more-link"]') ||
      [...article.querySelectorAll('button, [role="button"]')].find(e => /^(Show more|顯示更多|显示更多|もっと見る)$/i.test(e.innerText?.trim()));
    const promoted = [...article.querySelectorAll('span')].some(e => /^(Ad|Promoted|廣告|广告|推薦廣告)$/.test(e.innerText?.trim())) || !!article.querySelector('[data-testid="placementTracking"] > [data-testid="promotedIndicator"]');
    return {
      ...identity, authorName: user?.innerText?.split('\n')[0] || identity.author,
      createdAt: time.getAttribute('datetime'), observedAt: new Date().toISOString(),
      text: tweetTexts[0]?.innerText ?? '', quoteTexts: quoted, images, videos,
      externalLinks: [...new Map(links.map(a => [a.url, a])).values()],
      ...Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, v.value])),
      measurement: metrics, promoted, visibleExcerpt: article.innerText,
      contentStatus: showMore ? 'truncated' : tweetTexts.length ? 'visible-text' : 'media-or-no-text',
      detailStatus: 'not-opened'
    };
  };
  check();
  if (operation === 'prepareFeed') {
    const forYou = [...document.querySelectorAll('[role="tab"]')].find(e => /^(For you|為你推薦|为你推荐|おすすめ)$/i.test(e.innerText.trim()));
    if (!forYou) throw new Error('找不到「為你推薦」分頁，請確認已登入 X，並使用繁中、簡中、英文或日文介面');
    if (forYou.getAttribute('aria-selected') !== 'true') { forYou.click(); await wait(1500); check(); }
    window.scrollTo(0, 0);
    return { selected: forYou.innerText };
  }
  if (operation === 'scroll') { window.scrollBy(0, Math.max(400, Math.round(innerHeight * 0.8))); return { scrolled: true }; }
  if (operation === 'snapshot') {
    return { url: location.href, posts: [...document.querySelectorAll('article')].map(extract).filter(Boolean) };
  }
  if (operation === 'detail') {
    const target = canonical(options.url);
    if (!target) throw new Error('無效貼文網址');
    const find = () => [...document.querySelectorAll('article')].find(a => canonical(a.querySelector('time')?.closest('a')?.href)?.id === target.id);
    let article;
    for (let i = 0; i < 40; i++) { check(); article = find(); if (article) break; await wait(500); }
    if (!article) throw new Error('無法載入這篇貼文，可能已刪除、受限或暫時不可用');
    // Only expand the outer post. Never click follow, like, repost, or reply controls.
    for (let i = 0; i < 3; i++) {
      const current = extract(article);
      if (current.contentStatus !== 'truncated') break;
      const more = article.querySelector('[data-testid="tweet-text-show-more-link"]') ||
        [...article.querySelectorAll('button, [role="button"]')].find(e => /^(Show more|顯示更多|显示更多|もっと見る)$/i.test(e.innerText?.trim()));
      if (!more) break;
      more.click(); await wait(800); check(); article = find();
      if (!article) throw new Error('展開後找不到原貼文');
    }
    const result = extract(article);
    // Report fidelity, not an unverified guarantee of completeness.
    result.detailStatus = result.contentStatus === 'truncated' ? 'partial' : 'opened';
    return result;
  }
  if (operation === 'check') return { url: location.href, articles: document.querySelectorAll('article').length };
  throw new Error('未知操作');
  } catch (error) {
    // Injection errors can otherwise lose their original message across Chrome's boundary.
    return { __readerError: error.message || String(error) };
  }
}
