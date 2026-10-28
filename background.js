importScripts("api.js");

/*
 * Toolbar icon opens the dashboard in the side panel (Chrome 114+). When this
 * succeeds, action.onClicked no longer fires — the panel opens instead — so the
 * listener below is only a fallback for builds without the sidePanel API.
 */
chrome.sidePanel
  ?.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.warn("[upwork-simple] side panel unavailable", err));

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

/* ── Capturing the job-details bearer ──
 *
 * No cookie in the jar carries the scopes gql-query-get-auth-job-details-v2
 * wants — measured, not assumed; see AUTH_TOKEN_COOKIE_NAMES in api.js. But
 * Upwork's own job page sends a bearer that does, on every open. So rather
 * than guess where that token comes from, the worker watches the gateway
 * requests Upwork's pages make and keeps the Authorization value it sees.
 *
 * Observe-only: nothing is blocked, modified or redirected. Requests from this
 * extension are skipped by initiator, or it would capture the very cookie
 * tokens it is in the middle of trying and mistake them for a working one.
 */
let captureChain = Promise.resolve();

function rememberCapturedAuth(token, alias, tenant) {
  /* Serialised: two page requests in the same tick must not race the
     read-modify-write and drop one another's entry. */
  captureChain = captureChain
    .then(async () => {
      const key = UpworkApi.CAPTURED_AUTH_KEY;
      const held = (await chrome.storage.session.get(key))[key] || {};
      const now = Date.now();

      /*
       * The tenant is stored WITH the token it was sent beside, never merged
       * into a single "current org". A bearer is minted for one organization,
       * and pairing it with an org id from somewhere else is refused outright:
       *
       *   Authorization failed: provided tenant (organization) id could not
       *   be found in users tenants
       *
       * which arrives as a bare 403 and reads exactly like an expired token.
       */
      const entry = { token, alias, tenant: tenant || null, at: now };
      const next = { ...held, latest: entry };
      if (alias === UpworkApi.AUTH_ALIAS) next.details = entry;

      await chrome.storage.session.set({ [key]: next });
    })
    .catch((err) => console.warn("[upwork-simple] could not store captured token", err));
}

chrome.webRequest?.onBeforeSendHeaders.addListener(
  (details) => {
    /* Upwork's pages only. Our own fetches show a chrome-extension:// initiator. */
    if (!/^https:\/\/([a-z0-9-]+\.)?upwork\.com$/i.test(details.initiator || "")) return;

    const find = (name) =>
      details.requestHeaders?.find((h) => h.name.toLowerCase() === name)?.value;

    const bearer = find("authorization")?.match(/oauth2v2_[A-Za-z0-9_]+/)?.[0];
    if (!bearer) return;

    /* The org this very request was made as — the half that was missing. */
    const tenant = find("x-upwork-api-tenantid");

    let alias = "";
    try {
      alias = new URL(details.url).searchParams.get("alias") || "";
    } catch {
      // A URL Chrome handed us cannot really be malformed; keep the empty alias.
    }

    rememberCapturedAuth(bearer, alias, tenant);
  },
  { urls: ["https://www.upwork.com/api/graphql/v1*"], types: ["xmlhttprequest"] },
  ["requestHeaders", "extraHeaders"]
);

/* ── Capturing the queries Upwork's pages send ──
 *
 * The bearer above is half of a request; the query is the other half. Every
 * field shape in api.js that was guessed rather than read off a real request
 * has turned out wrong, and every one read off a capture has worked — so the
 * worker also keeps the body of each distinct alias it sees Upwork's own pages
 * send: the GraphQL document, the operation name and the variables. That turns
 * "open the page and paste the request" into a button in Settings, and is how
 * the next field — a hired freelancer's profile, say — gets its real query.
 *
 * Observe-only, bounded, memory-only (storage.session), never sent anywhere.
 * One entry per alias, newest wins.
 */
const CAPTURE_MAX_ALIASES = 40;
const CAPTURE_MAX_QUERY = 8000;

/* A JSON POST arrives as raw UTF-8 chunks; batched requests as an array. */
function decodeGraphqlBody(requestBody) {
  const parts = requestBody?.raw;
  if (!parts?.length) return null;
  try {
    const decoder = new TextDecoder();
    const text = parts.map((p) => (p.bytes ? decoder.decode(p.bytes) : "")).join("");
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed[0] ?? null : parsed;
  } catch {
    return null;
  }
}

/*
 * Variable VALUES are what make a captured query replayable — a profile query
 * is useless without knowing it takes { profileKey: "~01…" }. Short scalars
 * are kept; anything long, nested, or token-shaped is replaced by its type.
 */
function redactVariables(variables) {
  const out = {};
  for (const [key, value] of Object.entries(variables || {})) {
    const scalar = ["string", "number", "boolean"].includes(typeof value);
    const text = scalar ? String(value) : "";
    out[key] =
      scalar && text.length <= 80 && !/oauth2v2_|token/i.test(text)
        ? value
        : `<${Array.isArray(value) ? "array" : value === null ? "null" : typeof value}>`;
  }
  return out;
}

/* Which page fired it — the profile page, the job page — so an alias can be
   told apart from the forty others by where it came from. */
async function pageOfTab(tabId) {
  if (tabId === undefined || tabId < 0) return null;
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab?.url ? new URL(tab.url).pathname : null;
  } catch {
    return null;
  }
}

