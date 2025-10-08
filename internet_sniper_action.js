/**
 * internet_sniper_action.js
 *
 * Single-run aggregator that:
 *  - Queries Reddit (snoowrap if OAuth provided, otherwise public JSON fallback)
 *  - Optionally runs snscrape for Twitter/X (if USE_SNSCRAPE env = 'true' and runner has snscrape)
 *  - Optionally queries Bing News Search API (if BING_API_KEY provided)
 *  - Reads any RSS feeds you list (RSS_FEEDS env)
 *  - Optionally queries Mastodon instances (MASTODON_INSTANCES env and hashtags)
 *  - Crawls (1-depth) links returned from Bing / RSS to scan page text using cheerio
 *  - Extracts candidate codes with regex (5–8 alphanumeric) and filters
 *  - Deduplicates using seen.json and posts a single embed to Discord
 *
 * Env / Secrets:
 *  - DISCORD_WEBHOOK_URL (required)
 *  - USE_SNSCRAPE = 'true' to enable snscrape block (workflow must pip install snscrape)
 *  - BING_API_KEY (optional; recommended for broad search results)
 *  - REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD (optional, recommended)
 *  - RSS_FEEDS (optional) - comma-separated URLs
 *  - MASTODON_INSTANCES (optional) - comma-separated instance hostnames
 *  - SUBREDDITS (optional) - comma-separated subreddits to include as fallback, default: OpenAI,ChatGPT,SoraAi
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const RSSParser = require('rss-parser');
const { execSync } = require('child_process');
let snoowrap = null;
try { snoowrap = require('snoowrap'); } catch (_) { /* snoowrap optional */ }
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

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; SoraSniper/1.0)' };

// pattern for candidate codes: 5-8 alphanumeric (adjust if Sora uses different format)
const CODE_REGEX = /\b([A-Z0-9]{5,8})\b/gi;
// keywords to decide if a page/post is likely about Sora invites
const KEYWORDS = ['sora invite','sora 2 code','sora invite code','sora code','sora2 invite'];
const POST_DETECT = new RegExp(KEYWORDS.map(k => k.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&')).join('|'), 'i');

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;
const MAX_CRAWL_LINKS = 20;   // max number of links to crawl from search results
const MAX_FIELDS_IN_EMBED = 12; // limit embed size

// ----------------- seen.json helpers -----------------
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

// ----------------- Discord embed helper -----------------
async function sendDiscordEmbed(title, description, fields=[]) {
  const payload = {
    embeds: [{
      title: title,
      description: description,
      color: 0x00ff99,
      fields: fields,
      timestamp: new Date().toISOString()
    }]
  };
  try {
    await axios.post(WEBHOOK_URL, payload, { timeout: 15000 });
    console.log("Embed posted:", title);
  } catch (e) {
    console.warn("Failed to post embed:", e.message);
  }
}

// ----------------- small helpers -----------------
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

// ----------------- Reddit fetch (snoowrap if OAuth creds provided) -----------------
async function fetchReddit(limitPerSub = 40) {
  const results = [];
  let rClient = null;
  if (snoowrap && REDDIT_CLIENT_ID && REDDIT_CLIENT_SECRET && REDDIT_USERNAME && REDDIT_PASSWORD) {
    try {
      rClient = new snoowrap({
        userAgent: 'sora-sniper-bot/1.0 (by script)',
        clientId: REDDIT_CLIENT_ID,
        clientSecret: REDDIT_CLIENT_SECRET,
        username: REDDIT_USERNAME,
        password: REDDIT_PASSWORD
      });
    } catch (e) { console.warn("snoowrap init failed:", e.message); rClient = null; }
  }

  for (const sub of SUBREDDITS) {
    if (rClient) {
      try {
        const posts = await rClient.getSubreddit(sub).getNew({ limit: limitPerSub });
        console.log(`Reddit(oauth) r/${sub} -> ${posts.length}`);
        posts.forEach(p => results.push({
          source: 'reddit', subreddit: sub, id: p.name || p.id, title: p.title || '', link: `https://reddit.com${p.permalink}`, text: `${p.title}\n\n${p.selftext||''}`
        }));
      } catch (e) {
        console.warn(`Reddit(oauth) r/${sub} failed:`, e.message);
      }
    } else {
      // public JSON fallback (raw_json=1 helps)
      const children = await withRetries(async () => {
        const url = `https://www.reddit.com/r/${sub}/new/.json?raw_json=1&limit=${limitPerSub}`;
        const r = await axios.get(url, { headers: HEADERS, timeout: 10000 });
        if (!r.data?.data?.children) throw new Error("no children");
        return r.data.data.children;
      }, `reddit-${sub}`);
      if (Array.isArray(children)) {
        console.log(`Reddit(public) r/${sub} -> ${children.length}`);
        children.forEach(ch => {
          const p = ch.data || {};
          results.push({ source: 'reddit', subreddit: sub, id: p.name || p.id, title: p.title||'', link: `https://reddit.com${p.permalink||''}`, text: `${p.title||''}\n\n${p.selftext||''}` });
        });
      }
    }
  }
  return results;
}

// ----------------- Twitter via snscrape (optional) -----------------
async function fetchTwitter(maxResults = 50) {
  if (!USE_SNSCRAPE) return [];
  try {
    const query = KEYWORDS.map(k => `"${k}"`).join(' OR ') + ' lang:en';
    const cmd = `snscrape --jsonl --max-results=${maxResults} twitter-search "${query}"`;
    console.log("Running snscrape...");
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
    const lines = out.split(/\r?\n/).filter(Boolean);
    const items = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const id = String(obj.id);
        const text = obj.content || '';
        items.push({ source: 'twitter', id, title: text.slice(0,80), link: `https://twitter.com/i/web/status/${id}`, text });
      } catch (e) { /* ignore */ }
      if (items.length >= maxResults) break;
    }
    console.log("snscrape returned", items.length);
    return items;
  } catch (e) {
    console.warn("snscrape failed:", e.message);
    return [];
  }
}

