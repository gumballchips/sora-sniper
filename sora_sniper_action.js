// internet_sniper_action.js
// Single-run internet-wide Sora invite aggregator.
// Sources: Reddit (snoowrap / fallback), Twitter via snscrape (optional), Bing News API (optional), RSS feeds, Mastodon (optional).
// Posts a single summarized Discord embed with status + new codes. Uses seen.json to dedupe.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const RSSParser = require('rss-parser');
let snoowrap = null;
try { snoowrap = require('snoowrap'); } catch(e){ /* snoowrap optional */ }
const { execSync } = require('child_process');

console.log('Starting internet-wide Sora sniper single-run');

process.on('uncaughtException', (err) => console.error('UNCAUGHT EXCEPTION:', err));
process.on('unhandledRejection', (reason, promise) => console.error('UNHANDLED REJECTION at:', promise, 'reason:', reason));

// ---------- CONFIG / ENV ----------
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
if (!WEBHOOK_URL) {
  console.warn('DISCORD_WEBHOOK_URL not set. Exiting safely.');
  process.exit(0);
}

// Sources toggles & input via env (optional)
const USE_SNSCRAPE = (process.env.USE_SNSCRAPE === 'true');
const BING_API_KEY = process.env.BING_API_KEY || null;
const RSS_FEEDS = (process.env.RSS_FEEDS || '').split(',').map(s => s.trim()).filter(Boolean);
const MASTODON_INSTANCES = (process.env.MASTODON_INSTANCES || '').split(',').map(s => s.trim()).filter(Boolean);

// Reddit OAuth envs (optional but recommended)
const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID || null;
const REDDIT_CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET || null;
const REDDIT_USERNAME = process.env.REDDIT_USERNAME || null;
const REDDIT_PASSWORD = process.env.REDDIT_PASSWORD || null;

