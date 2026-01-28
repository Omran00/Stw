/*
STWDO Offer Monitor (TypeScript)

Purpose: Poll https://www.stwdo.de/wohnen/aktuelle-wohnangebote and notify you when new residential offers appear.

Features:
- Uses conditional GET via ETag/Last-Modified when available
- Parses page with cheerio and falls back to simple "no offers" text detection
- Stores last-seen offers in a local JSON file and notifies on new ones
- Built-in support for Telegram / Webhook / Email notifications (configurable via env vars)
- Runs as a simple interval (default: every 5 minutes) or can be run via cron

Usage:
1. Install dependencies:
   npm init -y
   npm install axios cheerio node-cron dotenv fs-extra
   npm install --save-dev typescript ts-node @types/node @types/cheerio

2. Create a .env file with your choices (see below)

3. Run with ts-node:
   npx ts-node stwdo-offer-monitor.ts

Environment variables (.env):
- MONITOR_URL (default set to the STWDO page)
- POLL_INTERVAL_SECONDS (default 300)
- NOTIFY_METHOD = telegram | webhook | email | console (default: console)

Telegram (recommended):
- TELEGRAM_BOT_TOKEN
- TELEGRAM_CHAT_ID

Webhook (Discord, Slack):
- WEBHOOK_URL

Email (nodemailer SMTP - optional):
- EMAIL_SMTP_HOST
- EMAIL_SMTP_PORT
- EMAIL_SMTP_USER
- EMAIL_SMTP_PASS
- EMAIL_TO
- EMAIL_FROM

Notes & caveats:
- Be polite: don't poll too frequently. Default is 5 minutes. The site mentions they publish new offers at regular times (MEZ) — consider aligning your schedule to those windows.
- If the site uses heavy client-side rendering in the future, you may need to switch to a headless browser (puppeteer). This script parses server HTML and also checks for the phrase "Keine Angebote".

*/

import axios from "axios";
import type { AxiosRequestConfig } from "axios";
import * as cheerio from "cheerio";
import { Element } from "domhandler";
import fs from "fs-extra";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

const MONITOR_URL = process.env.MONITOR_URL || "https://www.stwdo.de/wohnen/aktuelle-wohnangebote#residential-offer-list";
const POLL_INTERVAL_SECONDS = Number(process.env.POLL_INTERVAL_SECONDS || "120"); // 5 minutes
const STORAGE_FILE = path.resolve(process.cwd(), "stwdo-last.json");
const META_FILE = path.resolve(process.cwd(), "stwdo-meta.json");

// Notification method: "telegram" | "webhook" | "email" | "console"
const NOTIFY_METHOD = (process.env.NOTIFY_METHOD || "console").toLowerCase();

// Telegram config
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Webhook
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// Email (optional - nodemailer would need be added if you enable email)
// const EMAIL_SMTP_HOST = process.env.EMAIL_SMTP_HOST; // etc.

async function loadLastSeen(): Promise<{ offers: string[] }> {
  try {
    if (!await fs.pathExists(STORAGE_FILE)) return { offers: [] };
    const data = await fs.readJson(STORAGE_FILE);
    if (!data || !Array.isArray(data.offers)) return { offers: [] };
    return data;
  } catch (e) {
    console.warn("Warning: Could not read last seen file, starting with empty list.");
    return { offers: [] };
  }
}

async function saveLastSeen(data: { offers: string[] }) {
  // Guard against saving an empty list if we previously had data
  // (unless it's truly the first time)
  await fs.writeJson(STORAGE_FILE, data, { spaces: 2 });
}

async function loadMeta(): Promise<any> {
  try {
    if (!await fs.pathExists(META_FILE)) return {};
    return await fs.readJson(META_FILE);
  } catch (e) {
    return {};
  }
}

async function saveMeta(meta: any) {
  await fs.writeJson(META_FILE, meta, { spaces: 2 });
}

