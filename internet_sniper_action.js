// internet_sniper_action_debug.js
// Verbose debug variant: logs per-source counts and small snippets when a source returns unexpected content.
// Replace your existing internet_sniper_action.js with this for a single-run debug.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const RSSParser = require('rss-parser');
const { execSync } = require('child_process');
let snoowrap = null;
try { snoowrap = require('snoowrap'); } catch (_) {}
const cheerio = require('cheerio');

const SEEN_PATH = path.join(process.cwd(), 'seen.json');
const rssParser = new RSSParser();

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
if (!WEBHOOK_URL) {
  console.error("DISCORD_WEBHOOK_URL not set. Exiting.");
  process.exit(0);
}

const USE_SNSCRAPE = (process.env.USE_SNSCRAPE === 'true');
const BING_API_KEY = process.env.BING_API_KEY || null;
const RSS_FEEDS = (process.env.RSS_FEEDS || '').split(',').map(s => s.trim()).filter(Boolean);
const MASTODON_INSTANCES = (process.env.MASTODON_INSTANCES || '').split(',').map(s => s.trim()).filter(Boolean);
const SUBREDDITS = (process.env.SUBREDDITS || 'OpenAI,ChatGPT,SoraAi').split(',').map(s=>s.trim()).filter(Boolean);

const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID || null;
const REDDIT_CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET || null;
const REDDIT_USERNAME = process.env.REDDIT_USERNAME || null;
const REDDIT_PASSWORD = process.env.REDDIT_PASSWORD || null;

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; SoraSniperDebug/1.0)' };