// runtime
const SEEN_PATH = path.join(process.cwd(), 'seen.json');
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36'
};
const CODE_REGEX = /\b([A-Z0-9]{5,8})\b/gi;
const KEYWORDS = ['sora invite','sora 2 code','sora invite code','sora code','sora2 invite'];
const POST_DETECT_REGEX = new RegExp(KEYWORDS.map(k=>k.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&')).join('|'),'i');
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2500;
const rssParser = new RSSParser();

// ---------- helpers ----------
function loadSeen() {
  try { return JSON.parse(fs.readFileSync(SEEN_PATH,'utf8')); }
  catch(e){ console.warn('seen.json missing/invalid, starting fresh'); return { posts: [], codes: [] }; }
}
function saveSeen(seen) {
  try { fs.writeFileSync(SEEN_PATH, JSON.stringify(seen,null,2),'utf8'); }
  catch(e){ console.warn('Failed writing seen.json:', e.message); }
}
function extractCodes(text) {
  const matches = new Set();
  let m;
  while((m = CODE_REGEX.exec(text)) !== null) {
    const token = m[1].toUpperCase();
    if (['FREE','CODE','SORA','OPENAI','INVITE'].includes(token)) continue;
    if (/^\d+$/.test(token) && token.length < 5) continue;
    matches.add(token);
  }
  return Array.from(matches);
}
async function sendDiscordEmbed(title, description, fields=[]) {
  try {
    const payload = { embeds: [{ title, description, color: 0x00ff99, fields, timestamp: new Date().toISOString() }] };
    await axios.post(WEBHOOK_URL, payload, { timeout: 15000 });
    console.log('Embed sent:', title);
  } catch (err) {
    console.warn('Failed to send embed:', err.message);
  }
}
async function withRetries(fn, label, max=MAX_RETRIES) {
  let attempt = 0;
  while (attempt <= max) {
    try { return await fn(); }
    catch (err) {
      attempt++;
      console.warn(`${label} attempt ${attempt} failed:`, err.message || err);
      if (attempt > max) return null;
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  return null;
}

// ---------- Source: Reddit (preferred: snoowrap OAuth) ----------
async function fetchRedditItems(limitPerSub=40, subreddits=['OpenAI','ChatGPT','SoraAi']) {
  const results = [];
  let rClient = null;
  if (snoowrap && REDDIT_CLIENT_ID && REDDIT_CLIENT_SECRET && REDDIT_USERNAME && REDDIT_PASSWORD) {
    try {
      rClient = new snoowrap({
        userAgent: 'sora-sniper-bot/1.0 by script',
        clientId: REDDIT_CLIENT_ID,
        clientSecret: REDDIT_CLIENT_SECRET,
        username: REDDIT_USERNAME,
        password: REDDIT_PASSWORD
      });
    } catch(e) { console.warn('snoowrap init failed:', e.message); rClient = null; }
  }

  for (const sub of subreddits) {
    if (rClient) {
      try {
        const posts = await rClient.getSubreddit(sub).getNew({ limit: limitPerSub });
        posts.forEach(p => {
          results.push({
            source: 'reddit',
            subreddit: sub,
            id: p.name || p.id,
            title: p.title || '',
            link: `https://reddit.com${p.permalink}`,
            text: `${p.title}\n\n${p.selftext || ''}`
          });
        });
        console.log(`Reddit (oauth) r/${sub} fetched ${posts.length}`);
      } catch(e){ console.warn(`Reddit oauth r/${sub} failed:`, e.message); }
    } else {
      const children = await withRetries(async () => {
        const url = `https://www.reddit.com/r/${sub}/new/.json?raw_json=1&limit=${limitPerSub}`;
        const res = await axios.get(url, { headers: HEADERS, timeout: 10000 });
        if (!res.data?.data?.children) throw new Error('no children');
        return res.data.data.children;
      }, `reddit-${sub}`);
      if (Array.isArray(children)) {
        children.forEach(ch => {
          const p = ch.data || {};
          results.push({
            source: 'reddit',
            subreddit: sub,
            id: p.name || p.id,
            title: p.title || '',
            link: `https://reddit.com${p.permalink || ''}`,
            text: `${p.title || ''}\n\n${p.selftext || ''}`
          });
        });
      }
    }
  }
  return results;
}

// ---------- Source: Twitter/X via snscrape (optional) ----------
async function fetchTwitterSnscrape(keywords = KEYWORDS, maxResults = 50) {
  if (!USE_SNSCRAPE) return [];
  try {
    const query = keywords.map(k => `"${k}"`).join(' OR ') + ' lang:en';
    const cmd = `snscrape --jsonl --max-results=${maxResults} twitter-search "${query}"`;
    console.log('Running snscrape for twitter...');
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
    const lines = out.split(/\r?\n/).filter(Boolean);
    const hits = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const id = String(obj.id);
        const text = obj.content || '';
        hits.push({
          source: 'twitter',
          id,
          title: text.slice(0,80),
          link: `https://twitter.com/i/web/status/${id}`,
          text
        });
      } catch(e){ /* ignore parse errors */ }
      if (hits.length >= maxResults) break;
    }
    return hits;
  } catch(err) {
    console.warn('snscrape failed or not installed:', err.message);
    return [];
  }
}

// ---------- Source: Bing News search (optional) ----------
async function fetchBingNews(queryTerms = KEYWORDS, count=20) {
  if (!BING_API_KEY) return [];
  try {
    const query = queryTerms.join(' OR ');
    const url = `https://api.bing.microsoft.com/v7.0/news/search?q=${encodeURIComponent(query)}&count=${count}&mkt=en-US`;
    const res = await axios.get(url, { headers: { 'Ocp-Apim-Subscription-Key': BING_API_KEY } , timeout: 10000 });
    const items = (res.data?.value || []).map(it => ({
      source: 'bing-news',
      id: it.url,
      title: it.name || '',
      link: it.url,
      text: (it.description || '') + ' ' + (it.body || '')
    }));
    console.log('Bing News fetched', items.length);
    return items;
  } catch(err) {
    console.warn('Bing News fetch failed:', err.message);
    return [];
  }
}

// ---------- Source: RSS feeds ----------
async function fetchRSSFeeds(feeds=RSS_FEEDS) {
  if (!feeds.length) return [];
  const results = [];
  for (const feed of feeds) {
    try {
      const parsed = await rssParser.parseURL(feed);
      (parsed.items || []).slice(0,20).forEach(item => {
        results.push({
          source: 'rss',
          id: item.guid || item.link || item.id || (item.title+item.pubDate),
          title: item.title || '',
          link: item.link || '',
          text: (item.contentSnippet || item.content || item.summary || item.description || '')
        });
      });
      console.log(`RSS fetched ${parsed.items?.length || 0} from ${feed}`);
    } catch (err) {
      console.warn('RSS fetch failed for', feed, err.message);
    }
  }
  return results;
}

// ---------- Source: Mastodon (basic public search per instance) ----------
async function fetchMastodon(hashtagList = [], instances = MASTODON_INSTANCES) {
  if (!instances.length || !hashtagList.length) return [];
  const results = [];
  for (const inst of instances) {
    for (const tag of hashtagList) {
      try {
        const url = `https://${inst}/api/v1/timelines/tag/${encodeURIComponent(tag)}?limit=40`;
        const res = await axios.get(url, { headers: HEADERS, timeout:10000 });
        (res.data || []).forEach(t => {
          results.push({
            source: 'mastodon',
            id: t.id,
            title: (t.account?.display_name || t.account?.acct || t.account?.username) + ': ' + (t.content?.replace(/<[^>]*>/g,'').slice(0,80) || ''),
            link: t.url || '',
            text: t.content?.replace(/<[^>]*>/g,'') || ''
          });
        });
        console.log(`Mastodon ${inst} #${tag} fetched ${res.data?.length || 0}`);
      } catch(e) {
        console.warn(`Mastodon fetch failed for ${inst} #${tag}:`, e.message);
      }
    }
  }
  return results;
}

// ---------- Aggregation & run ----------
(async () => {
  try {
    const seen = loadSeen();
    const aggregated = [];

    // 1) Reddit
    const redditSubs = process.env.SUBREDDITS ? process.env.SUBREDDITS.split(',').map(s=>s.trim()).filter(Boolean) : ['OpenAI','ChatGPT','SoraAi'];
    const redditItems = await fetchRedditItems(40, redditSubs);
    aggregated.push(...redditItems);

    // 2) Twitter (snscrape)
    const twitterItems = await fetchTwitterSnscrape();
    aggregated.push(...twitterItems);

    // 3) Bing News
    const bingItems = await fetchBingNews();
    aggregated.push(...bingItems);

    // 4) RSS
    const rssItems = await fetchRSSFeeds(RSS_FEEDS);
    aggregated.push(...rssItems);

    // 5) Mastodon (example hashtags)
    const mastodonItems = await fetchMastodon(['sora','sora2','sora_invite'], MASTODON_INSTANCES);
    aggregated.push(...mastodonItems);

    console.log('Total aggregated items:', aggregated.length);

    // Extract codes & build new entries
    const newEntries = [];
    for (const item of aggregated) {
      const id = item.id || (item.source + '|' + (item.link || item.title || Math.random()));
      if (seen.posts.includes(id)) continue;
      const text = `${item.title || ''}\n\n${item.text || ''}`;
      if (!POST_DETECT_REGEX.test(text)) {
        seen.posts.push(id);
        continue;
      }
      const codes = extractCodes(text);
      if (codes.length) {
        codes.forEach(c => {
          if (!seen.codes.includes(c)) {
            newEntries.push({ source: item.source, id, title: item.title, link: item.link, code: c });
            seen.codes.push(c);
          }
        });
      }
      seen.posts.push(id);
    }

    // Build embed fields (limit to 10)
    const MAX_FIELDS = 10;
    const fields = newEntries.slice(0,MAX_FIELDS).map(e => ({
      name: `${e.source}`,
      value: `Title: ${e.title || 'N/A'}\nCode: ${e.code}\n${e.link ? `[link](${e.link})` : ''}`
    }));
    const description = `Hello I am working ⚡ Scanned ${aggregated.length} items across sources.\nNew codes found: ${newEntries.length}`;

    await sendDiscordEmbed('Sora Sniper Status', description, fields);

    saveSeen(seen);
    console.log(`Finished run. New codes: ${newEntries.length}`);
  } catch (err) {
    console.error('Fatal error:', err);
  } finally {
    process.exit(0);
  }
})();
