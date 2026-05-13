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
import * as http from "http";
import { HttpsProxyAgent } from "https-proxy-agent";

dotenv.config();

const MONITOR_URL = process.env.MONITOR_URL || "https://www.stwdo.de/wohnen/aktuelle-wohnangebote#residential-offer-list";
const POLL_INTERVAL_SECONDS = Number(process.env.POLL_INTERVAL_SECONDS || "120"); // 5 minutes
const STORAGE_FILE = path.resolve(process.cwd(), "stwdo-last.json");
const META_FILE = path.resolve(process.cwd(), "stwdo-meta.json");

// Notification method: "telegram" | "webhook" | "email" | "console"
const NOTIFY_METHOD = (process.env.NOTIFY_METHOD || "console").toLowerCase();
const PERIODIC_CALL_URL = process.env.PERIODIC_CALL_URL;
const PERIODIC_CALL_SECONDS = Number(process.env.PERIODIC_CALL_SECONDS || "120");
const USE_PROXY = process.env.USE_PROXY === "true";

// Telegram config
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Proxy config
const PROXY_HOST = process.env.PROXY_HOST;
const PROXY_PORT = process.env.PROXY_PORT ? Number(process.env.PROXY_PORT) : undefined;
const PROXY_USERNAME = process.env.PROXY_USERNAME;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD;

const proxyUrl = (PROXY_HOST && PROXY_PORT)
  ? `http://${PROXY_USERNAME && PROXY_PASSWORD ? `${PROXY_USERNAME}:${PROXY_PASSWORD}@` : ""}${PROXY_HOST}:${PROXY_PORT}`
  : undefined;

const httpsAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

// Webhook
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// Auto-Apply Config
const DRY_RUN = process.env.DRY_RUN !== "false"; // Default to true for safety
const APP_EMAIL = process.env.APP_EMAIL || "tibate9833@cadinr.com";
const APP_FIRST_NAME = process.env.APP_FIRST_NAME || "First";
const APP_LAST_NAME = process.env.APP_LAST_NAME || "Last";
const APP_PHONE = process.env.APP_PHONE || "+49 1579 123456";
const APP_BIRTHDAY = process.env.APP_BIRTHDAY || "12.12.1990";
const APP_NATIONALITY = process.env.APP_NATIONALITY || "Syrien";
const APP_UNIVERSITY = process.env.APP_UNIVERSITY || "TU-Dortmund";
const APP_SEMESTER_COUNT = process.env.APP_SEMESTER_COUNT || "4";
const APP_START_SEMESTER = process.env.APP_START_SEMESTER || "Sommersemester";
const APP_YEAR = process.env.APP_YEAR || "2026";

interface Offer {
  id: string;
  title: string;
  url: string;
  location?: string;
  price?: number;
}

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

