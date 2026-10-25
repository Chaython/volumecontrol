import fs from "node:fs/promises";
import path from "node:path";

const outDir = path.join(process.cwd(), "docs");
const generatedAt = new Date().toISOString();
const repository = process.env.GITHUB_REPOSITORY || "Chaython/volumecontrol";
const amoSlug = process.env.AMO_ADDON_SLUG || "volume-control-boost-volume";
const edgeExtensionId = "ipbghdjdmefdioebhaneohmkidjakfbc";
const edgeUrl = "https://microsoftedge.microsoft.com/addons/detail/ipbghdjdmefdioebhaneohmkidjakfbc";
const token = process.env.GH_TRAFFIC_TOKEN || "";
const baseHeaders = { accept: "application/json", "user-agent": "Volume-Control-Stats/1.0" };

async function getJson(url, extra = {}) {
  const response = await fetch(url, { headers: { ...baseHeaders, ...extra }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("HTTP " + response.status + " from " + new URL(url).hostname);
  return response.json();
}
async function attempt(fn) {
  try { return { ok: true, data: await fn() }; }
  catch (error) { return { ok: false, error: String(error?.message || error).slice(0, 240) }; }
}
function numeric(value) { return Number.isFinite(value) ? value : null; }
function fmt(value) { return Number.isFinite(value) ? new Intl.NumberFormat("en-US").format(value) : "Unavailable"; }
function xml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]);
}

const [amoResult, repoResult, edgeResult] = await Promise.all([
  attempt(() => getJson("https://addons.mozilla.org/api/v5/addons/addon/" + encodeURIComponent(amoSlug) + "/")),
  attempt(() => getJson("https://api.github.com/repos/" + repository)),
  attempt(() => getJson("https://microsoftedge.microsoft.com/addons/getproductdetailsbycrxid/" + edgeExtensionId + "?hl=en-US&gl=US"))
]);
const firefox = amoResult.ok ? {
  status: "available",
  addonName: amoResult.data.name?.["en-US"] || amoResult.data.name || "Volume Control",
  averageDailyUsers: numeric(amoResult.data.average_daily_users),
  weeklyDownloads: numeric(amoResult.data.weekly_downloads),
  rating: numeric(amoResult.data.ratings?.average),
  url: "https://addons.mozilla.org/en-US/firefox/addon/" + amoSlug + "/"
} : { status: "unavailable", error: amoResult.error, averageDailyUsers: null, weeklyDownloads: null, url: "https://addons.mozilla.org/en-US/firefox/addon/" + amoSlug + "/" };

