import fs from "node:fs";
import Parser from "rss-parser";
import { SignatureV4 } from "@aws-sdk/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@aws-sdk/protocol-http";
import OpenAI from "openai";
import { TwitterApi } from "twitter-api-v2";

// Utility to fetch environment variables
function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v.trim(); // ✅ critical: remove unwanted spaces
}



// Configuration for various services
const CFG = {
  FRONT_RSS: process.env.FRONT_RSS || "https://slickdeals.net/newsearch.php?mode=frontpage&rss=1&searcharea=deals&searchin=first",
  POP_RSS: process.env.POP_RSS || "https://slickdeals.net/newsearch.php?mode=popdeals&rss=1&searcharea=deals&searchin=first",
  TREND_RSS: process.env.TREND_RSS || "https://feeds.feedburner.com/SlickdealsnetUP",
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,

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

// State loading and saving functions
function loadState() {
  if (!fs.existsSync(STATE_PATH)) return { usedAsins: [], usedTitles: [] };
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
}
function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// Utility to clean product title for searching
function cleanTitle(t) {
  return (t || "")
    .replace(/\$?\d+(\.\d+)?/g, "")     // remove prices
    .replace(/\b(Free|Deal|Save|Off|Coupon)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

console.log("API Key used: ", CFG.OPENAI_API_KEY);

// Function to filter products based on price and sales rank
function filterProduct(product) {
  const price = parseMoney(product.Offers?.Listings?.[0]?.Price?.DisplayAmount);
  const rank = Number(product?.BrowseNodeInfo?.WebsiteSalesRank?.SalesRank || 0);

  // Only accept products priced over $500 and with a good sales rank (lower is better)
  if (price && price >= 500 && rank < 1000) {
    return true;
  }
  return false;
}

// Function to calculate token overlap score between deal title and product title
function tokenOverlapScore(a, b) {
  const A = new Set(a.toLowerCase().split(/\W+/).filter(x => x.length > 2));
  const B = new Set(b.toLowerCase().split(/\W+/).filter(x => x.length > 2));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit++;
  return hit / Math.max(A.size, B.size);
}

// Function to fetch deal items from RSS feed
async function fetchDealsFromRss(url) {
  const parser = new Parser();
  const feed = await parser.parseURL(url);
  return (feed.items || []).slice(0, CFG.MAX_FEED_ITEMS).map(it => ({
    title: it.title || "",
    link: it.link || "",
    pubDate: it.pubDate || ""
  }));
}

// Function to fetch product details from Amazon's PA-API
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
    region: CFG.PAAPI_REGION,
    service: "ProductAdvertisingAPI",
    sha256: Sha256,
  });

  const signed = await signer.sign(req);
  const res = await fetch(`https://${CFG.PAAPI_HOST}${req.path}`, {
    method: "POST",
    headers: signed.headers,
    body,
  });

  const json = await res.json();
  if (!res.ok) throw new Error(`PA-API error ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

// Parse price from display string
function parseMoney(display) {
  const m = String(display || "").replace(/[^0-9.]/g, "");
  const n = Number(m);
  return Number.isFinite(n) ? n : null;
}

// Build candidate product from PA-API response
function buildCandidate(item, dealTitle) {
  const title = item?.ItemInfo?.Title?.DisplayValue || "";
  const asin = item?.ASIN || "";
  const url = item?.DetailPageURL || ""; 
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

  return { asin, title, url, priceDisp, basisDisp, discountPct, websiteRank, features, img, match, sourceTitle: dealTitle };
}

// Score candidate products based on match, discount, and sales rank
function scoreCandidate(c) {
  const matchScore = (c.match || 0) * 100;
  const discountScore = (c.discountPct || 0) * 2;
  const rankScore = c.websiteRank ? Math.max(0, 100 - Math.log10(c.websiteRank) * 20) : 0;

  return matchScore + discountScore + rankScore;
}

// Fit text to 280 characters (for Twitter)
function fit280(text) {
  if (text.length <= 280) return text;
  return text.slice(0, 277).replace(/\s+\S*$/, "") + "...";
}

// Generate post content using OpenAI
async function generatePost(openai, c) {
  const system = `Write high-CTR, SEO-friendly posts for Amazon deals.
Rules:
- No false urgency.
- Use 1 emoji max.
- Include 2–4 relevant hashtags.
- Focus on key benefits and the audience.
- Keep the text under 200 characters (before link/#ad).`;

  const user = `Write a compelling post for this Amazon product.
Title: ${c.title}
Price: ${c.priceDisp || "N/A"}
Discount: ${c.discountPct ? c.discountPct + "%" : "N/A"}
Top features: ${c.features?.join(" | ") || "N/A"}`;

  const resp = await openai.chat.completions.create({
    model: CFG.OPENAI_MODEL,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    temperature: 0.7,
  });

  return String(resp.choices?.[0]?.message?.content || "").trim().replace(/\s+/g, " ");
}

// Post to X (Twitter)
async function postToX(text) {
  const client = new TwitterApi({
    appKey: CFG.X_APP_KEY,
    appSecret: CFG.X_APP_SECRET,
    accessToken: CFG.X_ACCESS_TOKEN,
    accessSecret: CFG.X_ACCESS_SECRET,
  });
  return client.v2.tweet(text);
}

// Main function to run the automation
async function main() {
  const state = loadState();
  let items = [];

  // Fetch deals from RSS feeds
  const feeds = [CFG.FRONT_RSS, CFG.POP_RSS, CFG.TREND_RSS];
  for (const url of feeds) {
    try {
      const got = await fetchDealsFromRss(url);
      items.push(...got);
    } catch (e) {
      console.warn("Feed failed:", url, e.message);
    }
  }

  // Filter and select only Amazon deals over $500
  items = items.filter(it => CFG.MERCHANT_REGEX.test(it.title))
               .filter(it => !state.usedTitles.includes(it.title))
               .slice(0, CFG.MAX_CANDIDATES);

  if (!items.length) {
    console.log("No fresh deal items. Exiting.");
    return;
  }

  const openai = new OpenAI({
  apiKey: CFG.OPENAI_API_KEY,  // This should be your OpenRouter API Key
  baseURL: CFG.OPENAI_BASE_URL // Use OpenRouter's API URL
});

  // Validate and enrich deals with PA-API
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
        if (c.match < 0.25) continue;
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

  // Generate post + append affiliate link + disclosure
  const base = await generatePost(openai, picked);
  const finalText = fit280(`${base} ${picked.url} ${CFG.DISCLOSURE_HASHTAG}`);

  console.log("Final Post Text:\n", finalText);

  if (CFG.DRY_RUN) {
    console.log("DRY_RUN=1: not posting.");
    return;
  }

  // Post to X (Twitter)
  const res = await postToX(finalText);
  console.log("Posted ID:", res?.data?.id);

  // Save state to avoid repeats
  state.usedAsins.push(picked.asin);
  state.usedTitles.push(picked.sourceTitle || picked.title);
  state.usedAsins = state.usedAsins.slice(-500);
  state.usedTitles = state.usedTitles.slice(-500);
  saveState(state);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