function rememberCapturedQuery(alias, body, tabId) {
  /* Same serialised chain as the bearer — see rememberCapturedAuth. */
  captureChain = captureChain
    .then(async () => {
      const query = typeof body?.query === "string" ? body.query : null;
      if (!query) return;

      const key = UpworkApi.CAPTURED_QUERIES_KEY;
      const held = (await chrome.storage.session.get(key))[key] || {};

      held[alias] = {
        alias,
        at: Date.now(),
        page: await pageOfTab(tabId),
        operation: body.operationName ?? null,
        variables: redactVariables(body.variables),
        /* A job-details document runs to 6KB; anything past the cap is
           fragments the visible half already names. */
        query: query.length > CAPTURE_MAX_QUERY ? `${query.slice(0, CAPTURE_MAX_QUERY)}…` : query,
      };

      /* Newest kept, oldest out, once over the cap. */
      const kept = Object.values(held)
        .sort((a, b) => b.at - a.at)
        .slice(0, CAPTURE_MAX_ALIASES);
      await chrome.storage.session.set({
        [key]: Object.fromEntries(kept.map((entry) => [entry.alias, entry])),
      });
    })
    .catch((err) => console.warn("[upwork-simple] could not store captured query", err));
}

chrome.webRequest?.onBeforeRequest.addListener(
  (details) => {
    /* Upwork's pages only — never this extension's own requests. */
    if (!/^https:\/\/([a-z0-9-]+\.)?upwork\.com$/i.test(details.initiator || "")) return;
    if (details.method !== "POST") return;

    let alias = "";
    try {
      alias = new URL(details.url).searchParams.get("alias") || "";
    } catch {
      return;
    }
    if (!alias) return;

    const body = decodeGraphqlBody(details.requestBody);
    if (body) rememberCapturedQuery(alias, body, details.tabId);
  },
  { urls: ["https://www.upwork.com/api/graphql/v1*"], types: ["xmlhttprequest"] },
  ["requestBody"]
);

