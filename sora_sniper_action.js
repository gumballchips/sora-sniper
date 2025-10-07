// sora_sniper_action.js
// Single-run Sora invite code scanner for GitHub Actions
// Robust version: never exits with code 1, logs everything, safe seen.json handling

const fs = require('fs');
const path = require('path');
const axios = require('axios');

console.log('Starting Sora sniper single-run');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
if (!WEBHOOK_URL) {
  console.warn("DISCORD_WEBHOOK_URL not set. Exiting gracefully.");
  process.exit(0);
}

const SUBREDDITS = process.env.SUBREDDITS ? process.env.SUBREDDITS.split(',') : ['OpenAI','ChatGPT','SoraAi'];
const KEYWORDS = ['sora invite', 'sora 2 code', 'sora invite code', 'sora code', 'sora2 invite'];
const SEEN_PATH = path.join(process.cwd(), 'seen.json');
const HEADERS = { 'User-Agent': 'sora-sniper-action/1.0' };
const CODE_REGEX = /\b([A-Z0-9]{5,8})\b/gi;
const POST_DETECT_REGEX = new RegExp(KEYWORDS.map(k => k.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&')).join('|'),'i');

// -------------------- Safe seen.json handlers --------------------
function loadSeen() {
  try {
    const raw = fs.readFileSync(SEEN_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.warn('seen.json missing or invalid, starting fresh');
    return { posts: [], codes: [] };
  }
}

function saveSeen(seen) {
  try {
    fs.writeFileSync(SEEN_PATH, JSON.stringify(seen,null,2),'utf8');
  } catch (e) {
    console.warn('Failed to write seen.json:', e.message);
  }
}

// -------------------- Discord webhook sender --------------------
async function sendDiscord(content) {
  try {
    await axios.post(WEBHOOK_URL, { content }, { timeout: 15000 });
    console.log('Webhook sent:', content.slice(0,50)+'...');
  } catch (err) {
    console.warn('Failed to send webhook:', err.message);
  }
}

// -------------------- Extract invite codes --------------------
function extractCodes(text) {
  const matches = new Set();
  let m;
  while ((m = CODE_REGEX.exec(text)) !== null) {
    const token = m[1].toUpperCase();
    if (['FREE','CODE','SORA','OPENAI','INVITE'].includes(token)) continue;
    if (/^\d+$/.test(token) && token.length<5) continue;
    matches.add(token);
  }
  return Array.from(matches);
}

// -------------------- Reddit checker --------------------
async function checkReddit(seen) {
  const hits = [];
  for (const sub of SUBREDDITS) {
    const url = `https://www.reddit.com/r/${sub}/new.json?limit=40`;
    try {
      const res = await axios.get(url, { headers: HEADERS, timeout:10000 });
      const children = res.data?.data?.children;
      if (!Array.isArray(children)) {
        console.warn(`Unexpected JSON for r/${sub}`);
        continue;
      }
      for (const ch of children) {
        const p = ch.data;
        const postId = p.name || p.id;
        if (!postId || seen.posts.includes(postId)) continue;
        const full = `${p.title||''}\n\n${p.selftext||''}`;
        if (POST_DETECT_REGEX.test(full)) {
          const codes = extractCodes(full);
          const link = 'https://reddit.com' + (p.permalink||'');
          hits.push({source:'reddit',subreddit:sub,postId,title:p.title||'',link,codes});
        }
        seen.posts.push(postId);
      }
    } catch(err) {
      console.warn(`Reddit fetch failed for r/${sub}:`, err.message);
    }
  }
  return hits;
}

// -------------------- Main runner --------------------
(async () => {
  try {
    const seen = loadSeen();
    console.log(`Loaded seen: ${seen.posts.length} posts, ${seen.codes.length} codes`);
    
    const hits = await checkReddit(seen);
    let anySent = false;

    for (const h of hits) {
      const newCodes = (h.codes||[]).filter(c => !seen.codes.includes(c));
      if (newCodes.length === 0) continue;
      const content = `**New possible Sora invite code(s)** from **${h.source}**\nSource: ${h.link}\nTitle: ${h.title}\nCodes: ${newCodes.join(', ')}`;
      await sendDiscord(content);
      for (const c of newCodes) seen.codes.push(c);
      anySent = true;
    }

    saveSeen(seen);
    console.log(`Saved seen.json. Any webhook sent? ${anySent}`);
  } catch(err) {
    console.error('Fatal error caught:', err);
  } finally {
    console.log('Script finished, exiting safely with code 0');
    process.exit(0); // never exit with 1
  }
})();
