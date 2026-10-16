const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function link(value, label = value) {
  try { const u = new URL(value); if (!['https:', 'http:'].includes(u.protocol)) return escapeHTML(label); }
  catch { return escapeHTML(label); }
  return `<a href="${escapeHTML(value)}" target="_blank" rel="noopener noreferrer">${escapeHTML(label)}</a>`;
}
const number = value => Number.isFinite(value) ? value.toLocaleString('zh-TW') : '未知';
export function makeReport(result, imageAssets = {}) {
  const { ranked, excluded, posts, settings } = result;
  const table = ranked.map(p => `<tr><td>${p.rank}</td><td>${link(p.url, '@' + p.author)}</td><td>${p.ageHours.toFixed(2)}</td><td>${number(p.replies)}</td><td>${number(p.reposts)}</td><td>${number(p.likes)}</td><td>${number(p.views)}</td><td>${p.score.toFixed(2)}</td></tr>`).join('');
  const articles = posts.map(p => {
    const content = p.content || p;
    const status = p.detailError ? '讀取未完成：' + p.detailError : content.detailStatus === 'opened' ? '已開啟單篇並讀取可見正文' : '僅取得部分／首頁文字';
    const approximate = Object.values(p.measurement || {}).some(m => m.approximate);
    return `<article><h2>${link(p.url, '@' + p.author)}</h2><p class="muted">${escapeHTML(status)} · 發布 ${escapeHTML(p.createdAt)} · 數字觀察 ${escapeHTML(p.observedAt)}${approximate ? ' · 含縮寫估計數字' : ''}</p>
      <pre>${escapeHTML(content.text)}</pre>
      ${(content.quoteTexts || []).map(q => `<h3>引用文字（可見部分）</h3><pre>${escapeHTML(q.text)}</pre>`).join('')}
      ${(content.images || []).map(m => `${/^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(imageAssets[m.url] || '') ? `<img style="max-width:100%;max-height:800px" alt="${escapeHTML(m.alt)}" src="${imageAssets[m.url]}">` : ''}<p>圖片：${link(m.pageUrl || m.url, m.alt || '圖片連結')}${m.url ? ' · ' + link(m.url, '媒體網址') : ''}</p>`).join('')}
      ${(content.videos || []).map(v => `<p>影片：${v.url ? link(v.url, '可見影片網址') : '串流未匯出，請開啟原文觀看'}${v.poster ? ' · ' + link(v.poster, '封面') : ''}</p>`).join('')}
      ${(content.externalLinks || []).length ? '<h3>外部連結（未讀取外站全文）</h3>' + content.externalLinks.map(a => `<p>${link(a.url, a.text || a.url)}</p>`).join('') : ''}
    </article>`;
  }).join('');
  return `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>X 熱度閱讀報告</title>
    <style>body{font:16px/1.7 system-ui,sans-serif;max-width:1100px;margin:35px auto;padding:0 22px;color:#172133;background:#f4f6fa}article,section{background:white;padding:25px;border-radius:12px;margin:22px 0;overflow:auto}h1{font-size:30px}h2{font-size:22px}h3{font-size:16px}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse;white-space:nowrap;font-size:14px}td,th{text-align:left;border-bottom:1px solid #ddd;padding:9px}a{color:#1263a9;overflow-wrap:anywhere}.muted{color:#637087;font-size:13px}</style>
    <h1>X 熱度閱讀報告</h1><p>產生時間：${escapeHTML(result.finishedAt)} · 狀態：${escapeHTML(result.status)}</p>
    <p>收集 ${posts.length} 篇；可排名 ${ranked.length} 篇；排除 ${excluded.length} 篇。入選前 ${Math.min(settings.topCount, ranked.length)} 篇。</p>
    <p>各項熱度＝觀察時累計數量 ÷（發布後小時數＋${settings.smoothingHours}）。四項各自轉為本次候選中的百分位排名，再等權平均。這是平均熱度估計，不是即時增長速度，也不是內容正確性評分。排名固定使用首頁採集時的數字；單篇讀取數字另存於 JSON。</p>
    <section><h2>全部排名</h2><table><thead><tr><th>名次</th><th>作者</th><th>時齡／小時</th><th>討論</th><th>轉發</th><th>愛心</th><th>觀看</th><th>分數</th></tr></thead><tbody>${table}</tbody></table></section>
    ${excluded.length ? `<section><h2>未參與排名</h2>${excluded.map(p => `<p>${link(p.url, '@' + p.author)}：${escapeHTML(p.excludedReason)}</p>`).join('')}</section>` : ''}
    <h2>所有採集貼文正文</h2>${articles}
    <footer>只擷取登入帳號當下可見的內容。引用文字可能截斷；圖片未做 OCR；不含外部文章全文、影片逐字稿或全部留言。數字可能更新；觀看不是獨立人數。沒有呼叫 LLM，也未將資料上傳分析服務。</footer></html>`;
}