let cachedLookup = { key: null, data: null };

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "upwork-simple:lookup") {
    (async () => {
      try {
        const input = String(message.input || "").trim();
        const jobId = UpworkApi.parseJobId(input);
        if (!jobId) {
          sendResponse({ ok: false, error: "Could not parse a job ID from that input." });
          return;
        }

        /*
         * Routed through lookupJob, which makes both calls and flattens them:
         * a manual lookup should still show client fields, and those no longer
         * come back from the activity query.
         *
         * Cached per mode as well as per input, because the two modes now
         * genuinely differ in what they fetch.
         */
        const key = `${message.mode || "details"}:${input}`;
        let data = null;
        if (cachedLookup.key === key && cachedLookup.data) {
          data = cachedLookup.data;
        } else {
          data = await UpworkApi.lookupJob(input, message.mode, input);
          if (data) cachedLookup = { key, data };
        }

        if (!data) {
          sendResponse({ ok: false, error: "No data returned." });
          return;
        }

        sendResponse({ ok: true, data });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || "Request failed." });
      }
    })();

    return true;
  }

  if (message?.type === "upwork-simple:checkNow") {
    /* The manual button means "refresh everything", static half included. */
    runCheckCycle({ refreshStatic: true }).then((result) => sendResponse(result ?? { ok: true }));
    return true;
  }

  if (message?.type === "upwork-simple:diagnose") {
    (async () => {
      const names = await UpworkApi.listUpworkCookieNames();
      const token = await UpworkApi.getVisitorTokenAsync();
      const found = UpworkApi.TOKEN_COOKIE_NAMES.filter((n) => names.includes(n));

      /*
       * Otherwise the signed-out banner only clears on the next full check
       * cycle. A user who fixes the token and immediately re-runs the
       * diagnostic would see "Ready" here while the banner above it still
       * claims checks are paused — same information, disagreeing.
       */
      if (token) await chrome.storage.local.remove(AUTH_ERROR_KEY);
      else await chrome.storage.local.set({ [AUTH_ERROR_KEY]: true });

      sendResponse({
        ok: true,
        cookieCount: names.length,
        tokenFound: Boolean(token),
        candidatesPresent: found,
        /* Names only — a live bearer token must not be rendered anywhere. */
        names,
      });
    })();

    return true;
  }

  /*
   * Asks the endpoint what its job fields are actually called. Needs a real
   * tracked job id, because every probe query is scoped to one.
   */
  if (message?.type === "upwork-simple:probeSchema") {
    (async () => {
      try {
        const token = await UpworkApi.getVisitorTokenAsync();
        if (!token) {
          sendResponse({ ok: false, error: "No search token — open the job search page first." });
          return;
        }

        const jobs = await loadTrackedJobs();
        const job = jobs[0];
        if (!job) {
          sendResponse({ ok: false, error: "Add a job first — the probe needs a real job id." });
          return;
        }

        sendResponse({
          ok: true,
          jobId: job.id,
          result: await UpworkApi.probeJobSchema(job.id, job.url, token),
        });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || "Probe failed." });
      }
    })();

    return true;
  }

  /*
   * The full job page — description, skills, terms, client profile, client
   * requirements — for the hover card. Fetched on demand rather than on a
   * schedule: it is display-only, so nothing needs it until a row is hovered.
   */
  if (message?.type === "upwork-simple:details") {
    (async () => {
      try {
        const jobId = UpworkApi.parseJobId(message.jobId || message.input);
        if (!jobId) {
          sendResponse({ ok: false, error: "Could not parse a job ID." });
          return;
        }

        const held = await loadJobDetails(jobId, message.url || null, Boolean(message.force));
        if (!held?.data) {
          /*
           * The endpoint's own words where we have them. A generic "open a job
           * page once" is the right remedy for a missing token and the wrong
           * one for a rejected field, and printing it for both is how a schema
           * problem ends up looking like a sign-in problem.
           */
          const reason = UpworkApi.getLastAuthError();
          sendResponse({
            ok: false,
            error: reason
              ? `Full details unavailable — ${reason}`
              : "Upwork would not return the full job details for this session. " +
                "Open a job page on upwork.com once, then hover again.",
          });
          return;
        }

        /* `at` travels with the payload so the dashboard's own freshness check
           ages a served-from-store copy from when it was FETCHED. */
        sendResponse({ ok: true, data: held.data, at: held.at });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || "Details request failed." });
      }
    })();

    return true;
  }

  /*
   * Why the hover card has no details. Runs the real request against a real
   * tracked job and reports every attempt — which cookie, which HTTP status,
   * which GraphQL error — so a missing session token can be told apart from a
   * field this endpoint's schema does not have.
   */
  /* The GraphQL documents Upwork's own pages have sent this session, by
     alias — see rememberCapturedQuery. `clear` empties the store. */
  /* Country and rate for the freelancers in a client's history — see
     lookupProfiles. Cached keys answer at once; the rest are fetched first. */
  /* What each past public job was posted at — see lookupJobPrices. */
  if (message?.type === "upwork-simple:jobPrices") {
    (async () => {
      try {
        const keys = Array.isArray(message.keys) ? message.keys : [];
        sendResponse({ ok: true, prices: await lookupJobPrices(keys) });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || "Price lookup failed." });
      }
    })();

    return true;
  }

  /*
   * Why a hired freelancer has no country or rate beside their name. Fetches
   * one profile page fresh and reports what came back, plus any GraphQL alias
   * Upwork's own profile page has been seen to send — which is the real
   * answer if the page's markup turns out to carry nothing.
   */
  if (message?.type === "upwork-simple:probeProfile") {
    (async () => {
      try {
        const key = UpworkApi.parseJobId(message.key || "")?.replace(/^~02/, "~01") ?? null;
        const useKey = /^~01[0-9a-f]+$/i.test(key || "") ? key : await anyHistoryProfileKey();
        if (!useKey) {
          sendResponse({
            ok: false,
            error:
              "No freelancer to probe with yet — open a tracked job whose client has hired before, " +
              "so a profile key is on record, then try again.",
          });
          return;
        }

        const report = await UpworkApi.probeFreelancerProfile(useKey);

        const queriesKey = UpworkApi.CAPTURED_QUERIES_KEY;
        const captured = (await chrome.storage.session.get(queriesKey))[queriesKey] || {};
        report.profileAliases = Object.values(captured)
          .filter((q) => /^\/freelancers\//.test(q.page || ""))
          .sort((a, b) => b.at - a.at);

        sendResponse({ ok: true, report });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || "Probe failed." });
      }
    })();

    return true;
  }

  if (message?.type === "upwork-simple:profiles") {
    (async () => {
      try {
        const keys = Array.isArray(message.keys) ? message.keys : [];
        sendResponse({ ok: true, profiles: await lookupProfiles(keys) });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || "Profile lookup failed." });
      }
    })();

    return true;
  }

  if (message?.type === "upwork-simple:capturedQueries") {
    (async () => {
      try {
        const key = UpworkApi.CAPTURED_QUERIES_KEY;
        if (message.clear) {
          await chrome.storage.session.remove(key);
          sendResponse({ ok: true, queries: [] });
          return;
        }
        const held = (await chrome.storage.session.get(key))[key] || {};
        sendResponse({
          ok: true,
          queries: Object.values(held).sort((a, b) => b.at - a.at),
        });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || "Could not read captured queries." });
      }
    })();

    return true;
  }

  if (message?.type === "upwork-simple:probeDetails") {
    (async () => {
      try {
        const jobs = await loadTrackedJobs();
        const job = jobs.find((j) => j.id === message.jobId) || jobs[0];
        if (!job) {
          sendResponse({ ok: false, error: "Add a job first — the probe needs a real job id." });
          return;
        }

        sendResponse({
          ok: true,
          jobId: job.id,
          report: await UpworkApi.probeAuthDetails(job.id, job.url),
        });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || "Probe failed." });
      }
    })();

    return true;
  }

  /* One job, fired by the dashboard when that job's countdown reaches zero. */
  if (message?.type === "upwork-simple:checkJob") {
    runCheckCycle({ jobIds: [message.jobId] }).then((result) =>
      sendResponse(result ?? { ok: true })
    );
    return true;
  }

  if (message?.type === "upwork-simple:title") {
    (async () => {
      try {
        const input = String(message.input || "").trim();
        const jobId = UpworkApi.parseJobId(input);
        if (!jobId) {
          sendResponse({ ok: false, title: null });
          return;
        }
        sendResponse({ ok: true, title: await UpworkApi.fetchJobTitle(jobId, input) });
      } catch {
        sendResponse({ ok: false, title: null });
      }
    })();

    return true;
  }
});

/* ── Tracked-job monitoring ── */

const TRACKED_JOBS_KEY = "trackedJobs";
const ACTIVITY_LOG_KEY = "activityLog";
const AUTH_ERROR_KEY = "authError";
const CHECK_ALARM = "upwork-simple:check";
const MAX_LOG_ENTRIES = 300;

/*
 * Refresh rate follows how hot the client is: someone who looked a minute ago
 * is at their desk now, so poll fast; someone who looked yesterday will not
 * move in the next ten seconds. Each job recomputes its own tier after every
 * check, so a job accelerates the moment a fresh view lands and decays again
 * when the client goes quiet.
 *
 * Chrome clamps alarms to a 1-minute minimum, so the sub-minute tiers only
 * apply while a dashboard is open to drive them; the alarm is a catch-up sweep.
 */
const CHECK_TIERS = [
  { maxAgeMs: 5 * 60000, intervalMs: 5000 },
  { maxAgeMs: 10 * 60000, intervalMs: 10000 },
  { maxAgeMs: 30 * 60000, intervalMs: 30000 },
  { maxAgeMs: 12 * 3600000, intervalMs: 45000 },
];
const DEFAULT_INTERVAL_MS = 60000;