// ----------------- Bing News search (optional; needs API key) -----------------
async function fetchBingNews(count = 25) {
  if (!BING_API_KEY) return [];
  try {
    const query = KEYWORDS.join(' OR ');
    const url = `https://api.bing.microsoft.com/v7.0/news/search?q=${encodeURIComponent(query)}&count=${count}&mkt=en-US`;
    const res = await axios.get(url, { headers: { 'Ocp-Apim-Subscription-Key': BING_API_KEY }, timeout: 10000 });
    const items = (res.data?.value || []).map(it => ({ source: 'bing-news', id: it.url, title: it.name || '', link: it.url, text: (it.description || '') + ' ' + (it.body || '') }));
    console.log("Bing News:", items.length);
    return items;
  } catch (e) {
    console.warn("Bing News failed:", e.message);
    return [];
  }
}

// ----------------- RSS fetch -----------------
async function fetchRSS(feeds = RSS_FEEDS) {
  if (!feeds.length) return [];
  const out = [];
  for (const feed of feeds) {
    try {
      const parsed = await rssParser.parseURL(feed);
      (parsed.items || []).slice(0,30).forEach(item => {
        out.push({ source: 'rss', id: item.guid || item.link || item.pubDate || (item.title || ''), title: item.title || '', link: item.link || '', text: (item.contentSnippet || item.content || item.summary || item.description || '') });
      });
      console.log(`RSS ${feed} -> ${parsed.items?.length || 0}`);
    } catch (e) {
      console.warn("RSS fetch failed for", feed, e.message);
    }
  }
  return out;
}