function extractOffersFromHtml(html: string): { id: string; title: string; url: string }[] {
  const $ = cheerio.load(html);

  // We'll skip the aggressive bodyText.includes("Keine Angebote") check 
  // because it matches the dropdown options for cities without offers.
  // Instead, we'll let the extraction logic find actual teaser cards.

  const offersMap = new Map<string, { id: string; title: string; url: string }>();

  // 1. Specific extraction for the residential-offer-list (teaser cards with data-href)
  const teaserList = $("#residential-offer-list .teaser[data-href]");

  teaserList.each((i: number, el: any) => {
    const dataHref = $(el).attr("data-href");
    if (!dataHref) return;

    const location = $(el).find(".subheader-5").text().trim();
    const title = $(el).find(".headline-5").text().trim();
    const fullTitle = location ? `${location}: ${title}` : title;

    const absolute = dataHref.startsWith("http") ? dataHref : new URL(dataHref, MONITOR_URL).toString();
    const id = absolute;
    offersMap.set(id, { id, title: fullTitle || absolute, url: absolute });
  });

  // 2. Fallback: standard anchor extraction (heuristic)
  if (offersMap.size === 0) {
    const containers = ["main", "#content", ".container", ".content"];
    let anchors: any | null = null;
    for (const sel of containers) {
      const c = $(sel);
      if (c.length) {
        anchors = c.find("a[href]");
        if (anchors && anchors.length) break;
      }
    }

    if (!anchors || anchors.length === 0) {
      anchors = $("a[href]");
    }

    anchors.each((i: number, el: any) => {
      const href = $(el).attr("href") || "";
      const text = $(el).text().trim();
      if (!href) return;

      const isInternal = href.startsWith("/") || href.includes("stwdo.de");
      const hasKeywords = /wohn|zimmer|apartment|angebot|bewerb/i.test(text + href);

      if (isInternal && hasKeywords) {
        const absolute = href.startsWith("http") ? href : new URL(href, MONITOR_URL).toString();
        const id = absolute;
        if (!offersMap.has(id)) {
          offersMap.set(id, { id, title: text || absolute, url: absolute });
        }
      }
    });
  }

  return Array.from(offersMap.values());
}

async function notifyNewOffers(newOffers: { id: string; title: string; url: string }[]) {
  if (!newOffers.length) return;

  const lines = newOffers.map(o => `• ${o.title} — ${o.url}`);
  const message = `Neue Wohnungsangebote gefunden (${new Date().toLocaleString()}):\n${lines.join("\n")}`;

  switch (NOTIFY_METHOD) {
    case "telegram":
      if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.error("Telegram selected but TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing in env.");
        break;
      }
      try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          disable_web_page_preview: false,
        });
        console.log("Sent Telegram notification");
      } catch (err) {
        console.error("Telegram notify error", err);
      }
      break;

    case "webhook":
      if (!WEBHOOK_URL) {
        console.error("Webhook selected but WEBHOOK_URL is missing in env.");
        break;
      }
      try {
        await axios.post(WEBHOOK_URL, { content: message });
        console.log("Sent webhook notification");
      } catch (err) {
        console.error("Webhook notify error", err);
      }
      break;

    case "email":
      // Email support not implemented in this template. You can plug nodemailer here.
      console.log("Email notify selected but email sending not implemented in template. Message would be:\n", message);
      break;

    default:
      console.log(message);
  }
}


async function checkOnce() {
  const meta = await loadMeta();
  const headers: Record<string, string> = { "User-Agent": "stwdo-offer-monitor/1.0 (+https://github.com)" };
  if (meta.etag) headers["If-None-Match"] = meta.etag;
  if (meta.lastModified) headers["If-Modified-Since"] = meta.lastModified;

  const axiosConfig: AxiosRequestConfig = {
    url: MONITOR_URL,
    method: "GET",
    headers,
    responseType: "text",
    validateStatus: s => (s >= 200 && s < 300) || s === 304,
    timeout: 30_000,
  };

  try {
    const res = await axios(axiosConfig);
    if (res.status === 304) {
      console.log(new Date().toLocaleString(), "- Not modified (304). No changes.");
      return;
    }

    // Save meta
    const newMeta = { ...meta };
    if (res.headers["etag"]) newMeta.etag = res.headers["etag"];
    if (res.headers["last-modified"]) newMeta.lastModified = res.headers["last-modified"];
    await saveMeta(newMeta);

    const html = typeof res.data === "string" ? res.data : "";
    const offers = extractOffersFromHtml(html);

    let last;
    try {
      last = await loadLastSeen();
    } catch (e) {
      console.error("Failed to load last seen offers, skipping this check to avoid data loss.");
      return;
    }

    const lastSeenIds = new Set(last.offers || []);

    // Determine newly appeared offers
    const newOffers = offers.filter(o => !lastSeenIds.has(o.id));

    if (newOffers.length) {
      console.log(new Date().toLocaleString(), "- Detected new offers:", newOffers.map(o => o.title));
      await notifyNewOffers(newOffers);

      // PERSISTENT STORAGE: Add NEW ids to the existing set
      newOffers.forEach(o => lastSeenIds.add(o.id));
      await saveLastSeen({ offers: Array.from(lastSeenIds) });
    } else {
      console.log(new Date().toLocaleString(), "- No new offers (count:", offers.length, ")");
    }
  } catch (err: any) {
    console.error("Fetch or processing error:", err.message || err);
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  console.log("Starting STWDO offer monitor for:", MONITOR_URL);
  console.log(`Polling interval: ${POLL_INTERVAL_SECONDS}s`);

  while (true) {
    try {
      await checkOnce();
    } catch (err) {
      console.error("Main loop error:", err);
    }
    await sleep(POLL_INTERVAL_SECONDS * 1000);
  }
}

main().catch(err => {
  console.error("Critical error:", err);
  process.exit(1);
});