/*
 * How long a calm-tier "was → now" marker stays on screen. Deliberately a wall
 * clock window, not "until the next check": with adaptive polling a hot job
 * checks every 5s, which would wipe the marker before it could be read.
 * Priority-tier alerts are unaffected — they persist until dismissed.
 */
const MARKER_TTL_MS = 120000;

/* Static data is refreshed at most this often on its own. */
const STATIC_TTL_MS = 86400000;

/*
 * Static data is fetched when a job has none yet, when it is a day stale, or
 * when the user pressed "check all jobs now" — that button is the explicit
 * "get me the freshest of everything" gesture, so it refreshes both halves.
 * A tier tick never does.
 */
function wantsStatic(job, forced) {
  if (!job.client && !job.meta) return true;
  if (forced) return true;
  return Date.now() - (job.staticAt ?? 0) > STATIC_TTL_MS;
}

function intervalFor(job) {
  const seenAt = viewedAt(job.lastStats);
  if (seenAt === null) return DEFAULT_INTERVAL_MS;

  /* Clamped at 0 so clock skew reads as "just viewed", not as a stale job. */
  const age = Math.max(0, Date.now() - seenAt);
  const tier = CHECK_TIERS.find((t) => age < t.maxAgeMs);
  return tier ? tier.intervalMs : DEFAULT_INTERVAL_MS;
}

/* Milliseconds of a stats object's last-viewed reading, or null if unusable. */
function viewedAt(stats) {
  if (!stats?.lastViewedRaw) return null;
  const ms = new Date(stats.lastViewedRaw).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/*
 * Keeps the stored last-viewed reading as a high-water mark.
 *
 * Upwork's GraphQL endpoint is load balanced and its replicas can lag, so
 * lastBuyerActivity intermittently comes back OLDER than a value we already
 * hold and then flips forward again on the next poll. Because the old code
 * overwrote lastStats with whichever reading arrived last, every flip forward
 * looked like a brand-new client view: a red alert and a "Client viewed"
 * notification, on repeat, every few seconds on a fast tier. The visible
 * symptom is the time flapping between two values — "35m ago" to "1h ago" and
 * back — which is not the client doing anything at all.
 *
 * Discarding the older reading breaks that loop: the value never regresses, so
 * the fresher one can never look new again. A real view is strictly newer than
 * anything seen so far and still gets through untouched.
 */
function clampLastViewed(job, summary) {
  const prevAt = viewedAt(job.lastStats);
  const nextAt = viewedAt(summary);
  if (prevAt === null || nextAt === null || nextAt > prevAt) return;

  summary.lastViewedRaw = job.lastStats.lastViewedRaw;
  summary.lastViewed = job.lastStats.lastViewed;
}

/*
 * `priority` fields raise a sticky red alert that survives later checks and
 * restarts until the user dismisses it. Everything else gets the transient
 * marker that clears when the next check starts.
 *
 * `alertOn: "increase"` means only an upward move is alarming — a withdrawn
 * invite still reaches the Activity Log, just without the alert.
 */
const TRACKED_FIELDS = [
  { key: "proposals", label: "Proposals" },
  { key: "interviewing", label: "Interviewing", priority: true, alertOn: "increase" },
  { key: "invitesSent", label: "Invites sent", priority: true, alertOn: "increase" },
  /* Boolean, so no direction rule: losing or gaining verification both matter. */
  {
    key: "paymentVerified",
    label: "Payment",
    priority: true,
    format: (v) => (v ? "Verified" : "Unverified"),
  },
  { key: "unansweredInvites", label: "Unanswered invites" },
  /* Any direction: a hire on a job you bid on is decisive either way. */
  { key: "hires", label: "Hired", priority: true },
];

let checkInFlight = null;

/*
 * Created at top level, not only in onInstalled/onStartup: neither event fires
 * when the service worker simply wakes from idle, which otherwise leaves the
 * extension with no alarm at all and no periodic checks. Re-creating an alarm
 * with the same name just replaces it, so this is safe to run on every wake.
 */
chrome.alarms.create(CHECK_ALARM, { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => {
  /* Safety net for when no dashboard is open to drive the per-job schedule. */
  if (alarm.name === CHECK_ALARM) void runCheckCycle({ dueOnly: true });
});

async function loadTrackedJobs() {
  const stored = await chrome.storage.local.get(TRACKED_JOBS_KEY);
  return Array.isArray(stored[TRACKED_JOBS_KEY]) ? stored[TRACKED_JOBS_KEY] : [];
}

/*
 * Fields a check owns. Everything else on a job — its position in the list,
 * name, draft, tag, applied, paused — belongs to the user.
 */
const CYCLE_FIELDS = [
  "lastStats",
  "lastError",
  "lastChecked",
  "checkIntervalMs",
  "nextCheckAt",
  "changes",
  "changedAt",
  "moved",
  "client",
  "meta",
  "staticAt",
];

/*
 * Writes back only what the cycle changed, onto whatever is in storage now.
 *
 * A cycle loads the job list, then awaits a network round trip per job — on a
 * slow tier that is several seconds. Writing the whole loaded array back at the
 * end silently discarded anything the user did in that window: a card dragged
 * to a new position snapped back, a pause un-paused itself, a rename reverted.
 * Mapping over the STORED list instead means order and user fields come from
 * storage and only check results come from the cycle.
 */
async function mergeSaveJobs(updated) {
  const byId = new Map(updated.map((job) => [job.id, job]));
  const stored = await loadTrackedJobs();

  const merged = stored.map((job) => {
    const fresh = byId.get(job.id);
    if (!fresh) return job;

    const next = { ...job };
    for (const key of CYCLE_FIELDS) {
      if (key in fresh) next[key] = fresh[key];
    }

    /* Only when this check actually raised one, so an alert the user dismissed
       mid-cycle is not restored from the stale copy. */
    if (fresh.alertsTouched) next.alerts = fresh.alerts;

    delete next.alertsTouched;
    return next;
  });

  await saveTrackedJobs(merged);
}

async function saveTrackedJobs(jobs) {
  await chrome.storage.local.set({ [TRACKED_JOBS_KEY]: jobs });
}

/* ── Hired freelancers' profiles ──
 *
 * The "(India • $10/hr)" behind each name in a client's history. The rate is
 * already in the job payload; the country needs the freelancer's profile page
 * — see fetchFreelancerProfile in api.js. Profiles drift over weeks, so a hit
 * is kept for one; a miss is retried sooner, in case the page was slow or
 * challenged that once. Bounded parallelism, because a client with twelve
 * hires must not open twelve pages at once.
 */
const FREELANCER_PROFILES_KEY = "freelancerProfiles";
const PROFILE_TTL_MS = 7 * 86400000;
const PROFILE_MISS_TTL_MS = 86400000;
const PROFILE_MAX_ENTRIES = 300;

/*
 * Bumped whenever the profile parser changes. A miss cached under the old
 * parser is not evidence about the new one, and without this a fixed parser
 * would sit behind a day of remembered failures.
 *
 * 2 — headline-rate reading from visible markup added.
 */
const PROFILE_PARSER_VERSION = 2;

/* A past job's posted price never changes once it is posted. */
const PAST_JOB_PRICES_KEY = "pastJobPrices";
const JOB_PRICE_TTL_MS = 30 * 86400000;
const JOB_PRICE_MISS_TTL_MS = 86400000;
const JOB_PRICE_MAX_ENTRIES = 500;

const LOOKUP_CONCURRENCY = 2;

/*
 * One lookup per key, however many slides ask while it is in the air; a
 * bounded number in flight at once, because a client with twelve hires must
 * not open twelve pages together. Shared by the profile and the posted-price
 * caches, which differ only in what they fetch and how long they keep it.
 */
const lookupsInFlight = new Map();

async function lookupWithCache({ storageKey, keys, valid, fetchOne, ttl, missTtl, maxEntries, version }) {
  const stored = await chrome.storage.local.get(storageKey);
  const store =
    stored[storageKey] && typeof stored[storageKey] === "object" ? stored[storageKey] : {};

  const fresh = (entry) =>
    Boolean(entry) &&
    (entry.v ?? 1) === version &&
    Date.now() - (entry.at ?? 0) < (entry.data ? ttl : missTtl);

  const wanted = [...new Set(keys.filter((k) => valid.test(String(k))))];
  const queue = wanted.filter((k) => !fresh(store[k]));
  const fetchedAny = queue.length > 0;

  const workers = Array.from({ length: LOOKUP_CONCURRENCY }, async () => {
    while (queue.length) {
      const key = queue.shift();
      const flightKey = `${storageKey}:${key}`;
      let pending = lookupsInFlight.get(flightKey);
      if (!pending) {
        pending = fetchOne(key).finally(() => lookupsInFlight.delete(flightKey));
        lookupsInFlight.set(flightKey, pending);
      }
      store[key] = { data: (await pending) ?? null, at: Date.now(), v: version };
    }
  });
  await Promise.all(workers);

  if (fetchedAny) {
    /* Newest kept, oldest out, once over the cap. */
    const kept = Object.entries(store)
      .sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))
      .slice(0, maxEntries);
    await chrome.storage.local.set({ [storageKey]: Object.fromEntries(kept) });
  }

  return Object.fromEntries(wanted.map((k) => [k, store[k]?.data ?? null]));
}

