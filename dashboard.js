import { pageAction } from './page-reader.mjs';
import { rankPosts } from './ranking.mjs';
import { makeReport } from './report.mjs';

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let running = false, cancelled = false, workerTab = null, current = null;
let imageAssets = {}, imageBytes = 0;
const log = message => { $('log').textContent += `${new Date().toLocaleTimeString()} ${message}\n`; $('log').scrollTop = $('log').scrollHeight; };
const status = message => { $('status').textContent = message; log(message); };
const assertRunning = () => { if (cancelled) throw new Error('已由使用者停止'); };
const fatal = error => /頻率限制|人工驗證|需要登入|帳號驗證/.test(error.message);

async function callPage(operation, options = {}) {
  assertRunning();
  const results = await chrome.scripting.executeScript({ target: { tabId: workerTab }, func: pageAction, args: [operation, options], world: 'ISOLATED' });
  if (!results[0]?.result) throw new Error('讀取頁面未取得結果');
  if (results[0].result.__readerError) throw new Error(results[0].result.__readerError);
  return results[0].result;
}
async function pause(ms) {
  for (let elapsed = 0; elapsed < ms; elapsed += 200) { assertRunning(); await sleep(Math.min(200, ms - elapsed)); }
}
async function waitForPage() {
  for (let i = 0; i < 60; i++) {
    assertRunning();
    const tab = await chrome.tabs.get(workerTab);
    if (tab.status === 'complete') return;
    await pause(500);
  }
  throw new Error('X 分頁載入逾時');
}
async function navigate(url) { await chrome.tabs.update(workerTab, { url }); await waitForPage(); }
function settings() {
  const values = { limit: Number($('limit').value), topCount: Number($('top').value), intervalSeconds: Number($('interval').value), smoothingHours: Number($('smoothing').value), includeImages: $('images').checked };
  if (!Number.isInteger(values.limit) || values.limit < 5 || values.limit > 100) throw new Error('篇數須為 5–100 的整數');
  if (!Number.isInteger(values.topCount) || values.topCount < 1 || values.topCount > values.limit) throw new Error('入選篇數須介於 1 與收集篇數之間');
  if (!Number.isFinite(values.intervalSeconds) || values.intervalSeconds < 3 || values.intervalSeconds > 120) throw new Error('間隔須為 3–120 秒');
  if (!Number.isFinite(values.smoothingHours) || values.smoothingHours < 0.1 || values.smoothingHours > 24) throw new Error('平滑須為 0.1–24 小時');
  return values;
}
function refresh() {
  const result = rankPosts(current.posts, current.settings);
  Object.assign(current, result);
  const picked = new Set(result.top.map(p => p.id));
  $('rows').replaceChildren();
  for (const p of [...result.ranked, ...result.excluded]) {
    const tr = document.createElement('tr');
    if (picked.has(p.id)) tr.classList.add('selected');
    const cell = text => { const td = document.createElement('td'); td.textContent = text; tr.append(td); return td; };
    cell(p.rank ?? '—');
    const authorCell = cell('');
    const a = document.createElement('a'); a.href = p.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = '@' + p.author; authorCell.append(a);
    const preview = document.createElement('p'); preview.textContent = (p.content?.text || p.text || '').slice(0,110); authorCell.append(preview);
    cell(Number.isFinite(p.ageHours) ? p.ageHours.toFixed(2) + 'h' : '未知');
    for (const k of ['replies','reposts','likes','views']) cell(Number.isFinite(p[k]) ? (p.measurement?.[k]?.approximate ? '約 ' : '') + p[k].toLocaleString() : '未知');
    cell(Number.isFinite(p.score) ? p.score.toFixed(2) : p.excludedReason);
    cell(p.detailError ? '讀取未完成' : p.content?.detailStatus === 'opened' ? '已讀正文' : p.content?.detailStatus === 'partial' ? '部分內容' : '待讀取');
    $('rows').append(tr);
  }
  $('summary').textContent = `已收集 ${current.posts.length} 篇，${result.ranked.length} 篇可排名；前 ${result.top.length} 名以綠底標示。排名使用首頁採集時的數字。`;
  $('json').disabled = $('report').disabled = current.posts.length === 0;
}
async function save() {
  try { await chrome.storage.local.set({ lastResult: current }); }
  catch (error) { log('本機暫存失敗，請使用匯出按鈕保存：' + error.message); }
}
async function saveImages(content) {
  if (!current.settings.includeImages) return;
  for (const image of content.images || []) {
    assertRunning();
    if (imageAssets[image.url]) { image.captureStatus = 'embedded-this-session'; continue; }
    try {
      if (imageBytes >= 32 * 1024 * 1024) throw new Error('已達圖片總量上限');
      const u = new URL(image.url);
      if (u.protocol !== 'https:' || u.hostname !== 'pbs.twimg.com') throw new Error('僅保存 X 圖片主機的附圖');
      const response = await fetch(u.href, { credentials: 'omit', signal: AbortSignal.timeout(15000) });
      const mime = response.headers.get('content-type')?.split(';')[0];
      if (!response.ok || !['image/png','image/jpeg','image/webp','image/gif'].includes(mime)) throw new Error('圖片無法下載或格式不支援');
      const reader = response.body.getReader(), chunks = [];
      let length = 0;
      while (true) {
        assertRunning();
        const { done, value } = await reader.read(); if (done) break;
        length += value.length;
        if (length > 8 * 1024 * 1024 || imageBytes + length > 32 * 1024 * 1024) { await reader.cancel(); throw new Error('圖片超過大小上限'); }
        chunks.push(value);
      }
      const blob = new Blob(chunks, { type: mime });
      const dataUrl = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(new Error('圖片編碼失敗')); r.readAsDataURL(blob); });
      imageAssets[image.url] = dataUrl; imageBytes += length; image.captureStatus = 'embedded-this-session';
    } catch (error) { image.captureStatus = 'link-only'; image.captureError = error.message; log('附圖保留連結：' + error.message); }
  }
}
async function collect(config) {
  workerTab = (await chrome.tabs.create({ url: 'https://x.com/home', active: false })).id;
  await waitForPage();
  let prepared = false;
  for (let tries = 0; tries < 20; tries++) {
    try { await callPage('prepareFeed'); prepared = true; break; }
    catch (error) { if (fatal(error)) throw error; await pause(1000); }
  }
  if (!prepared) throw new Error('找不到推薦動態；請確認已在這個 Chrome／Edge 登入 X');
  const seen = new Set();
  let stalls = 0;
  for (let round = 0; round < config.limit * 8 + 20; round++) {
    assertRunning();
    const snapshot = await callPage('snapshot');
    const before = current.posts.length;
    for (const post of snapshot.posts) {
      if (post.promoted || seen.has(post.id) || current.posts.length >= config.limit) continue;
      seen.add(post.id); current.posts.push(post);
    }
    if (current.posts.length !== before) { status(`已收集 ${current.posts.length} / ${config.limit} 篇`); refresh(); await save(); }
    stalls = current.posts.length === before ? stalls + 1 : 0;
    if (current.posts.length >= config.limit) break;
    if (stalls >= 15) { log('持續捲動後沒有新貼文，將以現有候選繼續'); break; }
    await callPage('scroll'); await pause(1200);
  }
  // Extract every candidate, not just the five winners. Reuse a dedicated tab.
  for (const [index, post] of current.posts.entries()) {
    assertRunning();
    status(`讀取正文 ${index + 1} / ${current.posts.length}：@${post.author}`);
    try {
      await navigate(post.url);
      const detail = await callPage('detail', { url: post.url });
      if (detail.id !== post.id) throw new Error('貼文身分核對不一致');
      post.content = detail;
      await saveImages(detail);
    } catch (error) {
      post.detailError = error.message;
      log(`@${post.author}：${error.message}`);
      if (fatal(error) || cancelled) throw error;
    }
    refresh(); await save();
    if (index < current.posts.length - 1) await pause(config.intervalSeconds * 1000);
  }
}
export async function start() {
  if (running) return;
  let config;
  try { config = settings(); } catch (error) { status(error.message); return; }
  running = true; cancelled = false; workerTab = null;
  imageAssets = {}; imageBytes = 0;
  $('start').disabled = true; $('stop').disabled = false;
  for (const id of ['limit','top','interval','smoothing','images']) $(id).disabled = true;
  $('log').textContent = '';
  current = { schemaVersion: 1, startedAt: new Date().toISOString(), finishedAt: null, status: 'running', settings: config, source: 'X For you / rendered DOM', posts: [], ranked: [], top: [], excluded: [] };
  refresh();
  try {
    status('開啟專用分頁，開始讀取推薦動態');
    await collect(config);
    const complete = current.posts.filter(p => p.content?.detailStatus === 'opened').length;
    current.status = complete === config.limit ? 'complete' : 'partial';
    status(`完成：收集 ${current.posts.length} 篇，${complete} 篇已讀正文，入選 ${current.top.length} 篇。`);
  } catch (error) {
    current.status = cancelled ? 'stopped' : 'blocked-or-error';
    current.error = error.message;
    status(`${error.message}。已保留目前資料，可匯出。`);
  } finally {
    current.finishedAt = new Date().toISOString();
    refresh(); await save();
    if (workerTab != null) {
      // Leave the X tab available on failure so the user can inspect the blocker.
      if (current.status === 'complete') await chrome.tabs.remove(workerTab).catch(() => {});
    }
    workerTab = null; running = false;
    $('start').disabled = false; $('stop').disabled = true;
    for (const id of ['limit','top','interval','smoothing','images']) $(id).disabled = false;
  }
}
function download(contents, type, name) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
$('start').addEventListener('click', start);
$('stop').addEventListener('click', () => { cancelled = true; $('stop').disabled = true; status('正在停止；等待目前讀取結束後保留結果'); });
$('json').addEventListener('click', () => download(JSON.stringify(current, null, 2), 'application/json;charset=utf-8', 'x-reader-results.json'));
$('report').addEventListener('click', () => download(makeReport(current, imageAssets), 'text/html;charset=utf-8', 'x-reader-report.html'));
chrome.storage.local.get('lastResult').then(({ lastResult }) => {
  if (lastResult && !running) { current = lastResult; refresh(); log('已還原上次結果；圖片檔只保留於原執行頁的記憶體，本次還原僅包含圖片連結'); }
});
