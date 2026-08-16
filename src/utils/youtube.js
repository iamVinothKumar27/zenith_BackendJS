import { google } from "googleapis";
import { config } from "../config/env.js";
import { ytId } from "./text.js";

const youtube = google.youtube({ version: "v3", auth: config.youtubeApiKey });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseIso8601DurationToSeconds(iso) {
  if (!iso) return 0;
  const m = iso.trim().toUpperCase().match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return 0;
  const h = parseInt(m[1] || "0", 10);
  const mi = parseInt(m[2] || "0", 10);
  const s = parseInt(m[3] || "0", 10);
  return h * 3600 + mi * 60 + s;
}

export function looksLikeShorts(title, durationSec, videoUrl = "") {
  const t = (title || "").toLowerCase();
  const u = (videoUrl || "").toLowerCase();
  if (u.includes("/shorts/")) return true;
  if (t.includes("#shorts") || t.includes(" shorts") || t.endsWith("shorts")) return true;
  if (durationSec && durationSec <= 60) return true;
  return false;
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "your", "you",
  "are", "was", "were", "can", "will", "what", "why", "how", "when", "where",
  "about", "using", "use", "tutorial", "course", "learn", "learning",
  "beginner", "advanced", "english", "in", "to", "of", "on", "a", "an",
]);

export function extractTopicKeywords(topic) {
  const t = (topic || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const words = t.split(/\s+/).filter((w) => w.length > 2);
  return new Set(words.filter((w) => !STOP_WORDS.has(w)));
}

/** Returns list of videos for a query with like_count. Returns [] on failure instead of throwing. */
export async function getVideoDetails(query, maxResults = 2, retries = 3, delay = 2000) {
  const videoDetails = [];
  let resultsCount = 0;
  let nextPageToken = undefined;
  let pageNo = 0;

  console.log(`\n========== YOUTUBE FETCH START ==========`);
  console.log(`Query: ${query} | max_results=${maxResults}`);
  console.log(`========================================\n`);

  if (!config.youtubeApiKey) {
    console.log("[YOUTUBE CONFIG] Missing YOUTUBE_API_KEY. Returning empty video list.");
    return videoDetails;
  }

  while (resultsCount < maxResults) {
    pageNo += 1;
    let searchResponse;
    try {
      console.log(`[SEARCH] page=${pageNo} results_so_far=${resultsCount} token=${nextPageToken || ""}`);
      const safeQuery = query ? `${query} -shorts -#shorts` : query;
      const resp = await youtube.search.list({
        q: safeQuery,
        part: ["snippet"],
        maxResults: Math.min(50, maxResults - resultsCount),
        type: ["video"],
        pageToken: nextPageToken,
      });
      searchResponse = resp.data;
    } catch (e) {
      const status = e?.code || e?.response?.status;
      if (status === 500 || status === 503) {
        console.log(`[SEARCH-RETRY] status=${status} sleeping=${delay}ms`);
        await sleep(delay);
        continue;
      }
      console.log("[YOUTUBE SEARCH ERROR]", e.message || e);
      break;
    }

    const items = searchResponse.items || [];
    console.log(`[SEARCH] page=${pageNo} returned_items=${items.length}`);
    for (const item of items) {
      const videoId = item.id?.videoId;
      if (!videoId) {
        console.log("[SKIP] Missing videoId in item");
        continue;
      }

      const title = item.snippet?.title || "";
      const channel = item.snippet?.channelTitle || "";
      const published = item.snippet?.publishedAt || "";
      const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

      let durationSec = 0;
      let isoDur = "";
      let skipShorts = false;
      let stats = {};
      let lastErr = null;

      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          console.log(`  [STATS] attempt=${attempt}/${retries} id=${videoId}`);
          const videoData = await youtube.videos.list({ part: ["statistics", "contentDetails"], id: [videoId] });
          const items0 = videoData.data.items || [];
          if (items0.length) {
            const item0 = items0[0] || {};
            stats = item0.statistics || {};
            const contentDetails = item0.contentDetails || {};
            isoDur = (contentDetails.duration || "").trim();
            durationSec = parseIso8601DurationToSeconds(isoDur);
            if (looksLikeShorts(title, durationSec, videoUrl)) {
              console.log(`  [SKIP-SHORTS] id=${videoId} dur=${durationSec}s title=${title.slice(0, 60)}`);
              stats = {};
              skipShorts = true;
            }
          }
          break;
        } catch (e) {
          lastErr = e;
          const status = e?.code || e?.response?.status;
          if (status === 500 || status === 503) {
            const sleepMs = delay * attempt;
            console.log(`  [STATS-RETRY] status=${status} sleeping=${sleepMs}ms`);
            await sleep(sleepMs);
            continue;
          }
          console.log(`  [STATS-ERROR] id=${videoId} status=${status} err=${e.message || e}`);
          stats = {};
          break;
        }
      }

      if (lastErr && !Object.keys(stats).length && !skipShorts) {
        console.log(`  [STATS-FAIL] id=${videoId} err=${String(lastErr.message || lastErr)}`);
        continue;
      }

      if (skipShorts) continue;

      const likeCount = parseInt(stats.likeCount || "0", 10) || 0;
      const viewCount = parseInt(stats.viewCount || "0", 10) || 0;
      const commentCount = parseInt(stats.commentCount || "0", 10) || 0;

      videoDetails.push({
        url: videoUrl,
        video_id: videoId,
        title,
        channel,
        publishedAt: published,
        like_count: likeCount,
        view_count: viewCount,
        comment_count: commentCount,
        duration_sec: durationSec,
        duration_iso: isoDur,
      });

      console.log(query, " [", resultsCount, "] : ", videoDetails[videoDetails.length - 1]);

      resultsCount += 1;
      if (resultsCount >= maxResults) break;
    }

    nextPageToken = searchResponse.nextPageToken;
    if (!nextPageToken) {
      console.log("[SEARCH] No nextPageToken, ending.");
      break;
    }
  }

  console.log(`\n========== YOUTUBE FETCH END ==========`);
  console.log(`Query: ${query} | fetched=${videoDetails.length}`);
  console.log(`======================================\n`);

  return videoDetails;
}

/** Pick a non-Shorts YouTube video for a query, avoiding repeats and topic overlap. */
export async function getBestVideo(query, usedVideoIds = new Set(), blockedKeywords = new Set()) {
  const videoList = await getVideoDetails(query, 12);
  if (!videoList.length) return null;

  const containsBlocked = (title) => {
    const t = (title || "").toLowerCase();
    for (const kw of blockedKeywords) {
      if (kw && t.includes(kw)) return true;
    }
    return false;
  };

  for (const v of videoList) {
    const vid = v.video_id || ytId(v.url || "");
    if (!vid) continue;
    if (usedVideoIds.has(vid)) continue;
    if (containsBlocked(v.title)) continue;
    return v;
  }

  for (const v of videoList) {
    const vid = v.video_id || ytId(v.url || "");
    if (vid && !usedVideoIds.has(vid)) return v;
  }
  return null;
}

export default youtube;