const lookupProfiles = (keys) =>
  lookupWithCache({
    storageKey: FREELANCER_PROFILES_KEY,
    keys,
    valid: /^~01[0-9a-f]+$/i,
    fetchOne: (key) => UpworkApi.fetchFreelancerProfile(key),
    ttl: PROFILE_TTL_MS,
    missTtl: PROFILE_MISS_TTL_MS,
    maxEntries: PROFILE_MAX_ENTRIES,
    version: PROFILE_PARSER_VERSION,
  });

const lookupJobPrices = (keys) =>
  lookupWithCache({
    storageKey: PAST_JOB_PRICES_KEY,
    keys,
    valid: /^~02[0-9a-f]+$/i,
    fetchOne: (key) => UpworkApi.fetchPastJobPrice(key),
    ttl: JOB_PRICE_TTL_MS,
    missTtl: JOB_PRICE_MISS_TTL_MS,
    maxEntries: JOB_PRICE_MAX_ENTRIES,
    version: 1,
  });

/*
 * A profile key to probe with, when the caller has none: the first freelancer
 * in any tracked job's history. The details store is keyed by job.
 */
async function anyHistoryProfileKey() {
  const store = await loadDetailsStore();
  for (const held of Object.values(store)) {
    const key = held?.data?.history?.find((row) => row?.profile)?.profile;
    if (key) return key;
  }
  return null;
}

/* ── Full job details, on demand ── */

/*
 * Kept under its own storage key rather than on the job record, and for the
 * same reason mergeSaveJobs exists: a hover can land in the middle of a check
 * cycle, and a read-modify-write of the whole job list from over here would
 * put back the lastStats the cycle had just moved on from. Separate keys
 * cannot collide.
 */
const JOB_DETAILS_KEY = "jobDetails";

/*
 * Half an hour. Almost everything in this payload — description, skills,
 * budget, the client's history — either cannot change or changes over days, so
 * a tighter window would buy nothing. The counters that DO move fast are read
 * from the polling query, not from here.
 */
