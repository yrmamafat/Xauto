import fs from "node:fs";
import Parser from "rss-parser";

import { SignatureV4 } from "@aws-sdk/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@aws-sdk/protocol-http";

import OpenAI from "openai";
import { TwitterApi } from "twitter-api-v2";

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v.trim(); // ✅ critical
}

const CFG = {
  // Slickdeals RSS sources (Frontpage/Popular/Trending)
  // Slickdeals help article lists these RSS feeds. (URLs below are widely used patterns.)
  FRONT_RSS: process.env.FRONT_RSS || "https://slickdeals.net/newsearch.php?mode=frontpage&rss=1&searcharea=deals&searchin=first",
  POP_RSS: process.env.POP_RSS || "https://slickdeals.net/newsearch.php?mode=popdeals&rss=1&searcharea=deals&searchin=first",
  TREND_RSS: process.env.TREND_RSS || "https://feeds.feedburner.com/SlickdealsnetUP",

  // Filter: keep only deal titles mentioning Amazon (can loosen later)
  MERCHANT_REGEX: new RegExp(process.env.MERCHANT_REGEX || "(amazon|amzn)", "i"),

  // Amazon PA-API
  PAAPI_ACCESS_KEY: mustEnv("PAAPI_ACCESS_KEY"),
  PAAPI_SECRET_KEY: mustEnv("PAAPI_SECRET_KEY"),
  PAAPI_PARTNER_TAG: mustEnv("PAAPI_PARTNER_TAG"),
  PAAPI_HOST: process.env.PAAPI_HOST || "webservices.amazon.com",
  PAAPI_REGION: process.env.PAAPI_REGION || "us-east-1",
  PAAPI_MARKETPLACE: process.env.PAAPI_MARKETPLACE || "www.amazon.com",

  // OpenAI
  OPENAI_API_KEY: mustEnv("OPENAI_API_KEY"),
  OPENAI_MODEL: process.env.OPENAI_MODEL || "gpt-4o-mini",

  // X (OAuth 1.0a user context)
  X_APP_KEY: mustEnv("X_APP_KEY"),
  X_APP_SECRET: mustEnv("X_APP_SECRET"),
  X_ACCESS_TOKEN: mustEnv("X_ACCESS_TOKEN"),
  X_ACCESS_SECRET: mustEnv("X_ACCESS_SECRET"),

  // Behavior
  DRY_RUN: (process.env.DRY_RUN || "0") === "1",
  MAX_FEED_ITEMS: Number(process.env.MAX_FEED_ITEMS || 20),
  MAX_CANDIDATES: Number(process.env.MAX_CANDIDATES || 8),
  DISCLOSURE_HASHTAG: process.env.DISCLOSURE_HASHTAG || "#ad"
};