// ----------------- Mastodon hashtag fetch (optional) -----------------
async function fetchMastodon(hashtags = ['sora','sora2'], instances = MASTODON_INSTANCES) {
  if (!instances.length || !hashtags.length) return [];
  const out = [];
  for (const inst of instances) {
    for (const tag of hashtags) {
      try {
        const url = `https://${inst}/api/v1/timelines/tag/${encodeURIComponent(tag)}?limit=40`;
        const res = await axios.get(url, { headers: HEADERS, timeout: 10000 });
        (res.data || []).forEach(t => {
          out.push({ source: 'mastodon', id: t.id, title: (t.account?.acct || '') + ': ' + (t.content ? t.content.replace(/<[^>]*>/g,'').slice(0,80) : ''), link: t.url || '', text: t.content ? t.content.replace(/<[^>]*>/g,'') : '' });
        });
        console.log(`Mastodon ${inst} #${tag} -> ${res.data?.length || 0}`);
      } catch (e) {
        console.warn(`Mastodon ${inst} #${tag} failed:`, e.message);
      }
    }
  }
  return out;
}

// ----------------- Simple crawler (1-depth) - fetches text from URLs -----------------
async function crawlLinks(urls = [], max = MAX_CRAWL_LINKS) {
  const results = [];
  const toCrawl = urls.slice(0, max);
  for (const u of toCrawl) {
    try {
      const r = await axios.get(u, { headers: HEADERS, timeout: 10000 });
      const $ = cheerio.load(r.data);
      const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 20000);
      results.push({ source: 'web', id: u, title: $('title').first().text() || u, link: u, text });
      console.log("Crawled", u);
    } catch (e) {
      console.warn("Crawl failed", u, e.message);
    }
  }
  return results;
}

// ----------------- Aggregation and run -----------------
(async () => {
  const seen = loadSeen();
  const aggregated = [];
  try {
    // 1) Reddit
    const redditItems = await fetchReddit(40);
    aggregated.push(...redditItems);

    // 2) Twitter via snscrape (optional)
    const twitterItems = await fetchTwitter(40);
    aggregated.push(...twitterItems);

    // 3) Bing News (optional)
    const bingItems = await fetchBingNews(25);
    aggregated.push(...bingItems);

    // 4) RSS
    const rssItems = await fetchRSS();
    aggregated.push(...rssItems);

    // 5) Mastodon
    const mastoItems = await fetchMastodon();
    aggregated.push(...mastoItems);

    // 6) Crawl links discovered in Bing/RSS items to expand coverage
    const candidateLinks = [
      ...bingItems.map(i => i.link).filter(Boolean),
      ...rssItems.map(i => i.link).filter(Boolean),
      ...aggregated.map(i => i.link).filter(Boolean)
    ];
    // dedupe links
    const uniqLinks = Array.from(new Set(candidateLinks)).slice(0, MAX_CRAWL_LINKS);
    const crawled = await crawlLinks(uniqLinks, MAX_CRAWL_LINKS);
    aggregated.push(...crawled);

    console.log("Total aggregated items:", aggregated.length);

    // Extract codes and form new entries
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
            newEntries.push({ source: item.source, id, title: item.title || '', link: item.link || '', code: c });
            seen.codes.push(c);
          }
        }
      }
      seen.posts.push(id);
    }

    // Build embed fields (cap on number)
    const fields = newEntries.slice(0, MAX_FIELDS_IN_EMBED).map(e => ({
      name: `${e.source}`,
      value: `Title: ${e.title || 'N/A'}\nCode: ${e.code}\n${e.link ? `[link](${e.link})` : ''}`
    }));

    const description = `Hello I am working ⚡ Scanned ${aggregated.length} items across sources.\nNew codes found: ${newEntries.length}`;
    await sendDiscordEmbed("Sora Sniper Status", description, fields);

  } catch (err) {
    console.error("Aggregator fatal error:", err);
    try { await sendDiscordEmbed("Sora Sniper Error", `Fatal error: ${String(err).slice(0,200)}`, []); } catch (_) {}
  } finally {
    saveSeen(seen);
    process.exit(0);
  }
})();