const edgePayload = edgeResult.ok ? (edgeResult.data?.productDetails || edgeResult.data?.data || edgeResult.data) : null;
function edgeNumber(...values) {
  for (const value of values) {
    const parsed = typeof value === "string" && value.trim() ? Number(value.replace(/,/g, "")) : value;
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}
const edge = { status: edgeResult.ok ? "available" : "unavailable", extensionId: edgeExtensionId, url: edgeUrl, activeInstallCount: edgeNumber(edgePayload?.activeInstallCount, edgePayload?.activeUsers, edgePayload?.userCount, edgePayload?.installCount), rating: edgeNumber(edgePayload?.averageRating, edgePayload?.rating), ratingCount: edgeNumber(edgePayload?.ratingCount, edgePayload?.ratingsCount), version: typeof edgePayload?.version === "string" ? edgePayload.version : null, lastUpdated: edgePayload?.lastUpdateDate || edgePayload?.lastUpdated || null, message: edgeResult.ok ? "Public listing metadata only; weekly users, daily installs, and impressions require Partner Center analytics." : "Public listing metrics could not be retrieved. Weekly users, daily installs, and impressions are available in Partner Center." };

const github = repoResult.ok ? {
  status: "available",
  stars: numeric(repoResult.data.stargazers_count),
  forks: numeric(repoResult.data.forks_count),
  watchers: numeric(repoResult.data.subscribers_count),
  url: repoResult.data.html_url
} : { status: "unavailable", error: repoResult.error, stars: null, forks: null, url: "https://github.com/" + repository };

if (repoResult.ok && token) {
  const auth = { authorization: "Bearer " + token, "x-github-api-version": "2022-11-28" };
  const [views, clones, referrers] = await Promise.all([
    attempt(() => getJson("https://api.github.com/repos/" + repository + "/traffic/views", auth)),
    attempt(() => getJson("https://api.github.com/repos/" + repository + "/traffic/clones", auth)),
    attempt(() => getJson("https://api.github.com/repos/" + repository + "/traffic/popular/referrers", auth))
  ]);
  github.traffic = {
    status: views.ok && clones.ok ? "available" : "unavailable",
    views: views.ok ? views.data.views : [],
    totalViews: views.ok ? numeric(views.data.count) : null,
    uniqueVisitors: views.ok ? numeric(views.data.uniques) : null,
    clones: clones.ok ? clones.data.clones : [],
    totalClones: clones.ok ? numeric(clones.data.count) : null,
    uniqueCloners: clones.ok ? numeric(clones.data.uniques) : null,
    referrers: referrers.ok ? referrers.data : [],
    error: [views, clones, referrers].filter(x => !x.ok).map(x => x.error).join("; ") || null
  };
} else {
  github.traffic = {
    status: "needs_token", views: [], totalViews: null, uniqueVisitors: null,
    clones: [], totalClones: null, uniqueCloners: null, referrers: [],
    error: token ? (github.error || "Repository metadata unavailable") : "Configure GH_TRAFFIC_TOKEN with repository Administration: read permission."
  };
}

const data = {
  schemaVersion: 2, generatedAt, repository, firefox, edge,
  github
};
await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(path.join(outDir, "stats.json"), JSON.stringify(data, null, 2) + "\n", "utf8");

const cards = [
  ["FIREFOX DAILY USERS", fmt(firefox.averageDailyUsers), "Average daily users · AMO"],
  ["FIREFOX WEEKLY DOWNLOADS", fmt(firefox.weeklyDownloads), "Rolling weekly total · AMO"],
  ["GITHUB VIEWS · 14 DAYS", fmt(github.traffic.totalViews), github.traffic.status === "available" ? fmt(github.traffic.uniqueVisitors) + " unique visitors" : "Requires GH_TRAFFIC_TOKEN"],
  ["GITHUB CLONES · 14 DAYS", fmt(github.traffic.totalClones), github.traffic.status === "available" ? fmt(github.traffic.uniqueCloners) + " unique cloners" : "Requires GH_TRAFFIC_TOKEN"],
  ["GITHUB STARS", fmt(github.stars), "Public repository metadata"],
  ["EDGE ACTIVE USERS", fmt(edge.activeInstallCount), "Public listing metadata; may be unavailable"],
  ["EDGE RATING", edge.rating === null ? "Unavailable" : String(edge.rating), edge.ratingCount === null ? "Public listing rating" : fmt(edge.ratingCount) + " ratings"]
];
const cardSvg = cards.map((c, i) => {
  const x = 18 + (i % 3) * 300;
  const y = 86 + Math.floor(i / 3) * 136;
  return '<g><rect x="' + x + '" y="' + y + '" width="282" height="118" rx="14" fill="#151b27" stroke="#30394b"/><text x="' + (x+18) + '" y="' + (y+25) + '" font-size="11" letter-spacing="1.1" fill="#9ca9bd">' + xml(c[0]) + '</text><text x="' + (x+18) + '" y="' + (y+65) + '" font-size="25" font-weight="700" fill="#f2f5fb">' + xml(c[1]) + '</text><text x="' + (x+18) + '" y="' + (y+91) + '" font-size="12" fill="#a9b5c8">' + xml(c[2]) + '</text></g>';
}).join("");
const stamp = generatedAt.replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="920" height="526" viewBox="0 0 920 526" role="img" aria-labelledby="title desc"><title id="title">Volume Control live statistics</title><desc id="desc">Firefox usage, GitHub traffic and repository activity. Last refreshed ' + xml(generatedAt) + '.</desc><rect width="100%" height="100%" rx="20" fill="#0b0f17"/><text x="22" y="34" font-size="22" font-weight="700" fill="#f2f5fb">Volume Control · Live statistics</text><text x="22" y="58" font-size="12" fill="#a9b5c8">Updated ' + xml(stamp) + ' · GitHub traffic covers the last 14 days</text>' + cardSvg + '<text x="22" y="365" font-size="11" fill="#9ca9bd">Edge public listing data may be incomplete. Weekly users, daily installs and impressions require Partner Center analytics.</text></svg>\n';
await fs.writeFile(path.join(outDir, "stats.svg"), svg, "utf8");
console.log(JSON.stringify({ generatedAt, firefox: firefox.status, githubMetadata: github.status, githubTraffic: github.traffic.status, edge: data.edge.status }, null, 2));
