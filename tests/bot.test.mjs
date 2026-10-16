import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { rankPosts } from '../ranking.mjs';
import { makeReport } from '../report.mjs';
import { pageAction } from '../page-reader.mjs';
const { parseHTML } = await import(process.env.LINKEDOM_MODULE ? pathToFileURL(process.env.LINKEDOM_MODULE).href : 'linkedom');
const esc = s => String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
const fixture = ({id='123', labels='10 replies, 20 reposts, 30 likes, 4 bookmarks, 400 views', controls=true, quote=true, more=false} = {}) => `<article>
  <div data-testid="User-Name">Alice</div><a href="https://x.com/alice/status/${id}"><time datetime="2026-10-16T12:00:00Z">4h</time></a>
  <div data-testid="tweetText">Outer post &lt;script&gt;sample&lt;/script&gt;</div>
  ${more ? '<button data-testid="tweet-text-show-more-link">Show more</button>' : ''}
  ${quote ? '<div><time datetime="2026-01-01T00:00:00Z">Jan 1</time><div data-testid="tweetText">Quoted text</div></div>' : ''}
  <div data-testid="tweetPhoto"><a href="https://x.com/alice/status/${id}/photo/1"><img src="https://pbs.twimg.com/media/example.jpg" alt="A chart"></a></div>
  <a href="https://example.com/source">Source</a>
  <div role="group" aria-label="${esc(labels)}">${controls ? '<button data-testid="reply"></button><button data-testid="retweet"></button><button data-testid="like"></button><a href="https://x.com/alice/status/'+id+'/analytics" aria-label="400 views. View post analytics">400</a>' : ''}</div>
</article>`;
function setup(html, href='https://x.com/home') {
  const { document, window } = parseHTML('<html><body>'+html+'</body></html>');
  globalThis.document = document; globalThis.window = window; globalThis.location = new URL(href); globalThis.innerHeight = 900;
  window.scrollTo = () => {}; window.scrollBy = () => {};
  return document;
}