const DETAILS_TTL_MS = 30 * 60000;

/* One request per job, however many hovers land while it is in the air. */
const detailsInFlight = new Map();

async function loadDetailsStore() {
  const stored = await chrome.storage.local.get(JOB_DETAILS_KEY);
  const store = stored[JOB_DETAILS_KEY];
  return store && typeof store === "object" ? store : {};
}

async function persistDetails(jobId, details) {
  const store = await loadDetailsStore();
  store[jobId] = { data: details, at: Date.now() };

  /*
   * Each payload is a few KB, so the store is swept on every write: a job the
   * user has removed has no reason to keep a description in storage. The job
   * just written is exempt, since a Lookup can ask about an untracked one.
   */
  const tracked = new Set((await loadTrackedJobs()).map((job) => job.id));
  for (const id of Object.keys(store)) {
    if (id !== jobId && !tracked.has(id)) delete store[id];
  }

  await chrome.storage.local.set({ [JOB_DETAILS_KEY]: store });
}

async function loadJobDetails(jobId, jobUrl, force = false) {
  const held = (await loadDetailsStore())[jobId] ?? null;
  if (!force && held?.data && Date.now() - (held.at ?? 0) < DETAILS_TTL_MS) {
    return { data: held.data, at: held.at ?? 0 };
  }

  const pending = detailsInFlight.get(jobId);
  if (pending) return pending;

  const work = (async () => {
    const url = jobUrl || (await loadTrackedJobs()).find((j) => j.id === jobId)?.url || null;
    const data = await UpworkApi.fetchJobAuthDetails(jobId, url);
    if (data) {
      await persistDetails(jobId, data);
      return { data, at: Date.now() };
    }
    /* Failed, and we hold an older copy: stale detail beats an empty card. */
    return held?.data ? { data: held.data, at: held.at ?? 0 } : null;
  })().finally(() => detailsInFlight.delete(jobId));

  detailsInFlight.set(jobId, work);
  return work;
}

async function appendLogEntries(entries) {
  if (!entries.length) return;
  const stored = await chrome.storage.local.get(ACTIVITY_LOG_KEY);
  const log = Array.isArray(stored[ACTIVITY_LOG_KEY]) ? stored[ACTIVITY_LOG_KEY] : [];
  const next = [...entries, ...log].slice(0, MAX_LOG_ENTRIES);
  await chrome.storage.local.set({ [ACTIVITY_LOG_KEY]: next });
}

/*
 * Returns the permanent log entries plus `changes`: a map of field → the value
 * it held before this check. The dashboard renders those as the struck-through
 * "was" figure, and they are cleared again when the next check starts.
 */
function diffJob(job, summary) {
  const prev = job.lastStats;
  if (!prev) return { entries: [], changes: null, alerts: null };

  const entries = [];
  const changes = {};
  const alerts = {};
  /*
   * Every field that moved on THIS check, regardless of tier, with its raw
   * previous value. Transient like `changes` — it exists only for the render
   * right after a check, so the delta badge fires once per actual movement
   * instead of replaying while a sticky alert stays undismissed.
   */
  const moved = {};
  const now = new Date().toISOString();
  const label = job.name || job.url || job.id;

  for (const { key, label: eventLabel, priority, alertOn, format } of TRACKED_FIELDS) {
    const was = prev[key];
    const val = summary[key];
    if (was === null || was === undefined || val === null || val === undefined) continue;
    /* Compared raw, displayed formatted — booleans must not surface as true/false. */
    if (val === was) continue;

    const fmt = format || ((v) => v);
    entries.push({
      time: now,
      jobId: job.id,
      jobName: label,
      event: eventLabel,
      was: fmt(was),
      now: fmt(val),
    });

    moved[key] = was;

    const increased = typeof val === "number" && typeof was === "number" && val > was;
    if (priority && (alertOn !== "increase" || increased)) alerts[key] = fmt(was);
    else changes[key] = fmt(was);
  }

  /*
   * Compared as instants and only ever forwards. Two separate reasons:
   *
   *  · the display string is derived, so "55m ago" ticks to "56m ago" on its
   *    own and would read as a change on every render;
   *  · the string form of the same instant is not stable either, so a plain
   *    `!==` reported a change when nothing had actually moved.
   *
   * clampLastViewed has already discarded any reading older than what we hold,
   * so anything newer here is a genuine new view.
   */
  const prevSeenAt = viewedAt(prev);
  const nextSeenAt = viewedAt(summary);

  if (prevSeenAt !== null && nextSeenAt !== null && nextSeenAt > prevSeenAt) {
    /* Re-derived from the raw value, not read from prev.lastViewed: that string
       was formatted at the previous check and is stale by now. */
    const wasText = UpworkApi.formatRelativeTime(prev.lastViewedRaw) ?? "—";

    entries.push({
      time: now,
      jobId: job.id,
      jobName: label,
      event: "Viewed",
      was: wasText,
      now: summary.lastViewed ?? "—",
    });

    alerts.lastViewed = wasText;
  }

  return {
    entries,
    changes: Object.keys(changes).length ? changes : null,
    alerts: Object.keys(alerts).length ? alerts : null,
    moved: Object.keys(moved).length ? moved : null,
  };
}

/* Spreads any unscheduled job across its own window so countdowns stay distinct. */
function ensureSchedule(jobs) {
  const now = Date.now();
  /* A paused job gets no deadline — it would go stale and fire the moment it
     resumed, or make the alarm sweep pick it up as overdue. */
  const pending = jobs.filter((job) => !job.nextCheckAt && !job.paused);
  if (!pending.length) return false;

  pending.forEach((job, i) => {
    const interval = job.checkIntervalMs || intervalFor(job);
    job.checkIntervalMs = interval;
    job.nextCheckAt = now + Math.round(((i + 1) * interval) / (pending.length + 1));
  });
  return true;
}

