import fs from "node:fs/promises";
import path from "node:path";

const outDir = path.join(process.cwd(), "docs");
const generatedAt = new Date().toISOString();
const repository = process.env.GITHUB_REPOSITORY || "Chaython/volumecontrol";
const amoSlug = process.env.AMO_ADDON_SLUG || "volume-control-boost-volume";
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

const [amoResult, repoResult] = await Promise.all([
  attempt(() => getJson("https://addons.mozilla.org/api/v5/addons/addon/" + encodeURIComponent(amoSlug) + "/")),
  attempt(() => getJson("https://api.github.com/repos/" + repository))
]);
const firefox = amoResult.ok ? {
  status: "available",
  addonName: amoResult.data.name?.["en-US"] || amoResult.data.name || "Volume Control",
  averageDailyUsers: numeric(amoResult.data.average_daily_users),
  weeklyDownloads: numeric(amoResult.data.weekly_downloads),
  rating: numeric(amoResult.data.ratings?.average),
  url: "https://addons.mozilla.org/en-US/firefox/addon/" + amoSlug + "/"
} : { status: "unavailable", error: amoResult.error, averageDailyUsers: null, weeklyDownloads: null, url: "https://addons.mozilla.org/en-US/firefox/addon/" + amoSlug + "/" };

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
  schemaVersion: 1, generatedAt, repository, firefox,
  chrome: {
    status: "not_available_via_public_api", weeklyUsers: null,
    message: "The supported Chrome Web Store API manages listings and publishing; it does not expose publisher analytics. No public stats API is available for weekly users.",
    dashboardUrl: "https://chrome.google.com/webstore/devconsole/"
  },
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
  ["CHROME WEB STORE", "Dashboard only", "No supported public analytics API"]
];
const cardSvg = cards.map((c, i) => {
  const x = 18 + (i % 3) * 300;
  const y = 86 + Math.floor(i / 3) * 136;
  return '<g><rect x="' + x + '" y="' + y + '" width="282" height="118" rx="14" fill="#151b27" stroke="#30394b"/><text x="' + (x+18) + '" y="' + (y+25) + '" font-size="11" letter-spacing="1.1" fill="#9ca9bd">' + xml(c[0]) + '</text><text x="' + (x+18) + '" y="' + (y+65) + '" font-size="25" font-weight="700" fill="#f2f5fb">' + xml(c[1]) + '</text><text x="' + (x+18) + '" y="' + (y+91) + '" font-size="12" fill="#a9b5c8">' + xml(c[2]) + '</text></g>';
}).join("");
const stamp = generatedAt.replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="920" height="390" viewBox="0 0 920 390" role="img" aria-labelledby="title desc"><title id="title">Volume Control live statistics</title><desc id="desc">Firefox usage, GitHub traffic and repository activity. Last refreshed ' + xml(generatedAt) + '.</desc><rect width="100%" height="100%" rx="20" fill="#0b0f17"/><text x="22" y="34" font-size="22" font-weight="700" fill="#f2f5fb">Volume Control · Live statistics</text><text x="22" y="58" font-size="12" fill="#a9b5c8">Updated ' + xml(stamp) + ' · GitHub traffic covers the last 14 days</text>' + cardSvg + '<text x="22" y="365" font-size="11" fill="#9ca9bd">Chrome Web Store analytics require publisher-dashboard access. Unavailable metrics are never estimated.</text></svg>\n';
await fs.writeFile(path.join(outDir, "stats.svg"), svg, "utf8");
console.log(JSON.stringify({ generatedAt, firefox: firefox.status, githubMetadata: github.status, githubTraffic: github.traffic.status, chrome: data.chrome.status }, null, 2));
