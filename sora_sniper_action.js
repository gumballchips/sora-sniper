// sora_sniper_action.js
// Single-run Sora invite code scanner for GitHub Actions.
// - Reads seen.json (if present) to avoid duplicates.
// - Checks Reddit new posts in configured subreddits.
// - Posts new candidate codes to the Discord webhook in env var DISCORD_WEBHOOK_URL.
// - Writes updated seen.json (workflow will commit it back).

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
if (!WEBHOOK_URL) {
  console.error("ERROR: Set DISCORD_WEBHOOK_URL in the environment (workflow secret).");
  process.exit(1);
}

const SUBREDDITS = process.env.SUBREDDITS ? process.env.SUBREDDITS.split(',') : ['OpenAI', 'ChatGPT', 'SoraAi'];
const KEYWORDS = ['sora invite', 'sora 2 code', 'sora invite code', 'sora code', 'sora2 invite'];
const SEEN_PATH = path.join(process.cwd(), 'seen.json');

const HEADERS = { 'User-Agent': 'sora-sniper-action/1.0' };
const CODE_REGEX = /\b([A-Z0-9]{5,8})\b/gi;
const POST_DETECT_REGEX = new RegExp(KEYWORDS.map(k => k.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&')).join('|'), 'i');

function loadSeen() {
  try {
    const raw = fs.readFileSync(SEEN_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { posts: [], codes: [] };
  }
}

function saveSeen(seen) {
  fs.writeFileSync(SEEN_PATH, JSON.stringify(seen, null, 2), 'utf8');
}

async function sendDiscord(content) {
  try {
    await axios.post(WEBHOOK_URL, { content }, { timeout: 15000 });
    console.log('Webhook sent.');
  } catch (err) {
    console.warn('Failed to send webhook:', err.message);
  }
}

function extractCodes(text) {
  const matches = new Set();
  let m;
  while ((m = CODE_REGEX.exec(text)) !== null) {
    const token = m[1].toUpperCase();
    if (['FREE','CODE','SORA','OPENAI','INVITE'].includes(token)) continue;
    if (/^\d+$/.test(token) && token.length < 5) continue;
    matches.add(token);
  }
  return Array.from(matches);
}

async function checkReddit(seen) {
  const hits = [];
  for (const sub of SUBREDDITS) {
    const url = `https://www.reddit.com/r/${sub}/new.json?limit=40`;
    try {
      const res = await axios.get(url, { headers: HEADERS, timeout: 10000 });
      const children = res.data?.data?.children || [];
      for (const ch of children) {
        const p = ch.data;
        const postId = p.name || p.id;
        if (!postId || seen.posts.includes(postId)) continue;
        const title = p.title || '';
        const selftext = p.selftext || '';
        const full = `${title}\n\n${selftext}`;
        if (POST_DETECT_REGEX.test(full)) {
          const codes = extractCodes(full);
          const link = 'https://reddit.com' + (p.permalink || '');
          hits.push({ source: 'reddit', subreddit: sub, postId, title, link, codes });
        }
        seen.posts.push(postId);
      }
    } catch (err) {
      console.warn(`Reddit check failed for r/${sub}: ${err.message}`);
    }
  }
  return hits;
}

(async () => {
  try {
    const seen = loadSeen();
    console.log('Loaded seen:', seen.posts.length, 'posts,', seen.codes.length, 'codes');

    const hits = await checkReddit(seen);

    let anySent = false;
    for (const h of hits) {
      const newCodes = (h.codes || []).filter(c => !seen.codes.includes(c));
      if (newCodes.length === 0) continue;
      const content = `**New possible Sora invite code(s)** from **${h.source}**\nSource: ${h.link}\nTitle: ${h.title}\nCodes: ${newCodes.join(', ')}`;
      await sendDiscord(content);
      for (const c of newCodes) seen.codes.push(c);
      anySent = true;
    }

    saveSeen(seen);
    console.log('Saved seen.json. AnySent=', anySent);
    process.exit(0);
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(2);
  }
})();
