const fs = require('fs');
const path = require('path');
const axios = require('axios');

console.log('Starting Sora sniper single-run');

// -------------------- Catch all uncaught errors --------------------
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION at:', promise, 'reason:', reason);
});

// -------------------- Config --------------------
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

// -------------------- Discord webhook embed sender --------------------
async function sendDiscordEmbed(title, description, fields=[]) {
  try {
    const payload = {
      embeds: [
        {
          title,
          description,
          color: 0x00ff99, // greenish alpha color
          fields,
          timestamp: new Date().toISOString(),
        },
      ],
    };
    await axios.post(WEBHOOK_URL, payload, { timeout: 15000 });
    console.log('Embed sent:', title);
  } catch (err) {
    console.warn('Failed to send embed:', err.message);
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
  let totalPostsChecked = 0;
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
      totalPostsChecked += children.length;
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
  return { hits, totalPostsChecked };
}

// -------------------- Main runner --------------------
(async () => {
  try {
    const seen = loadSeen();

    // 🔥 Run Reddit check
    const { hits, totalPostsChecked } = await checkReddit(seen);

    // 🔥 Send a “working” embed with post count
    await sendDiscordEmbed(
      "Sora Sniper Status",
      `Hello I am working ⚡ Skibidi, veiny ahh dih, alpha rizz active!\nTotal posts checked: ${totalPostsChecked}`,
      []
    );

    console.log(`Loaded seen: ${seen.posts.length} posts, ${seen.codes.length} codes`);

    let anySent = false;

    for (const h of hits) {
      const newCodes = (h.codes||[]).filter(c => !seen.codes.includes(c));
      if (newCodes.length === 0) continue;
      const fields = [
        { name: "Subreddit", value: h.subreddit, inline: true },
        { name: "Post Title", value: h.title || "N/A", inline: true },
        { name: "Codes", value: newCodes.join(', ') }
      ];
      await sendDiscordEmbed("New Sora Code Detected!", `Source: ${h.link}`, fields);
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