/* ── Notifications ── */

/*
 * Which events notify, and how often, is user-controlled from the Settings tab.
 * `throttleMs: 0` means every event notifies — noise accepted deliberately.
 */
const SETTINGS_KEY = "settings";

const DEFAULT_SETTINGS = {
  notifyEnabled: true,
  throttleMs: 10000,
  notify: {
    lastViewed: true,
    interviewing: true,
    invitesSent: true,
    hires: true,
    paymentVerified: true,
    proposals: true,
    unansweredInvites: false,
  },
};

/*
 * Two ledgers, kept separate even when the throttle value is shared. With one
 * ledger, proposals — which climb constantly — would claim the throttle and
 * silently suppress a "client viewed" seconds later: the noisiest signal
 * blocking the most decisive one.
 */
const lastCriticalAt = new Map();
const lastCalmAt = new Map();

let settingsCache = null;

async function getSettings() {
  if (settingsCache) return settingsCache;
  const stored = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || {};
  settingsCache = {
    ...DEFAULT_SETTINGS,
    ...stored,
    notify: { ...DEFAULT_SETTINGS.notify, ...(stored.notify || {}) },
  };
  return settingsCache;
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes[SETTINGS_KEY]) settingsCache = null;
});

async function notifyJob(job, alerts, moved, summary) {
  const settings = await getSettings();
  if (!settings.notifyEnabled) return;

  const now = Date.now();
  const gain = (key) => {
    const was = moved?.[key];
    const val = summary[key];
    return typeof was === "number" && typeof val === "number" ? val - was : null;
  };
  const has = (key) => alerts[key] !== undefined && alerts[key] !== null;

  const events = [];
  const add = (key, text, critical) => events.push({ key, text, critical });

  if (has("lastViewed")) add("lastViewed", "Client viewed", true);

  const interviewing = gain("interviewing");
  if (has("interviewing") && interviewing) {
    add("interviewing", `+${interviewing} interviewing`, true);
  }

  const invites = gain("invitesSent");
  if (has("invitesSent") && invites) {
    add("invitesSent", `+${invites} invite${invites === 1 ? "" : "s"}`, true);
  }

  const hired = gain("hires");
  if (has("hires") && hired) {
    add("hires", hired > 0 ? `+${hired} hired` : `${hired} hired`, true);
  }

  if (has("paymentVerified")) {
    add(
      "paymentVerified",
      summary.paymentVerified ? "Payment now verified" : "Payment now unverified",
      true
    );
  }

  const proposals = gain("proposals");
  if (proposals > 0) add("proposals", `+${proposals} proposal${proposals === 1 ? "" : "s"}`, false);

  const unanswered = gain("unansweredInvites");
  if (unanswered) {
    add("unansweredInvites", `${unanswered > 0 ? "+" : ""}${unanswered} unanswered`, false);
  }

  const allowed = events.filter((e) => settings.notify[e.key]);
  if (!allowed.length) return;

  const isCritical = allowed.some((e) => e.critical);
  const seen = isCritical ? lastCriticalAt : lastCalmAt;

  if (settings.throttleMs > 0) {
    if (now - (seen.get(job.id) || 0) < settings.throttleMs) return;
    seen.set(job.id, now);
  }

  /* Critical first, so the decisive news leads the message. */
  const parts = [
    ...allowed.filter((e) => e.critical).map((e) => e.text),
    ...allowed.filter((e) => !e.critical).map((e) => e.text),
  ];

  /*
   * With throttling off, each notification needs a unique id — a shared id
   * replaces the previous popup, which would hide the very events the user
   * turned throttling off to see.
   */
  const id = settings.throttleMs > 0 ? `job:${job.id}` : `job:${job.id}:${now}`;

  /*
   * The tag leads the events line, in half-round brackets so it reads as a
   * chip rather than as another event — the popup has no styling of its own,
   * so the glyphs are all the separation there is. The title stays the job
   * name alone: it is what identifies the popup, and a tag in front of it
   * would push the name towards the truncation.
   *
   * The newline is a request, not a guarantee: on Windows this is handed to
   * the system toast renderer, which wraps the body on its own terms. Where it
   * is honoured the tag gets its own line; where it is not, the line reads as
   * it did before, tag first and then the events. Nothing breaks either way.
   */
  const tag = job.tag?.trim();
  const message = parts.join(" · ");

  chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: job.name || job.url || "Tracked job",
    message: tag ? `◖${tag}◗\n${message}` : message,
    priority: 2,
  });
}

chrome.notifications.onClicked.addListener((notificationId) => {
  /* Ids are "job:<id>" or, with throttling off, "job:<id>:<timestamp>". Job ids
     never contain a colon, so field 1 is always the id. */
  const jobId = notificationId.split(":")[1];
  if (notificationId.startsWith("job:") && jobId) {
    /* The dashboard reads this on load to scroll to and highlight the row. */
    chrome.storage.local.set({ focusJobId: jobId });
  }
  chrome.runtime.openOptionsPage();
  chrome.notifications.clear(notificationId);
});