test('outer identity, full count labels and quotes stay separate', async () => {
  setup(fixture());
  const { posts } = await pageAction('snapshot');
  assert.equal(posts.length,1); assert.equal(posts[0].id,'123');
  assert.equal(posts[0].text,'Outer post <script>sample</script>');
  assert.equal(posts[0].quoteTexts[0].text,'Quoted text');
  assert.deepEqual(['replies','reposts','likes','views'].map(k=>posts[0][k]),[10,20,30,400]);
  assert.equal(posts[0].createdAt,'2026-10-16T12:00:00Z');
  assert.equal(posts[0].images[0].alt,'A chart');
  assert.equal(posts[0].externalLinks[0].url,'https://example.com/source');
});
test('missing fields remain null; empty engagement controls mean zero', async () => {
  setup(fixture({labels:'400 views',controls:false}));
  let p=(await pageAction('snapshot')).posts[0];
  assert.equal(p.replies,null); assert.equal(p.views,400);
  setup(fixture({labels:'400 views'})); p=(await pageAction('snapshot')).posts[0];
  assert.equal(p.replies,0); assert.equal(p.reposts,0); assert.equal(p.likes,0);
});
test('Chinese controls, comma-separated exact counts and abbreviated estimates', async () => {
  const d=setup(fixture({labels:'',controls:true}));
  d.querySelector('[data-testid="reply"]').setAttribute('aria-label','1,234 則回覆');
  d.querySelector('[data-testid="retweet"]').setAttribute('aria-label','2.5萬 次轉發');
  d.querySelector('[data-testid="like"]').setAttribute('aria-label','3.2K 個喜歡');
  const p=(await pageAction('snapshot')).posts[0];
  assert.equal(p.replies,1234); assert.equal(p.reposts,25000); assert.equal(p.likes,3200);
  assert.equal(p.measurement.reposts.approximate,true);
});
test('rate limiting and login stop collection with a preserved message', async () => {
  setup('<div role="alert">Sorry, you are rate limited.</div>'+fixture());
  assert.match((await pageAction('snapshot')).__readerError,/頻率限制/);
  setup('', 'https://x.com/i/flow/login');
  assert.match((await pageAction('snapshot')).__readerError,/需要登入/);
});
test('detail reading expands text without activating engagement controls', async () => {
  const d=setup(fixture({more:true}), 'https://x.com/alice/status/123');
  let interactions=0;
  for(const e of d.querySelectorAll('[data-testid="like"], [data-testid="retweet"], [data-testid="reply"]')) e.addEventListener('click',()=>interactions++);
  d.querySelector('[data-testid="tweet-text-show-more-link"]').addEventListener('click',event=>{
    d.querySelector('[data-testid="tweetText"]').textContent='Expanded complete text'; event.target.remove();
  });
  const p=await pageAction('detail',{url:'https://x.com/alice/status/123'});
  assert.equal(p.text,'Expanded complete text'); assert.equal(p.detailStatus,'opened'); assert.equal(interactions,0);
});
test('ranking selects the expected top five from 20 synthetic posts without an LLM', async () => {
  const posts=JSON.parse(await readFile(new URL('./trial-input.json',import.meta.url),'utf8')).map(p=>({...p,id:p.url.match(/\/status\/(\d+)/)[1]}));
  const result=rankPosts(posts);
  assert.equal(result.ranked.length,20);
  assert.deepEqual(result.top.map(p=>p.url.split('/')[3]),['demo_01','demo_02','demo_03','demo_04','demo_05']);
});
test('fresh post smoothing, ties, duplicates and unknown metrics', () => {
  const p={id:'a',url:'https://x.com/a/status/1',createdAt:'2026-10-16T12:00:00Z',observedAt:'2026-10-16T12:00:00Z',replies:2,reposts:2,likes:2,views:2};
  const r=rankPosts([p,{...p},{...p,id:'b'},{...p,id:'c',views:null},{...p,id:'d',createdAt:'invalid'},{...p,id:'e',createdAt:'2027-01-01T00:00:00Z'}]);
  assert.equal(r.ranked.length,2); assert.equal(r.excluded.length,3);
  assert.equal(r.ranked[0].rates.likes,1); assert.equal(r.ranked[0].score,50);
  assert.throws(()=>rankPosts([p],{smoothingHours:0}));
});
test('HTML report escapes source content and refuses executable links', () => {
  const p={id:'1',author:'test',url:'https://x.com/test/status/1',text:'<script>alert(1)</script>',detailStatus:'opened',images:[],externalLinks:[{url:'javascript:alert(2)',text:'bad'}]};
  const html=makeReport({ranked:[],excluded:[],posts:[p],settings:{topCount:5,smoothingHours:2},finishedAt:'test',status:'complete'});
  assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>')); assert.ok(!html.includes('href="javascript:'));
});
test('downloaded image data is embedded only for allowed image encodings', () => {
  const image='https://pbs.twimg.com/media/chart.png';
  const post={author:'a',url:'https://x.com/a/status/1',text:'Chart',detailStatus:'opened',images:[{url:image,alt:'<chart>'}]};
  const result={ranked:[],excluded:[],posts:[post],settings:{topCount:5,smoothingHours:2},finishedAt:'test',status:'complete'};
  const html=makeReport(result,{[image]:'data:image/png;base64,aGVsbG8='});
  assert.ok(html.includes('src="data:image/png;base64,aGVsbG8="')); assert.ok(html.includes('alt="&lt;chart&gt;"'));
  assert.ok(!makeReport(result,{[image]:'data:image/svg+xml;base64,aGVsbG8='}).includes('<img'));
});
test('dashboard orchestration collects 20 unique virtualized posts and visits all details', async () => {
  const data=JSON.parse(await readFile(new URL('./trial-input.json',import.meta.url),'utf8')).map(p=>({...p,id:p.url.match(/\/status\/(\d+)/)[1],author:p.url.split('/')[3],promoted:false}));
  const d=setup(await readFile(new URL('../dashboard.html',import.meta.url),'utf8'));
  // Input defaults are explicit because this lightweight DOM does not reflect all form properties.
  for(const [id,value] of Object.entries({limit:20,top:5,interval:3,smoothing:2})) d.getElementById(id).value=String(value);
  d.getElementById('images').checked=false;
  let scroll=0, detailVisits=0, saved, removed=false;
  globalThis.chrome={
    tabs:{create:async()=>({id:7}),get:async()=>({status:'complete'}),update:async()=>({}),remove:async()=>{removed=true;}},
    storage:{local:{get:async()=>({}),set:async v=>{saved=structuredClone(v.lastResult);}}},
    scripting:{executeScript:async({args:[op,options]})=>{
      if(op==='prepareFeed') return [{result:{selected:'For you'}}];
      if(op==='scroll'){scroll++;return [{result:{scrolled:true}}];}
      if(op==='snapshot') return [{result:{posts:data.slice(scroll*3,scroll*3+5)}}];
      if(op==='detail'){detailVisits++;const p=data.find(p=>p.url===options.url);return [{result:{...p,text:'Full '+p.id,detailStatus:'opened'}}];}
      throw new Error('Unexpected operation '+op);
    }}
  };
  const originalTimeout=globalThis.setTimeout;
  globalThis.setTimeout=fn=>{queueMicrotask(fn);return 1;};
  try {
    const {start}=await import('../dashboard.js'); await start();
  } finally {globalThis.setTimeout=originalTimeout;}
  assert.equal(saved.posts.length,20); assert.equal(new Set(saved.posts.map(p=>p.id)).size,20);
  assert.equal(detailVisits,20); assert.equal(saved.status,'complete'); assert.equal(saved.top.length,5);
  assert.equal(saved.posts[0].likes,data[0].likes); assert.equal(saved.posts[0].content.detailStatus,'opened');
  assert.equal(removed,true);
});
test('an injected rate-limit stops detail collection and preserves partial results', async () => {
  const data=JSON.parse(await readFile(new URL('./trial-input.json',import.meta.url),'utf8')).map(p=>({...p,id:p.url.match(/\/status\/(\d+)/)[1],author:p.url.split('/')[3],promoted:false}));
  let detailVisits=0,saved,removed=false;
  globalThis.chrome={
    tabs:{create:async()=>({id:8}),get:async()=>({status:'complete'}),update:async()=>({}),remove:async()=>{removed=true;}},
    storage:{local:{get:async()=>({}),set:async v=>{saved=structuredClone(v.lastResult);}}},
    scripting:{executeScript:async({args:[op,options]})=>{
      if(op==='prepareFeed')return [{result:{selected:'For you'}}];
      if(op==='snapshot')return [{result:{posts:data}}];
      if(op==='detail'){
        detailVisits++;
        if(detailVisits===3)return [{result:{__readerError:'X 頻率限制，已停止'}}];
        return [{result:{...data.find(p=>p.url===options.url),detailStatus:'opened'}}];
      }
      throw new Error('Unexpected operation '+op);
    }}
  };
  const originalTimeout=globalThis.setTimeout;globalThis.setTimeout=fn=>{queueMicrotask(fn);return 1;};
  try {const {start}=await import('../dashboard.js');await start();}finally{globalThis.setTimeout=originalTimeout;}
  assert.equal(saved.posts.length,20);assert.equal(detailVisits,3);assert.equal(saved.status,'blocked-or-error');
  assert.equal(saved.posts.filter(p=>p.content).length,2);assert.match(saved.posts[2].detailError,/頻率限制/);assert.equal(removed,false);
});