function extractOffersFromHtml(html: string): Offer[] {
  const $ = cheerio.load(html);

  const offersMap = new Map<string, Offer>();

  // 1. Specific extraction for the residential-offer-list (teaser cards with data-href)
  const teaserList = $("#residential-offer-list .teaser[data-href]");

  teaserList.each((i: number, el: any) => {
    const dataHref = $(el).attr("data-href");
    if (!dataHref) return;

    const location = $(el).find(".subheader-5").text().trim();
    const title = $(el).find(".headline-5").text().trim();

    // Extract price
    const priceText = $(el).find(".residential-offer-card-facts .headline-4").first().text().trim();
    const priceMatch = priceText.match(/([\d,.]+)/);
    const price = priceMatch ? parseFloat(priceMatch[1].replace(".", "").replace(",", ".")) : undefined;

    const absolute = dataHref.startsWith("http") ? dataHref : new URL(dataHref, MONITOR_URL).toString();
    const id = absolute;
    offersMap.set(id, { id, title: title || absolute, url: absolute, location, price });
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

async function applyForOffer(offer: Offer) {
  const { url, location, title, price } = offer;

  // Conditions: Dortmund, Einzelapartment, Price < 400
  const isDortmund = location?.toLowerCase().includes("dortmund");
  const isEinzelapartment = title?.toLowerCase().includes("einzelapartment");
  const isPriceOk = price !== undefined && price <= 363;

  if (!isDortmund || !isEinzelapartment || !isPriceOk) {
    console.log(`[Apply] Offer "${title}" does not match criteria. (Dortmund: ${isDortmund}, Einzel: ${isEinzelapartment}, Price: ${price} <= 363: ${isPriceOk})`);
    return;
  }

  console.log(`[Apply] Matching offer found! Applying for: ${title} (${location}, ${price}€)`);

  try {
    // 1. Fetch listing page to get UUID
    if (USE_PROXY) console.log(`[Apply] Fetching listing details via proxy: ${PROXY_HOST}...`);
    const res = await axios.get(url, {
      timeout: 85_000,
      httpsAgent: USE_PROXY ? httpsAgent : undefined,
      proxy: false,
    });
    const html = res.data;
    const $ = cheerio.load(html);
    const iframeSrc = $("#bewerben").attr("src");

    if (!iframeSrc) {
      console.error(`[Apply] Could not find application iframe on ${url}`);
      return;
    }

    // Extract UUID from iframe src (parameter c)
    const uuidMatch = iframeSrc.match(/[?&]c=([a-f0-9-]+)/);
    const uuid = uuidMatch ? uuidMatch[1] : null;

    if (!uuid) {
      console.error(`[Apply] Could not extract UUID from iframe src: ${iframeSrc}`);
      return;
    }

    // 2. Extract Offer ID from URL (the part after /r/f/)
    // Example: https://www.stwdo.de/wohnen/aktuelle-wohnangebote/r/f/1/527/1/1900 -> 1/527/1/1900
    const offerIdMatch = url.match(/\/r\/f\/(.+)$/);
    const offerIdRaw = offerIdMatch ? offerIdMatch[1] : null;
    const offerId = offerIdRaw ? encodeURIComponent(offerIdRaw) : null;

    if (!offerId) {
      console.error(`[Apply] Could not extract Offer ID from URL: ${url}`);
      return;
    }

    const applicationUrl = `https://app.wohnungshelden.de/api/applicationFormEndpoint/3.0/form/create-application/${uuid}/${offerId}`;

    const payload = {
      "publicApplicationCreationTO": {
        "applicantMessage": null,
        "email": APP_EMAIL,
        "firstName": APP_FIRST_NAME,
        "lastName": APP_LAST_NAME,
        "phoneNumber": APP_PHONE,
        "salutation": "MR",
        "street": null,
        "houseNumber": null,
        "zipCode": null,
        "city": null,
        "additionalAddressInformation": null
      },
      "saveFormDataTO": {
        "formData": {
          "$$_mobile_number_$$": APP_PHONE,
          "$$_date_of_birth_$$": APP_BIRTHDAY,
          "nationality": APP_NATIONALITY,
          "startOfSemester": APP_START_SEMESTER,
          "year": APP_YEAR,
          "numberOfSemester": APP_SEMESTER_COUNT,
          "stwdo_university": APP_UNIVERSITY,
          "stwdo_angewiesen_auf_rollstuhlgerechte_wohnung": false,
          "stwdo_immatrikulation": true,
          "stwdo_datenschutzhinweis_bestaetigt": true
        },
        "files": []
      },
      "recaptchaToken": null
    };

    if (DRY_RUN) {
      console.log(`[Apply][DRY_RUN] Would send POST to ${applicationUrl} with payload:`, JSON.stringify(payload, null, 2));
      return;
    }

    const postRes = await axios.post(applicationUrl, payload, {
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/plain, */*",
        "Origin": "https://app.wohnungshelden.de",
        "Referer": `https://app.wohnungshelden.de/public/listings/${offerId}/application?c=${uuid}`,
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0"
      },
      timeout: 20_000,
      httpsAgent: USE_PROXY ? httpsAgent : undefined,
      proxy: false,
    });

    if (postRes.data === true || postRes.status === 200) {
      console.log(`[Apply] Successfully applied for ${title}!`);
      await notifyNewOffers([{ ...offer, title: `✅ AUTO-APPLY: ${offer.title}` }]);
    } else {
      console.error(`[Apply] Failed to apply for ${title}. Response:`, postRes.data);
    }

  } catch (err: any) {
    console.error(`[Apply] Error applying for ${url}:`, err.message || err);
  }
}

async function notifyNewOffers(newOffers: Offer[]) {
  if (!newOffers.length) return;

  const lines = newOffers.map(o => `• ${o.title} — ${o.url}`);
  const message = `Neue Wohnungsangebote gefunden (${new Date().toLocaleString()}):\n${lines.join("\n")}`;

  switch (NOTIFY_METHOD) {
    case "telegram":
      if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.error("Telegram selected but TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing in env.");
        break;
      }
      console.log(`Sending Telegram notification via proxy: ${PROXY_HOST}:${PROXY_PORT}...`);
      try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          disable_web_page_preview: false,
        }, {
          httpsAgent: USE_PROXY ? httpsAgent : undefined,
          proxy: false, // Disable axios default proxy handling
          timeout: 15_000,
        });
        console.log("✅ Sent Telegram notification");
      } catch (err: any) {
        console.error("❌ Telegram notify error:", err.message || err);
        if (err.code === 'ECONNABORTED') {
          console.error("Timeout reached. The proxy might be unresponsive.");
        }
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
    httpsAgent: USE_PROXY ? httpsAgent : undefined,
    proxy: false,
  };

  try {
    if (USE_PROXY) console.log(`${new Date().toLocaleString()} - Checking for offers via proxy: ${PROXY_HOST}...`);
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

    const lastSeenIds = new Set<string>(last.offers || []);

    // Determine newly appeared offers
    const newOffers = offers.filter(o => !lastSeenIds.has(o.id));

    if (newOffers.length) {
      console.log(new Date().toLocaleString(), "- Detected new offers:", newOffers.map(o => o.title));
      await notifyNewOffers(newOffers);

      // Auto-apply logic
      for (const offer of newOffers) {
        await applyForOffer(offer);
      }

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

async function runPeriodicJob() {
  if (!PERIODIC_CALL_URL) {
    console.log("No PERIODIC_CALL_URL defined, skipping job.");
    return;
  }

  console.log(`Starting periodic job for: ${PERIODIC_CALL_URL} (every 40m)`);

  while (true) {
    try {
      console.log(`[${new Date().toLocaleString()}] Periodic job: Calling ${PERIODIC_CALL_URL}${USE_PROXY ? " (via proxy)" : ""}`);
      await axios.get(PERIODIC_CALL_URL, {
        httpsAgent: USE_PROXY ? httpsAgent : undefined,
        proxy: false,
        timeout: 20_000,
      });
      console.log(`[${new Date().toLocaleString()}] Periodic job: Success ✅`);
    } catch (err: any) {
      console.error(`[${new Date().toLocaleString()}] Periodic job error:`, err.message || err);
    }
    // Wait for 40 minutes
    await sleep(PERIODIC_CALL_SECONDS * 1000);
  }
}

async function main() {
  console.log("Starting STWDO offer monitor for:", MONITOR_URL);
  console.log(`Polling interval: ${POLL_INTERVAL_SECONDS}s`);

  // Start a minimal HTTP server for health checks (Koyeb/Render)
  const PORT = process.env.PORT || 7860;
  http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
  }).listen(PORT, () => {
    console.log(`Health check server listening on port ${PORT}`);
  });

  // Start the periodic job in the background (no await)
  runPeriodicJob().catch(err => console.error("Periodic job critical error:", err));

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
