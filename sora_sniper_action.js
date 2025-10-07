const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ---------------- CONFIG ----------------
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "YOUR_WEBHOOK_URL_HERE"; // replace or set as secret
const SEEN_FILE = path.join(__dirname, 'seen.json');

// keywords to detect Sora invites
const KEYWORDS = ['sora invite', 'sora 2 code', 'sora invite code', 'sora code', 'sora2 invite'];

// ---------------- HELPERS ----------------
function loadSeen() {
  try {
    return JSON.parse(fs.readFileSync(SEEN_FILE));
  } catch (e) {
    return { posts: [], codes: [] };
  }
}

function saveSeen(seen) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
}

async function sendDiscord(message) {
  try {
    await axios.post(WEBHOOK_URL, { content: message });
  } catch (err) {
    console.warn('Discord webhook failed:', err.message);
  }
}

function extractCodes(text) {
  // find all alphanumeric sequences 5-8 chars long
  const regex = /\b[A-Z0-9]{5,8}\b/gi;
  const codes = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    const token = match[0].toUpperCase();
    if (!['FREE','CODE','SORA','INVITE'].includes(token)) codes.push(token);
  }
  return codes;
}

// ---------------- SCRAPER ----------------
async function scrapeExample() {
  // Example: simple Reddit JSON scraping
  const urls = [
    'https://www.reddit.com/r/SoraAi/new.json?limit=10',
    'https://www.reddit.com/r/OpenAI/new.json?limit=10'
  ];

  const seen = loadSeen();
  let newPosts = 0;

  await sendDiscord("🟢 Hello I am working — scanning for Sora invite codes...");

  for (const url of urls) {
    try {
      const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const posts = res.data?.data?.children || [];
      for (const post of posts) {
        const id = post.data.id;
        if (seen.posts.includes(id)) continue;

        const text = `${post.data.title}\n${post.data.selftext || ''}`;
        const hasKeyword = KEYWORDS.some(k => text.toLowerCase().includes(k.toLowerCase()));
        if (!hasKeyword) {
          seen.posts.push(id);
          continue;
        }

        const codes = extractCodes(text);
        if (codes.length) {
          for (const code of codes) {
            if (!seen.codes.includes(code)) {
              await sendDiscord(`🧩 Found Sora invite code: ${code}\nPost: https://reddit.com${post.data.permalink}`);
              seen.codes.push(code);
            }
          }
        }

        seen.posts.push(id);
        newPosts++;
      }
    } catch (err) {
      console.warn('Failed fetching', url, err.message);
    }
  }

  saveSeen(seen);
  await sendDiscord(`✅ Scan complete. Checked ${newPosts} new posts.`);
}

// ---------------- RUN ----------------
scrapeExample().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