async function checkOneJob(job, token, staticDue = false) {
  const entriesOut = [];
  /* Stamped outside the try so a failed job still records that it ran. */
  const stamp = new Date().toISOString();

  try {
    const details = await UpworkApi.fetchJobDetails(job.id, job.url, token);
    const summary = UpworkApi.summarizeJob(details);
    if (!summary) throw new Error("Upwork returned no data for this job.");

    /* Before the diff, so a lagging replica's stale reading is dropped rather
       than compared against — and never written back to lastStats. */
    clampLastViewed(job, summary);

    const { entries, changes, alerts, moved } = diffJob(job, summary);
    entriesOut.push(...entries);
    job.moved = moved;
    /* Only overwrite on a fresh movement, so an unchanged check does not reset
       the marker's clock — or wipe a marker that still has time left. */
    if (changes) {
      job.changes = changes;
      job.changedAt = Date.now();
    }
    /* Existing alert values win, so an undismissed alert keeps its original
       baseline: two jumps of 8→9→10 still read "8 → 10", the movement since
       the user last looked. */
    if (alerts) {
      job.alerts = { ...alerts, ...(job.alerts || {}) };
      job.alertsTouched = true;
    }

    /*
     * Called regardless of `alerts` so a calm-tier move (proposals) can notify
     * on its own. Driven by `alerts` and `moved`, both of which hold only what
     * changed on THIS check, so a standing undismissed alert cannot re-notify.
     */
    await notifyJob(job, alerts || {}, moved, summary);
    job.lastStats = summary;
    job.lastError = null;
  } catch (err) {
    job.lastError = err?.message || "Check failed.";
    /* Cookie present but rejected: surface it as the signed-out state too. */
    if (err?.code === "NO_AUTH") {
      await chrome.storage.local.set({ [AUTH_ERROR_KEY]: true });
    }
    console.warn("[upwork-simple] check failed for", job.id, err);
  }

  /*
   * Static data — client profile and job terms — on its own schedule and
   * outside the try above on purpose. fetchJobStatic never throws, so a
   * failure here must not mark the job as failed or trip the signed-out
   * banner the way a NO_AUTH from the polling query legitimately does.
   */
  if (wantsStatic(job, staticDue)) {
    job.staticAt = Date.now();
    const stat = await UpworkApi.fetchJobStatic(job.id, job.url, token);
    /* Only overwrite on success: a failed refresh must not blank a profile
       that was fetched fine yesterday. */
    if (stat?.client) job.client = stat.client;
    if (stat?.meta) job.meta = stat.meta;
  }

  job.lastChecked = stamp;
  /* Recomputed after lastStats is updated, so a view that just landed takes
     effect immediately rather than one cycle later. */
  job.checkIntervalMs = intervalFor(job);
  job.nextCheckAt = Date.now() + job.checkIntervalMs;
  return entriesOut;
}

/*
 * `jobIds` checks just those; `dueOnly` checks whatever is overdue (the alarm
 * sweep); neither checks everything (the manual button).
 */
async function runCheckCycle({ jobIds = null, dueOnly = false, refreshStatic = false } = {}) {
  if (checkInFlight) return checkInFlight;

  checkInFlight = (async () => {
    const jobs = await loadTrackedJobs();
    if (!jobs.length) return { ok: true, checked: 0 };

    /*
     * One cookie check gates the whole cycle. Without it, being signed out
     * means every tracked job fires its own doomed request — on a 5s tier that
     * is a dozen failing calls a minute per job, and a red error on every row
     * instead of one clear explanation.
     */
    let token = await UpworkApi.getVisitorTokenAsync();

    /*
     * No cookie at all. That used to be the end of it — banner up, checks
     * paused until the user went and opened the search page. Upwork's front
     * page hands out a visitor token to anyone who asks, so ask first and only
     * report a problem if even that comes back empty.
     */
    if (!token) token = await UpworkApi.refreshVisitorToken(null);

    if (!token) {
      await chrome.storage.local.set({ [AUTH_ERROR_KEY]: true });
      return { ok: false, error: "Signed out of Upwork — checks are paused." };
    }
    await chrome.storage.local.remove(AUTH_ERROR_KEY);

    const now = Date.now();
    let targets;
    if (jobIds) {
      /*
       * Named explicitly — the ring's double-click. Paused is not honoured
       * here on purpose: it means "stop polling", not "refuse a check I just
       * asked for", and a one-shot check does not resume the schedule.
       */
      targets = jobs.filter((job) => jobIds.includes(job.id));
    } else {
      /* Everything automatic, and "check all jobs now", leaves paused jobs be. */
      const live = jobs.filter((job) => !job.paused);
      targets = dueOnly ? live.filter((job) => !job.nextCheckAt || job.nextCheckAt <= now) : live;
    }

    /*
     * `moved` drives the one-shot delta badge, so it is always cleared. The
     * "was" marker instead expires on MARKER_TTL_MS, so a 5s-tier job does not
     * erase it seconds after it appears.
     */
    const stale = targets.filter(
      (job) => job.moved || (job.changes && now - (job.changedAt ?? 0) > MARKER_TTL_MS)
    );
    if (stale.length) {
      for (const job of stale) {
        job.moved = null;
        if (job.changes && now - (job.changedAt ?? 0) > MARKER_TTL_MS) job.changes = null;
      }
      await mergeSaveJobs(jobs);
    }

    /* Same `token` resolved by the gate above, reused for every job in this
       cycle — see the comment on gqlPost's `options.token` in api.js. */
    const newLogEntries = [];
    for (const job of targets) {
      newLogEntries.push(...(await checkOneJob(job, token, refreshStatic)));
    }

    ensureSchedule(jobs);
    await mergeSaveJobs(jobs);
    if (newLogEntries.length) await appendLogEntries(newLogEntries);
    return { ok: true, checked: targets.length };
  })()
    /* Catch before finally so a crashed cycle still reports instead of
       rejecting into a silent unhandled promise. */
    .catch((err) => {
      console.error("[upwork-simple] check cycle failed", err);
      return { ok: false, error: err?.message || "Check cycle failed." };
    })
    .finally(() => {
      checkInFlight = null;
    });

  return checkInFlight;
}