const STATE_PATH = "./state.json";

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return { usedAsins: [], usedTitles: [] };
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
}
function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function cleanTitle(t) {
  return (t || "")
    .replace(/\$?\d+(\.\d+)?/g, "")     // remove prices
    .replace(/\b(Free|Deal|Save|Off|Coupon)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenOverlapScore(a, b) {
  const A = new Set(a.toLowerCase().split(/\W+/).filter(x => x.length > 2));
  const B = new Set(b.toLowerCase().split(/\W+/).filter(x => x.length > 2));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit++;
  return hit / Math.max(A.size, B.size);
}

async function fetchDealsFromRss(url) {
  const parser = new Parser();
  const feed = await parser.parseURL(url);
  return (feed.items || []).slice(0, CFG.MAX_FEED_ITEMS).map(it => ({
    title: it.title || "",
    link: it.link || "",
    pubDate: it.pubDate || ""
  }));
}

async function paapiSearchItems(keyword) {
  const payloadObj = {
    PartnerType: "Associates",
    PartnerTag: CFG.PAAPI_PARTNER_TAG,
    Keywords: keyword,
    Marketplace: CFG.PAAPI_MARKETPLACE,
    ItemCount: 10,
    Resources: [
      "ItemInfo.Title",
      "ItemInfo.Features",
      "Images.Primary.Medium",
      "Offers.Listings.Price",
      "Offers.Listings.SavingBasis",
      "BrowseNodeInfo.WebsiteSalesRank",
      "BrowseNodeInfo.BrowseNodes.SalesRank"
    ],
  };

  const body = JSON.stringify(payloadObj);
  const req = new HttpRequest({
    protocol: "https:",
    method: "POST",
    hostname: CFG.PAAPI_HOST,
    path: "/paapi5/searchitems",
    headers: {
      host: CFG.PAAPI_HOST,
      "content-type": "application/json; charset=utf-8",
      "content-encoding": "amz-1.0",
      "x-amz-target": "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems",
    },
    body,
  });

  const signer = new SignatureV4({
  credentials: {
    accessKeyId: CFG.PAAPI_ACCESS_KEY,
    secretAccessKey: CFG.PAAPI_SECRET_KEY,
  },
  region: CFG.PAAPI_REGION,          // us-east-1 for US :contentReference[oaicite:4]{index=4}
  service: "ProductAdvertisingAPIv1",  // ✅ important :contentReference[oaicite:5]{index=5}
  sha256: Sha256,
});

const signed = await signer.sign(req);

// Debug (does NOT reveal your secret)
const auth = signed.headers?.authorization || "";
const m = auth.match(/SignedHeaders=([^,]+)/);
console.log("PAAPI SignedHeaders:", m?.[1] || "n/a");
console.log("PAAPI AccessKey prefix:", CFG.PAAPI_ACCESS_KEY.slice(0, 4), "len:", CFG.PAAPI_ACCESS_KEY.length);
console.log("PAAPI Secret len:", CFG.PAAPI_SECRET_KEY.length);



  const res = await fetch(`https://${CFG.PAAPI_HOST}${req.path}`, {
    method: "POST",
    headers: signed.headers,
    body,
  });

  const json = await res.json();
  if (!res.ok) throw new Error(`PA-API error ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

function parseMoney(display) {
  // Very light parsing, not perfect for all locales
  const m = String(display || "").replace(/[^0-9.]/g, "");
  const n = Number(m);
  return Number.isFinite(n) ? n : null;
}

function buildCandidate(item, dealTitle) {
  const title = item?.ItemInfo?.Title?.DisplayValue || "";
  const asin = item?.ASIN || "";
  const url = item?.DetailPageURL || ""; // usually includes your partner tag
  const priceDisp = item?.Offers?.Listings?.[0]?.Price?.DisplayAmount || "";
  const basisDisp = item?.Offers?.Listings?.[0]?.SavingBasis?.DisplayAmount || "";
  const price = parseMoney(priceDisp);
  const basis = parseMoney(basisDisp);

  const websiteRank = Number(item?.BrowseNodeInfo?.WebsiteSalesRank?.SalesRank || 0) || null;

  let discountPct = null;
  if (price && basis && basis > price) discountPct = Math.round(((basis - price) / basis) * 100);

  const features = (item?.ItemInfo?.Features?.DisplayValues || []).slice(0, 2);
  const img = item?.Images?.Primary?.Medium?.URL || "";

  const match = tokenOverlapScore(cleanTitle(dealTitle), title);

  return { asin, title, url, priceDisp, basisDisp, discountPct, websiteRank, features, img, match };
}

function scoreCandidate(c) {
  // Higher is better:
  // - strong title match
  // - bigger discount
  // - better (lower) website sales rank
  const matchScore = (c.match || 0) * 100;

  const discountScore = (c.discountPct || 0) * 2;

  // rank: smaller is better; convert to score
  const rankScore = c.websiteRank ? Math.max(0, 100 - Math.log10(c.websiteRank) * 20) : 0;

  return matchScore + discountScore + rankScore;
}

function fit280(text) {
  if (text.length <= 280) return text;
  return text.slice(0, 277).replace(/\s+\S*$/, "") + "...";
}

async function generatePost(openai, c) {
  const system = `You write high-CTR but honest X posts.
Rules:
- No hype/false urgency.
- No medical/financial promises.
- 1 emoji max.
- Keep under 220 chars BEFORE adding link + #ad.
- Output only the post text.`;

  const user = `Write a post for this Amazon product.
Title: ${c.title}
Current price: ${c.priceDisp || "N/A"}
Was price: ${c.basisDisp || "N/A"}
Discount: ${c.discountPct ? c.discountPct + "%" : "N/A"}
Top features: ${c.features?.join(" | ") || "N/A"}

Make it feel like a "deal worth clicking" and say who it's for. End with a short CTA.`;

  const resp = await openai.chat.completions.create({
    model: CFG.OPENAI_MODEL,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    temperature: 0.7,
  });

  return String(resp.choices?.[0]?.message?.content || "").trim().replace(/\s+/g, " ");
}

async function postToX(text) {
  const client = new TwitterApi({
    appKey: CFG.X_APP_KEY,
    appSecret: CFG.X_APP_SECRET,
    accessToken: CFG.X_ACCESS_TOKEN,
    accessSecret: CFG.X_ACCESS_SECRET,
  });
  return client.v2.tweet(text);
}


async function main() {
  const state = loadState();

  // 1) Fetch deal titles
  const feeds = [CFG.FRONT_RSS, CFG.POP_RSS, CFG.TREND_RSS];
  let items = [];
  for (const url of feeds) {
    try {
      const got = await fetchDealsFromRss(url);
      items.push(...got);
    } catch (e) {
      console.warn("Feed failed:", url, e.message);
    }
  }

  // 2) Filter to Amazon-ish deals + avoid repeats
  items = items
    .filter(it => CFG.MERCHANT_REGEX.test(it.title))
    .filter(it => !state.usedTitles.includes(it.title))
    .slice(0, CFG.MAX_CANDIDATES);

  if (!items.length) {
    console.log("No fresh deal items. Exiting.");
    return;
  }

  const openai = new OpenAI({ apiKey: CFG.OPENAI_API_KEY });

  // 3) For each deal title, validate + enrich with PA-API, then score
  const candidates = [];
  for (const d of items) {
    const keyword = cleanTitle(d.title);
    if (!keyword) continue;

    try {
      const pa = await paapiSearchItems(keyword);
      const found = pa?.SearchResult?.Items || [];
      for (const it of found) {
        const c = buildCandidate(it, d.title);
        if (!c.asin || !c.url) continue;
        if (state.usedAsins.includes(c.asin)) continue;
        if (c.match < 0.25) continue; // avoid bad matches
        candidates.push(c);
      }
    } catch (e) {
      console.warn("PA-API search failed for:", keyword, e.message);
    }
  }

  if (!candidates.length) {
    console.log("No valid candidates after PA-API validation.");
    return;
  }

  candidates.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
  const picked = candidates[0];

  console.log("Picked:", picked.asin, picked.title, "discount:", picked.discountPct, "rank:", picked.websiteRank);

  // 4) Generate post + append affiliate link + disclosure
  const base = await generatePost(openai, picked);

  // IMPORTANT:
  // - Put “As an Amazon Associate I earn from qualifying purchases.” in your BIO/profile.
  // - Add #ad near the link in the post.
  const finalText = fit280(`${base} ${picked.url} ${CFG.DISCLOSURE_HASHTAG}`);

  console.log("Final:\n", finalText);

  if (CFG.DRY_RUN) {
    console.log("DRY_RUN=1: not posting.");
    return;
  }

  const res = await postToX(finalText);
  console.log("Posted ID:", res?.data?.id);

  // 5) Save state (avoid repeats)
  state.usedAsins.push(picked.asin);
  state.usedTitles.push(items[0].title);
  state.usedAsins = state.usedAsins.slice(-500);
  state.usedTitles = state.usedTitles.slice(-500);
  saveState(state);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