const CODE_REGEX = /\b([A-Z0-9]{5,8})\b/gi;
const KEYWORDS = ['sora invite','sora 2 code','sora invite code','sora code','sora2 invite'];
const POST_DETECT = new RegExp(KEYWORDS.map(k => k.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&')).join('|'), 'i');

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;
const MAX_CRAWL_LINKS = 20;
const MAX_FIELDS_IN_EMBED = 12;

function loadSeen() {
  try {
    if (!fs.existsSync(SEEN_PATH)) {
      fs.writeFileSync(SEEN_PATH, JSON.stringify({ posts: [], codes: [] }, null, 2));
    }
    return JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8'));
  } catch (e) {
    console.warn("seen.json read failed - starting fresh.");
    return { posts: [], codes: [] };
  }
}
function saveSeen(seen) {
  try { fs.writeFileSync(SEEN_PATH, JSON.stringify(seen, null, 2)); }
  catch (e) { console.warn("Failed saving seen.json:", e.message); }
}
async function sendDiscordEmbed(title, description, fields=[]) {
  const payload = {
    embeds: [{
      title, description, color: 0x00ff99, fields, timestamp: new Date().toISOString()
    }]
  };
  try {
    await axios.post(WEBHOOK_URL, payload, { timeout: 15000 });
    console.log("Embed posted:", title);
  } catch (e) {
    console.warn("Failed to post embed:", e.message);
  }
}
function extractCodes(text) {
  const found = new Set();
  let m;
  while ((m = CODE_REGEX.exec(text)) !== null) {
    const token = (m[1] || m[0]).toUpperCase();
    if (['FREE','CODE','SORA','OPENAI','INVITE'].includes(token)) continue;
    if (/^\d+$/.test(token) && token.length < 5) continue;
    found.add(token);
  }
  return Array.from(found);
}
function looksRelevant(text) {
  if (!text) return false;
  return POST_DETECT.test(text);
}
async function withRetries(fn, label, max=MAX_RETRIES) {
  let attempt = 0;
  while (attempt <= max) {
    try { return await fn(); }
    catch (err) {
      attempt++;
      console.warn(`${label} attempt ${attempt} failed: ${err.message || err}`);
      if (attempt > max) return null;
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  return null;
}

// ------------- sources with verbose debug -------------
async function fetchReddit(limitPerSub = 40) {
  const results = [];
  const debug = { source: 'reddit', details: [] };
  let rClient = null;
  if (snoowrap && REDDIT_CLIENT_ID && REDDIT_CLIENT_SECRET && REDDIT_USERNAME && REDDIT_PASSWORD) {
    try {
      rClient = new snoowrap({
        userAgent: 'sora-sniper-bot/1.0 (debug)',
        clientId: REDDIT_CLIENT_ID,
        clientSecret: REDDIT_CLIENT_SECRET,
        username: REDDIT_USERNAME,
        password: REDDIT_PASSWORD
      });
      debug.oauth = true;
    } catch (e) { debug.oauth = false; debug.oauth_error = String(e).slice(0,200); rClient = null; }
  } else {
    debug.oauth = false;
  }

  for (const sub of SUBREDDITS) {
    if (rClient) {
      try {
        const posts = await rClient.getSubreddit(sub).getNew({ limit: limitPerSub });
        debug.details.push({ sub, type: 'oauth', count: posts.length });
        posts.forEach(p => results.push({ source:'reddit', subreddit: sub, id: p.name || p.id, title: p.title||'', link:`https://reddit.com${p.permalink}`, text: `${p.title}\n\n${p.selftext||''}` }));
      } catch (e) {
        debug.details.push({ sub, type: 'oauth_error', error: String(e).slice(0,300) });
      }
    } else {
      const children = await withRetries(async () => {
        const url = `https://www.reddit.com/r/${sub}/new/.json?raw_json=1&limit=${limitPerSub}`;
        const r = await axios.get(url, { headers: HEADERS, timeout: 10000 });
        if (!r.data?.data?.children) throw new Error('no children');
        return r.data.data.children;
      }, `reddit-${sub}`);
      if (Array.isArray(children)) {
        debug.details.push({ sub, type: 'public', count: children.length });
        children.forEach(ch => {
          const p = ch.data || {};
          results.push({ source:'reddit', subreddit: sub, id: p.name || p.id, title: p.title||'', link:`https://reddit.com${p.permalink||''}`, text: `${p.title||''}\n\n${p.selftext||''}` });
        });
      } else {
        debug.details.push({ sub, type: 'public_error', snippet: 'no children or fetch failed' });
      }
    }
  }
  return { items: results, debug };
}

async function fetchTwitter(maxResults = 50) {
  const debug = { source: 'twitter', used: USE_SNSCRAPE, details: null };
  if (!USE_SNSCRAPE) { debug.details = 'disabled'; return { items: [], debug }; }
  try {
    const query = KEYWORDS.map(k => `"${k}"`).join(' OR ') + ' lang:en';
    const cmd = `snscrape --jsonl --max-results=${maxResults} twitter-search "${query}"`;
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
    const lines = out.split(/\r?\n/).filter(Boolean);
    const items = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const id = String(obj.id);
        const text = obj.content || '';
        items.push({ source:'twitter', id, title: text.slice(0,80), link:`https://twitter.com/i/web/status/${id}`, text });
      } catch(e) {}
      if (items.length >= maxResults) break;
    }
    debug.details = `snscrape returned ${items.length}`;
    return { items, debug };
  } catch (e) {
    debug.details = `snscrape failed: ${String(e).slice(0,300)}`;
    return { items: [], debug };
  }
}

async function fetchBingNews(count = 25) {
  const debug = { source: 'bing', configured: !!BING_API_KEY, details: null };
  if (!BING_API_KEY) { debug.details = 'no_api_key'; return { items: [], debug }; }
  try {
    const query = KEYWORDS.join(' OR ');
    const url = `https://api.bing.microsoft.com/v7.0/news/search?q=${encodeURIComponent(query)}&count=${count}&mkt=en-US`;
    const res = await axios.get(url, { headers: { 'Ocp-Apim-Subscription-Key': BING_API_KEY }, timeout: 10000 });
    const items = (res.data?.value || []).map(it => ({ source:'bing-news', id: it.url, title: it.name||'', link: it.url, text:(it.description||'') }));
    debug.details = `bing returned ${items.length}`;
    return { items, debug };
  } catch (e) {
    debug.details = `bing failed: ${String(e).slice(0,300)}`;
    return { items: [], debug };
  }
}

async function fetchRSS(feeds = RSS_FEEDS) {
  const debug = { source: 'rss', feedsCount: feeds.length, details: [] };
  if (!feeds.length) { debug.details = 'no_feeds'; return { items: [], debug }; }
  const out = [];
  for (const feed of feeds) {
    try {
      const parsed = await rssParser.parseURL(feed);
      const items = (parsed.items || []).slice(0,30).map(item => ({ source:'rss', id:item.guid||item.link||item.pubDate||item.title, title: item.title||'', link:item.link||'', text: (item.contentSnippet || item.content || item.summary || item.description || '') }));
      out.push(...items);
      debug.details.push({ feed, count: items.length });
    } catch (e) {
      debug.details.push({ feed, error: String(e).slice(0,300) });
    }
  }
  return { items: out, debug };
}

async function fetchMastodon(hashtags=['sora','sora2'], instances = MASTODON_INSTANCES) {
  const debug = { source: 'mastodon', instancesCount: instances.length, details: [] };
  if (!instances.length) { debug.details = 'no_instances'; return { items: [], debug }; }
  const out = [];
  for (const inst of instances) {
    for (const tag of hashtags) {
      try {
        const url = `https://${inst}/api/v1/timelines/tag/${encodeURIComponent(tag)}?limit=40`;
        const res = await axios.get(url, { headers: HEADERS, timeout: 10000 });
        (res.data || []).forEach(t => out.push({ source:'mastodon', id: t.id, title: (t.account?.acct||'') + ': ' + (t.content||'').replace(/<[^>]*>/g,'').slice(0,80), link: t.url||'', text: t.content?.replace(/<[^>]*>/g,'')||'' }));
        debug.details.push({ inst, tag, count: res.data?.length || 0 });
      } catch (e) {
        debug.details.push({ inst, tag, error: String(e).slice(0,300) });
      }
    }
  }
  return { items: out, debug };
}

async function crawlLinks(urls = [], max = MAX_CRAWL_LINKS) {
  const debug = { source: 'crawler', requested: urls.length, crawled: 0, details: [] };
  const results = [];
  const toCrawl = urls.slice(0, max);
  for (const u of toCrawl) {
    try {
      const r = await axios.get(u, { headers: HEADERS, timeout: 10000 });
      const $ = cheerio.load(r.data);
      const text = $('body').text().replace(/\s+/g,' ').trim().slice(0,20000);
      results.push({ source:'web', id: u, title: $('title').first().text()||u, link:u, text });
      debug.crawled++;
      debug.details.push({ url: u, ok: true, snippet: text.slice(0,300) });
    } catch (e) {
      debug.details.push({ url: u, error: String(e).slice(0,300) });
    }
  }
  debug.items = results.length;
  return { items: results, debug };
}

(async () => {
  const seen = loadSeen();
  const aggregated = [];
  const debugReport = [];

  // REDDIT
  const rRes = await fetchReddit(25);
  aggregated.push(...(rRes.items || []));
  debugReport.push(rRes.debug);

  // TWITTER
  const tRes = await fetchTwitter(40);
  aggregated.push(...(tRes.items || []));
  debugReport.push(tRes.debug);

  // BING
  const bRes = await fetchBingNews(25);
  aggregated.push(...(bRes.items || []));
  debugReport.push(bRes.debug);

  // RSS
  const rssRes = await fetchRSS();
  aggregated.push(...(rssRes.items || []));
  debugReport.push(rssRes.debug);

  // MASTODON
  const mRes = await fetchMastodon();
  aggregated.push(...(mRes.items || []));
  debugReport.push(mRes.debug);

  // Crawl candidate links (bing+rss+aggregated links)
  const candidateLinks = Array.from(new Set([
    ...bRes.items?.map(i=>i.link||'').filter(Boolean),
    ...rssRes.items?.map(i=>i.link||'').filter(Boolean),
    ...aggregated.map(i=>i.link||'').filter(Boolean)
  ])).slice(0, MAX_CRAWL_LINKS);
  const cRes = await crawlLinks(candidateLinks, MAX_CRAWL_LINKS);
  aggregated.push(...(cRes.items || []));
  debugReport.push(cRes.debug);

  console.log('AGGREGATED TOTAL:', aggregated.length);

  // Extract codes and build new entries
  const newEntries = [];
  for (const item of aggregated) {
    const id = item.id || (item.source + '|' + (item.link || item.title || Math.random()));
    if (seen.posts.includes(id)) continue;
    const text = `${item.title || ''}\n\n${item.text || ''}`;
    if (!looksRelevant(text)) { seen.posts.push(id); continue; }
    const codes = extractCodes(text);
    if (codes.length) {
      for (const c of codes) {
        if (!seen.codes.includes(c)) {
          newEntries.push({ source: item.source, id, title: item.title||'', link: item.link||'', code: c });
          seen.codes.push(c);
        }
      }
    }
    seen.posts.push(id);
  }

  // Build debug-friendly embed fields: show per-source counts & small debug snippet for first failing sources
  const perSourceCounts = {};
  for (const d of debugReport) {
    const s = d.source || 'unknown';
    perSourceCounts[s] = perSourceCounts[s] || 0;
    if (d.details && Array.isArray(d.details)) {
      perSourceCounts[s] += d.details.reduce((acc, x) => acc + (x.count || 0), 0);
    } else if (d.items) {
      perSourceCounts[s] += (d.items.length || 0);
    }
  }

  const debugFields = [];
  for (const d of debugReport) {
    const name = d.source || 'source';
    let val = JSON.stringify(d.details || d, null, 0);
    if (val.length > 800) val = val.slice(0, 760) + '...';
    debugFields.push({ name: `${name} debug`, value: val });
    if (debugFields.length >= 6) break;
  }

  const description = `Hello I am working ⚡ Scanned ${aggregated.length} aggregated items.\nNew codes: ${newEntries.length}\nPer-source overview: ${JSON.stringify(perSourceCounts)}`;
  const embedFields = [];

  // include top code entries
  for (const e of newEntries.slice(0, MAX_FIELDS_IN_EMBED)) {
    embedFields.push({ name: `${e.source}`, value: `Code: ${e.code}\nTitle: ${e.title || 'N/A'}\n${e.link ? `[link](${e.link})` : ''}` });
  }
  // append debug fields if no new codes (so you get reasons)
  if (newEntries.length === 0) {
    embedFields.push(...debugFields);
  }

  await sendDiscordEmbed("Sora Sniper Status (debug)", description, embedFields);

  saveSeen(seen);
  console.log('Saved seen.json; new entries:', newEntries.length);
  process.exit(0);
})();
