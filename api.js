const UPWORK_GQL_DETAILS =
  "https://www.upwork.com/api/graphql/v1?alias=gql-query-get-visitor-job-details";

/*
 * The hot query — everything that actually moves, and nothing else. This runs
 * on every tier tick, as often as every 5 seconds per job, so it is kept as
 * small as it can be.
 *
 * isPaymentMethodVerified is a client field but belongs here: it is the one
 * buyer value that genuinely flips, and a change in it notifies.
 *
 * It also takes no $isLoggedIn variable, because none of these fields are
 * gated on it. That removes the login-flag half of gqlPost's retry matrix, so
 * a check makes at most half the attempts it used to.
 */
const JOB_ACTIVITY_QUERY = `
  query JobPubActivityQuery($id: ID!) {
    jobPubDetails(id: $id) {
      opening {
        clientActivity {
          lastBuyerActivity
          totalApplicants
          totalHired
          totalInvitedToInterview
          unansweredInvites
          invitationsSent
        }
      }
      buyerExtra { isPaymentMethodVerified }
    }
  }
`;

/*
 * The cold query — client profile and job terms. Fetched when a job is added,
 * then only on a manual "check all jobs now" or once a day, never on a tier
 * tick. Most of it cannot change at all (member since, price, duration, posted
 * date); the rest drifts over days, not seconds.
 *
 * Candidate shapes, tried in order, because the job-terms field names are
 * inferred from Upwork's public schema and this private endpoint may differ.
 * The LAST candidate is buyer-only and uses field paths already proven in
 * production, so an unrecognised job-terms field can never cost us the client
 * profile too.
 */
const JOB_STATIC_QUERIES = [
  /* Client profile + job terms, modern contractTerms shape. */
  `fragment BuyerFragment on JobPubBuyerInfo {
    location { city country }
    stats {
      totalAssignments
      activeAssignmentsCount
      hoursCount
      score
      totalJobsWithHires
      totalCharges { amount }
    }
    company { contractDate }
    jobs { openCount postedCount @include(if: $isLoggedIn) }
    avgHourlyJobsRate @include(if: $isLoggedIn) { amount }
  }
  query JobPubStaticQuery($id: ID!, $isLoggedIn: Boolean!) {
    jobPubDetails(id: $id) {
      buyer { ...BuyerFragment }
      opening {
        job {
          title
          contractorTier
          publishTime
          contractTerms {
            contractType
            fixedPriceContractTerms { amount { rawValue } }
            hourlyContractTerms {
              hourlyBudgetMin
              hourlyBudgetMax
              engagementDuration { label }
            }
          }
        }
      }
    }
  }`,
  /* Client profile + job terms, flat budget fields. */
  `fragment BuyerFragment on JobPubBuyerInfo {
    location { city country }
    stats {
      totalAssignments
      activeAssignmentsCount
      hoursCount
      score
      totalJobsWithHires
      totalCharges { amount }
    }
    company { contractDate }
    jobs { openCount postedCount @include(if: $isLoggedIn) }
    avgHourlyJobsRate @include(if: $isLoggedIn) { amount }
  }
  query JobPubStaticQuery($id: ID!, $isLoggedIn: Boolean!) {
    jobPubDetails(id: $id) {
      buyer { ...BuyerFragment }
      opening {
        job {
          title
          type
          durationLabel
          engagement
          contractorTier
          createdOn
          amount { amount }
          hourlyBudgetMin { amount }
          hourlyBudgetMax { amount }
        }
      }
    }
  }`,
  /* Fallback: client profile only. These paths are known to work. */
  `fragment BuyerFragment on JobPubBuyerInfo {
    location { city country }
    stats {
      totalAssignments
      activeAssignmentsCount
      hoursCount
      score
      totalJobsWithHires
      totalCharges { amount }
    }
    company { contractDate }
    jobs { openCount postedCount @include(if: $isLoggedIn) }
    avgHourlyJobsRate @include(if: $isLoggedIn) { amount }
  }
  query JobPubStaticQuery($id: ID!, $isLoggedIn: Boolean!) {
    jobPubDetails(id: $id) {
      buyer { ...BuyerFragment }
    }
  }`,
];

/*
 * ONLY this cookie works for jobPubDetails.
 *
 * An earlier version also tried oauth2_global_js_token and master_access_token
 * as fallbacks. They are real tokens, so requests were accepted and then
 * rejected with "not enough oauth2 permissions/scopes" listing every field
 * including Query.jobPubDetails — a confusing scope error in place of a clear
 * "no token" one. Those fallbacks are gone.
 *
 * It is set by Upwork's job SEARCH app, not by signing in, so a session that
 * has never opened /nx/search/jobs will not have it. That is what the
 * signed-out banner is really telling you.
 */
const SEARCH_TOKEN_COOKIE = "UniversalSearchNuxt_vt";

/*
 * The same class of visitor token, set by the marketing shell on upwork.com's
 * front page rather than by the search app. It matters because the front page
 * mints one on a plain request — no Nuxt app, no user action — which is what
 * makes silent recovery possible (see refreshVisitorToken). Second in the list,
 * so a live search token is always preferred.
 */
const VISITOR_TOKEN_COOKIE = "visitor_gql_token";
const TOKEN_COOKIE_NAMES = [SEARCH_TOKEN_COOKIE, VISITOR_TOKEN_COOKIE];

/* Where the token comes from — used by the banner and the diagnostic. */
const SEARCH_PAGE_URL = "https://www.upwork.com/nx/search/jobs/";

/* The page that hands out a token without the search app having to run. */
const TOKEN_REFRESH_URL = "https://www.upwork.com/";

function getVisitorToken() {
  if (typeof document === "undefined") return null;

  const jar = document.cookie.split("; ");
  for (const name of TOKEN_COOKIE_NAMES) {
    const match = jar.find((c) => c.startsWith(`${name}=`));
    if (!match) continue;
    const value = match.slice(name.length + 1);
    if (value) return decodeCookie(value);
  }
  return null;
}

function decodeCookie(value) {
  try {
    return decodeURIComponent(value) || null;
  } catch {
    return value || null;
  }
}

/*
 * Looks in more than one place on purpose: the cookie has been seen on both the
 * apex and www hosts, and a single exact-URL lookup reports "signed out" when
 * the user is in fact signed in. The domain-wide sweep is the honest fallback.
 */
async function collectVisitorTokens() {
  const found = [];
  const add = (raw) => {
    const value = decodeCookie(raw);
    if (value && !found.includes(value)) found.push(value);
  };

  const fromPage = getVisitorToken();
  if (fromPage) add(fromPage);

  if (typeof chrome === "undefined" || !chrome.cookies) return found;

  for (const name of TOKEN_COOKIE_NAMES) {
    for (const url of ["https://www.upwork.com/", "https://upwork.com/"]) {
      try {
        const cookie = await chrome.cookies.get({ url, name });
        if (cookie?.value) add(cookie.value);
      } catch {
        // Try the next URL.
      }
    }

    /* Domain-wide sweep catches a cookie scoped to another subdomain. */
    try {
      const all = await chrome.cookies.getAll({ domain: "upwork.com", name });
      for (const cookie of all || []) if (cookie.value) add(cookie.value);
    } catch {
      // Try the next name.
    }
  }

  return found;
}

async function getVisitorTokenAsync() {
  const found = await collectVisitorTokens();
  return found[0] ?? null;
}

/*
 * Names only, never values — enough to tell whether the extension can see the
 * cookie jar at all, without putting a live session token on screen.
 */
async function listUpworkCookieNames() {
  if (typeof chrome === "undefined" || !chrome.cookies) return [];
  try {
    const all = await chrome.cookies.getAll({ domain: "upwork.com" });
    return (all || []).map((cookie) => cookie.name).sort();
  } catch {
    return [];
  }
}

/* Tagged so callers can tell "signed out" from a network or GraphQL failure. */
function authError() {
  const err = new Error(
    "No Upwork search token. Open the job search page once (it sets the token), then retry."
  );
  err.code = "NO_AUTH";
  return err;
}

/* The token exists but is not the search token — same remedy as having none. */
function scopeError() {
  const err = new Error(
    "Upwork rejected the token's permissions. Open the job search page to refresh it, then retry."
  );
  err.code = "NO_AUTH";
  return err;
}

/*
 * The cookie was found — a caller already confirmed that — but Upwork's server
 * still answered 401/403. That means the token itself has gone stale (expired
 * or rotated), not that the extension can't see it. Kept as a separate message
 * from authError() so a failing check doesn't claim "no token" when one is, in
 * fact, present — that contradiction is what the diagnostic showing "found"
 * while checks kept failing was actually pointing at.
 */
function tokenRejectedError() {
  const err = new Error(
    "Upwork rejected the search token (expired or rotated). Open the job search page again to refresh it, then retry."
  );
  err.code = "NO_AUTH";
  return err;
}

async function resolveVisitorToken() {
  const token = await getVisitorTokenAsync();
  if (!token) throw authError();
  return token;
}

/*
 * These tokens are short-lived, which is why "open the job search page again"
 * kept coming back: it was the only way to mint a new one. It need not be —
 * requesting upwork.com's front page with the session's cookies makes the
 * server set a fresh visitor token, and Chrome stores it in the same jar this
 * extension reads. No tab, no navigation, nothing the user has to do.
 *
 * Returns the new token only when it is genuinely different, so a caller can
 * tell "refreshed" from "the same dead value came back" and stop rather than
 * retry forever.
 */
let lastRefreshAt = 0;
let refreshInFlight = null;
const REFRESH_COOLDOWN_MS = 60000;

/*
 * The token that was just refused is usually still sitting in the cookie jar —
 * an expired value is not a deleted one, and the search cookie is read before
 * the front-page cookie. So a refresh does not ask "what is the token now", it
 * asks "is there one here that is not the one you rejected".
 */
const firstNew = (tokens, previous) => tokens.find((t) => t !== previous) ?? null;

async function refreshVisitorToken(previous) {
  /* A cycle can have many jobs fail at once; they share one refresh. */
  if (refreshInFlight) return refreshInFlight;

  /*
   * Just refreshed. A cycle can be twenty jobs deep when a token dies, and all
   * of them will land here — so rather than asking Upwork twenty times, or
   * failing nineteen of them, each one picks up whatever the first refresh
   * left in the jar.
   */
  if (Date.now() - lastRefreshAt < REFRESH_COOLDOWN_MS) return firstNew(await collectVisitorTokens(), previous);
  lastRefreshAt = Date.now();

  refreshInFlight = (async () => {
    try {
      /* The response body is of no interest — the Set-Cookie header is the
         whole point, and Chrome applies it for us. */
      await fetch(TOKEN_REFRESH_URL, { credentials: "include", cache: "no-store" });
    } catch {
      return null;
    } finally {
      refreshInFlight = null;
    }

    return firstNew(await collectVisitorTokens(), previous);
  })();

  return refreshInFlight;
}

function parseJobId(input) {
  if (!input) return null;
  const text = String(input).trim();
  const match = text.match(/(~0[0-9a-f]+)/i);
  return match ? match[1] : null;
}

function jobReferrer(jobId) {
  const uid = jobId.replace(/^~02?/, "");
  return `https://www.upwork.com/nx/search/jobs/details/~02${uid}`;
}

/*
 * `options.token` lets a caller that already resolved the cookie once (a check
 * cycle covering many jobs) reuse that exact value for every request instead
 * of each call re-reading the cookie jar independently. Without this, a cycle
 * that gated itself on "token found" at the top could still have an individual
 * job's own fresh lookup come back empty moments later, re-tripping the
 * signed-out state right after it had just been cleared.
 */
async function gqlPost(url, query, jobId, jobUrl, options = {}) {
  const { withLoginFlag = true, token: presetToken } = options;
  let token = presetToken || (await resolveVisitorToken());
  const defaultReferer = jobReferrer(jobId);
  const pageReferer = jobUrl ? jobUrl.split("?")[0] : null;
  const attempts = [];
  const loginFlags = withLoginFlag ? [true, false] : [true];

  for (const isLoggedIn of loginFlags) {
    attempts.push({ referer: defaultReferer, isLoggedIn });
  }
  if (pageReferer && pageReferer !== defaultReferer) {
    for (const isLoggedIn of loginFlags) {
      attempts.push({ referer: pageReferer, isLoggedIn });
    }
  }

  let lastError = null;
  /* One refresh per call: if a newly minted token is also refused, the problem
     is not staleness and retrying would just spin. */
  let refreshed = false;

  for (let pass = 0; pass < 2; pass++) {
    let rejected = false;

    for (const { referer, isLoggedIn } of attempts) {
      const response = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          Referer: referer,
        },
        body: JSON.stringify({
          query,
          variables: withLoginFlag ? { id: jobId, isLoggedIn } : { id: jobId },
        }),
      });

      if (!response.ok) {
        /* The cookie was present and sent — the server itself refused it,
           which is a different condition from not having found one at all.
           Stale is the usual reason, and that is recoverable without the
           user — so stop the matrix and go get a new token. */
        if (response.status === 401 || response.status === 403) {
          rejected = true;
          break;
        }
        lastError = `HTTP ${response.status}`;
        continue;
      }

      const payload = await response.json();
      if (payload.errors?.length) {
        const message = payload.errors[0].message || "GraphQL error";
        /* Retrying cannot fix a scope rejection — fail fast with the real remedy. */
        if (/oauth2 permissions|scopes to access/i.test(message)) throw scopeError();
        lastError = message;
        continue;
      }

      const details = payload.data?.jobPubDetails ?? null;
      if (details) return details;
      lastError = "Empty response";
    }

    if (!rejected) break;
    if (refreshed) throw tokenRejectedError();

    const fresh = await refreshVisitorToken(token);
    /* Nothing new to try — say so in the old words, which are still the right
       advice when the silent path cannot help. */
    if (!fresh) throw tokenRejectedError();

    token = fresh;
    refreshed = true;
  }

  throw new Error(
    lastError
      ? `Upwork API request failed (${lastError}). Refresh upwork.com and try again.`
      : "Upwork API request failed. Refresh upwork.com and try again."
  );
}

/* ── Schema probe ──
 *
 * The job-terms field names cannot be determined from outside the browser:
 * this endpoint is private, undocumented, and its schema is not published.
 * Rather than keep guessing, this asks the endpoint itself.
 *
 * Returns errors instead of throwing — for a probe, the error text IS the
 * result. GraphQL validation messages name the offending field and often
 * suggest the correct one.
 */
async function rawGqlPost(query, variables, token) {
  const resolved = token || (await resolveVisitorToken());

  const response = await fetch(UPWORK_GQL_DETAILS, {
    method: "POST",
    credentials: "include",
    headers: {
      authorization: `Bearer ${resolved}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables: variables || {} }),
  });

  const text = await response.text();
  try {
    return { status: response.status, payload: JSON.parse(text) };
  } catch {
    return { status: response.status, payload: null, raw: text.slice(0, 400) };
  }
}

async function introspectType(name, token) {
  const query = `query TypeProbe($n: String!) {
    __type(name: $n) {
      name
      fields { name type { name kind ofType { name kind } } }
    }
  }`;
  const res = await rawGqlPost(query, { n: name }, token);
  return res.payload?.data?.__type ?? null;
}

const typeName = (t) => t?.name || t?.ofType?.name || t?.kind || "?";

/*
 * Candidate leaf fields, drawn from the names Upwork's own visitor job SEARCH
 * query uses (jobType, hourlyBudgetMin/Max, contractorTier, publishTime,
 * fixedPriceAmount, hourlyEngagementDuration) plus the ones this extension
 * has already guessed at. Each is asked for on its own so one bad name cannot
 * mask the rest.
 */
const FIELD_CANDIDATES = [
  "title",
  "jobType",
  "type",
  "hourlyBudgetMin",
  "hourlyBudgetMax",
  "hourlyBudgetMin { amount }",
  "fixedPriceAmount { amount }",
  "amount { amount }",
  "budget { amount }",
  "contractorTier",
  "contractorTier { ... on Node { id } }",
  "publishTime",
  "createdOn",
  "publishedDateTime",
  "engagement",
  "durationLabel",
  "duration",
  "hourlyEngagementDuration { weeks }",
  "fixedPriceEngagementDuration { weeks }",
  "contractTerms { contractType }",
];

async function probeJobSchema(jobId, jobUrl, token) {
  const out = { introspection: false, types: {}, probes: [], note: null };

  /* Best case: introspection is open and simply tells us the truth. */
  const root = await introspectType("JobPubDetails", token);
  if (root?.fields?.length) {
    out.introspection = true;

    const record = (type) => {
      out.types[type.name] = type.fields.map((f) => `${f.name}: ${typeName(f.type)}`);
      return type;
    };
    record(root);

    /* Walk JobPubDetails → opening → job/info, which is where terms live. */
    const openingName = typeName(root.fields.find((f) => f.name === "opening")?.type);
    const opening = openingName !== "?" ? await introspectType(openingName, token) : null;
    if (opening?.fields?.length) {
      record(opening);
      for (const child of ["job", "info"]) {
        const childName = typeName(opening.fields.find((f) => f.name === child)?.type);
        if (childName === "?") continue;
        const childType = await introspectType(childName, token);
        if (childType?.fields?.length) record(childType);
      }
    }
    return out;
  }

  /*
   * Introspection is disabled, which is normal in production. Fall back to
   * asking for one candidate field at a time and reading the validation error.
   */
  out.note = "Introspection disabled — probing fields individually.";

  for (const parent of ["job", "info"]) {
    for (const field of FIELD_CANDIDATES) {
      const query = `query FieldProbe($id: ID!) {
        jobPubDetails(id: $id) { opening { ${parent} { ${field} } } }
      }`;
      const res = await rawGqlPost(query, { id: jobId }, token);
      const message = res.payload?.errors?.[0]?.message ?? null;

      out.probes.push({
        path: `opening.${parent}.${field}`,
        ok: !message,
        message: message ? String(message).slice(0, 200) : null,
      });

      /* `opening.parent` itself is wrong — no point testing its children. */
      if (message && new RegExp(`field "?${parent}"?`, "i").test(message)) {
        out.probes.push({ path: `opening.${parent}`, ok: false, message: "parent invalid — skipped rest" });
        break;
      }
    }
  }

  return out;
}

/* The polling path. Activity only — static data comes from fetchJobStatic. */
function fetchJobDetails(jobId, jobUrl, token) {
  return fetchJobActivity(jobId, jobUrl, token);
}

/*
 * Title lookup is deliberately a separate, best-effort request: the exact field
 * path for the title is not certain across Upwork schema revisions, so a wrong
 * guess here fails silently instead of breaking JOB_DETAILS_QUERY polling.
 */
const JOB_TITLE_QUERIES = [
  `query JobPubTitleQuery($id: ID!) {
    jobPubDetails(id: $id) { opening { job { title } } }
  }`,
  `query JobPubTitleQuery($id: ID!) {
    jobPubDetails(id: $id) { opening { info { title } } }
  }`,
];

async function fetchJobTitle(jobId, jobUrl) {
  for (const query of JOB_TITLE_QUERIES) {
    try {
      const details = await gqlPost(UPWORK_GQL_DETAILS, query, jobId, jobUrl, {
        withLoginFlag: false,
      });
      const title = details?.opening?.job?.title ?? details?.opening?.info?.title;
      if (title) return String(title).trim();
    } catch {
      // Try the next candidate shape.
    }
  }
  return null;
}

/* Reads a money-ish value that may be a number, {amount}, or {rawValue}. */
function moneyValue(input) {
  if (typeof input === "number") return input;
  if (!input || typeof input !== "object") return null;
  if (typeof input.rawValue === "number") return input.rawValue;
  if (typeof input.amount === "number") return input.amount;
  /* rawValue is sometimes a decimal string. */
  const parsed = Number(input.rawValue ?? input.amount);
  return Number.isFinite(parsed) ? parsed : null;
}

/* Flattens whichever shape answered into one predictable object. */
function normalizeJobMeta(details) {
  const job = details?.opening?.job ?? details?.opening?.info ?? null;
  if (!job) return null;

  const terms = job.contractTerms ?? {};
  const hourly = terms.hourlyContractTerms ?? {};
  const fixed = terms.fixedPriceContractTerms ?? {};

  const hourlyMin = moneyValue(hourly.hourlyBudgetMin ?? job.hourlyBudgetMin);
  const hourlyMax = moneyValue(hourly.hourlyBudgetMax ?? job.hourlyBudgetMax);
  const fixedAmount = moneyValue(fixed.amount ?? job.amount ?? job.budget);

  /* Upwork's legacy `type` is numeric: 1 hourly, 2 fixed. */
  const rawType = terms.contractType ?? job.type ?? null;
  const type =
    rawType === 1 || /hourly/i.test(String(rawType))
      ? "hourly"
      : rawType === 2 || /fixed/i.test(String(rawType))
        ? "fixed"
        : hourlyMin !== null || hourlyMax !== null
          ? "hourly"
          : fixedAmount !== null
            ? "fixed"
            : null;

  const meta = {
    type,
    hourlyMin,
    hourlyMax,
    fixedAmount,
    duration: hourly.engagementDuration?.label ?? job.durationLabel ?? job.duration ?? null,
    engagement: job.engagement ?? null,
    tier: job.contractorTier ?? job.experienceLevel ?? null,
    postedAt: job.publishTime ?? job.createdOn ?? job.publishedDateTime ?? null,
    title: job.title ? String(job.title).trim() : null,
  };

  /* Nothing usable came back — report that rather than an object of nulls. */
  const useful = Object.entries(meta).some(([k, v]) => k !== "title" && v !== null);
  return useful || meta.title ? meta : null;
}

/* Upwork job URLs usually carry the title as a slug: /jobs/Senior-React-Dev_~021234… */
function titleFromUrl(input) {
  if (!input) return null;
  const match = String(input).match(/\/jobs\/([^/?#]+)/i);
  if (!match) return null;

  const slug = match[1].replace(/_?~0[0-9a-f]+$/i, "");
  if (!slug || /^~0/i.test(slug)) return null;

  const text = decodeURIComponent(slug).replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return text || null;
}

async function lookupJob(input, mode, jobUrl) {
  const jobId = parseJobId(input);
  if (!jobId) {
    throw new Error("Could not parse a job ID from that input.");
  }

  const details = await fetchJobActivity(jobId, jobUrl);
  if (mode === "activity") return summarizeActivity(details);

  /*
   * A one-off lookup is a single manual action, so it pays for both calls and
   * returns them flattened — the Lookup tab renders client fields alongside
   * activity ones, and splitting the queries must not change what it shows.
   */
  const summary = summarizeJob(details);
  const stat = await fetchJobStatic(jobId, jobUrl);
  return { ...summary, ...(stat?.client || {}), meta: stat?.meta || null };
}

/* Unambiguous absolute stamp — used for tooltips and for anything older than a
   few weeks, where "31 days ago" is less useful than the actual date. */
function formatAbsoluteTime(inputDate) {
  if (!inputDate) return null;
  const date = new Date(inputDate);
  if (Number.isNaN(date.getTime())) return null;

  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatRelativeTime(inputDate) {
  if (!inputDate) return null;
  const then = new Date(inputDate).getTime();
  if (Number.isNaN(then)) return null;

  const diffMs = Date.now() - then;
  /*
   * Clamped: Upwork's timestamp can sit slightly ahead of the local clock, and
   * the old version rendered that as "-4s ago".
   */
  if (diffMs < 5000) return "just now";

  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;

  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;

  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;

  const day = Math.floor(hr / 24);
  if (day < 7) return day === 1 ? "1 day ago" : `${day} days ago`;

  const week = Math.floor(day / 7);
  if (week < 5) return week === 1 ? "1 week ago" : `${week} weeks ago`;

  return formatAbsoluteTime(then);
}

function summarizeActivity(details) {
  if (!details) return null;
  const activity = details.opening?.clientActivity ?? {};

  return {
    proposals: activity.totalApplicants ?? null,
    lastViewed: formatRelativeTime(activity.lastBuyerActivity),
    lastViewedRaw: activity.lastBuyerActivity ?? null,
    interviewing: activity.totalInvitedToInterview ?? null,
    invitesSent: activity.invitationsSent ?? null,
    unansweredInvites: activity.unansweredInvites ?? null,
    hires: activity.totalHired ?? null,
  };
}

/*
 * The volatile summary — what a check stores as `lastStats` and what diffJob
 * compares. Every field here comes from JOB_ACTIVITY_QUERY.
 */
function summarizeJob(details) {
  if (!details) return null;
  const opening = details.opening?.clientActivity ?? {};

  return {
    paymentVerified: details.buyerExtra?.isPaymentMethodVerified ?? null,
    proposals: opening.totalApplicants ?? null,
    lastViewed: formatRelativeTime(opening.lastBuyerActivity),
    lastViewedRaw: opening.lastBuyerActivity ?? null,
    interviewing: opening.totalInvitedToInterview ?? null,
    invitesSent: opening.invitationsSent ?? null,
    unansweredInvites: opening.unansweredInvites ?? null,
    hires: opening.totalHired ?? null,
  };
}

/*
 * The static summary — client profile plus whatever job terms the answering
 * shape carried. Stored once on the job record, not in `lastStats`, so a check
 * can never overwrite it with nulls.
 */
function summarizeStatic(details) {
  if (!details) return null;

  const buyer = details.buyer ?? {};
  const location = buyer.location ?? {};
  const stats = buyer.stats ?? {};
  const jobs = buyer.jobs ?? {};

  const client = {
    location: [location.city, location.country].filter(Boolean).join(", ") || null,
    score: stats.score ?? null,
    postedJobs: jobs.postedCount ?? null,
    openJobs: jobs.openCount ?? null,
    totalSpent: stats.totalCharges?.amount ?? null,
    memberSince: buyer.company?.contractDate ?? null,
    totalHires: stats.totalAssignments ?? null,
    activeContracts: stats.activeAssignmentsCount ?? null,
    hoursBilled: stats.hoursCount ?? null,
    jobsWithHires: stats.totalJobsWithHires ?? null,
    avgHourlyRate: buyer.avgHourlyJobsRate?.amount ?? null,
  };

  const hasClient = Object.values(client).some((v) => v !== null);
  const meta = normalizeJobMeta(details);
  if (!hasClient && !meta) return null;

  return { client: hasClient ? client : null, meta };
}

function fetchJobActivity(jobId, jobUrl, token) {
  return gqlPost(UPWORK_GQL_DETAILS, JOB_ACTIVITY_QUERY, jobId, jobUrl, {
    /* None of the activity fields are gated on it. */
    withLoginFlag: false,
    token,
  });
}

/* ── Screening questions, and who the client hired before ──
 *
 * Both are in the authenticated payload — opening.questions and
 * buyer.workHistory — and both came back as `[]` on the one response captured
 * from a live session. `[]` proves the FIELD is there and readable; it says
 * nothing about the shape of its entries, so the selections below are
 * candidates, not facts.
 *
 * Both now ride the ONE job-details request. The client's history always did
 * (see HISTORY_SELECTION); the questions used to be a request of their own,
 * for a reason that turned out to be solvable:
 *
 *   Three question shapes folded into four auth rungs looks like twelve
 *   permutations of one query, and one wrong guess costing the description
 *   and the client profile along with it.
 *
 * It is not twelve, because a GraphQL validation error NAMES the field it
 * rejects. A bad question selection comes back as "Field 'questions' must
 * have a selection of subfields" or "Cannot query field 'position' on …" —
 * so the wrong guess identifies itself, and the walk drops down the question
 * ladder in place instead of failing the rung. That is 4 rungs + at most 3
 * corrections, once per session, and exactly one request forever after.
 *
 * The last rung is the empty selection: if no shape validates, the query goes
 * back to being precisely what it was before questions were asked for, so a
 * field this schema does not have can never cost anything else on the card.
 */
const WITH_POSITION = /\bquestions?\b|\bposition\b/i;
const JUST_QUESTIONS = /\bquestions?\b/i;

/*
 * Two placements, because which one is right is genuinely not known. The
 * fragment copied verbatim from Upwork's own request is declared
 * `on JobPubOpeningInfo` and applied to `opening.job` — so JobPubOpeningInfo
 * is the type of `job`, not of `opening`, and a field seen at "opening.questions"
 * in a response could sit on either the wrapper or the job. The visitor
 * endpoint is no help: there `opening` IS the JobPubOpeningInfo, with no `job`
 * beneath it, which is the same reason pastJobMeta reads `opening.job ?? opening`.
 *
 * Guessing one and shipping it is how this ends up silently never working, so
 * both are on the ladder. It costs nothing: the walk is error-directed, so the
 * wrong placement is rejected by name and corrected, once, per session.
 */
const QUESTION_SELECTIONS = [
  { at: "opening", sel: `questions { question position }`, blame: WITH_POSITION },
  { at: "opening", sel: `questions { question }`, blame: JUST_QUESTIONS },
  /* A plain list of strings, which is what the legacy API returned. */
  { at: "opening", sel: `questions`, blame: JUST_QUESTIONS },
  { at: "job", sel: `questions { question position }`, blame: WITH_POSITION },
  { at: "job", sel: `questions { question }`, blame: JUST_QUESTIONS },
  { at: "job", sel: `questions`, blame: JUST_QUESTIONS },
  /* Nothing validated — ask for what we know works and leave it unknown. */
  { at: null, sel: ``, blame: null },
];

/*
 * Read off a real response rather than guessed, and now part of the MAIN auth
 * query rather than a request of its own — the payload the card already
 * fetches carries this, so asking for it separately was both a wasted round
 * trip and, worse, a second lifecycle: it arrived from the once-a-day static
 * refresh while everything beside it on the slide came from the on-demand
 * fetch, so the section sat on "not fetched yet" long after the rest was
 * there.
 *
 * Two earlier guesses at this shape were provably wrong:
 *
 *  · `totalCharge` is a plain Float (0.0), not a money object — asking for
 *    `totalCharge { amount }` is a subselection on a scalar, which fails
 *    validation and took the whole rung down with it;
 *  · `contractorName` and `jobTitle` are not row fields. They live under
 *    `contractorInfo` and `jobInfo`.
 *
 * `feedbackToClient` is the find: `feedback` is what the client said about the
 * freelancer, and this is what the freelancer said about the CLIENT — which is
 * the half that matters when deciding whether to bid.
 */
const HISTORY_SELECTION = `workHistory {
          status
          startDate
          endDate
          totalCharge
          totalHours
          jobInfo { title type access ciphertext }
          contractorInfo { contractorName ciphertext }
          rate { amount }
          feedback { score comment feedbackSuppressed }
          feedbackToClient { score comment feedbackSuppressed }
        }`;

/* Entries may be bare strings or objects — see the candidate ladder above. */
function questionList(input) {
  if (!input) return null;

  const out = (Array.isArray(input) ? input : [input])
    .map((q) => {
      if (typeof q === "string" || typeof q === "number") return String(q);
      if (!q || typeof q !== "object") return null;
      return q.question ?? q.text ?? q.title ?? q.value ?? null;
    })
    .map((text) => (text === null || text === undefined ? null : String(text).trim()))
    .filter(Boolean);

  return out.length ? out : null;
}

/*
 * Was THIS rejection about the question selection we guessed, rather than
 * about the rest of the query?
 *
 * The blame regex belongs to the selection that was actually sent, so the
 * `position` spelling can only ever be blamed while `position` was on the
 * wire. Anything else — a refused buyer subtree, a scope list, a network
 * failure — leaves the question ladder exactly where it is, because dropping
 * a rung for someone else's error is how a good selection gets discarded.
 */
function questionShapeBlamed(message, index) {
  const blame = QUESTION_SELECTIONS[index]?.blame;
  return Boolean(blame && message && blame.test(String(message)));
}

/*
 * Three states out of one field, and the difference matters on screen:
 *
 *   undefined  not asked for, or nulled out by an error — we do not know
 *   null       asked, answered, and there are none
 *   [ … ]      asked, answered, and here they are
 *
 * `"questions" in …` is what separates the first from the rest: a selection
 * that was never sent leaves no key behind, whereas one the server refused
 * leaves the key with null under it. Collapsing either into "none" is how a
 * job with three screening questions ends up claiming it has none.
 *
 * Read from wherever the winning selection put it — see QUESTION_SELECTIONS.
 */
function readQuestions(opening) {
  const holder = [opening, opening?.job].find((o) => o && "questions" in o);
  if (!holder) return undefined;
  const raw = holder.questions;
  if (raw === null || raw === undefined) return undefined;
  return questionList(raw);
}

/*
 * Flattens a work-history row whichever candidate shape answered. Every alias
 * is read rather than branching on which query won, so what comes out is one
 * object the render downstream can rely on.
 */
/*
 * An established client's history runs to dozens of contracts, each carrying
 * two multi-paragraph reviews — comfortably 40KB per job, in a storage area
 * every tracked job shares. Newest first, then capped and clipped.
 */
const HISTORY_MAX_ROWS = 12;
const HISTORY_MAX_COMMENT = 500;

const clipText = (text, max) => {
  const value = String(text ?? "").trim();
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max).trimEnd()}…` : value;
};

const timeValue = (input) => {
  const ms = new Date(input ?? 0).getTime();
  return Number.isNaN(ms) ? 0 : ms;
};

function workHistoryList(input) {
  if (!Array.isArray(input) || !input.length) return null;

  /* Upwork can withhold a review while keeping the row; a suppressed one has
     no comment to show and its score means nothing. */
  const review = (fb) => {
    if (!fb || fb.feedbackSuppressed) return null;
    const score = numberOrNull(fb.score);
    const comment = clipText(fb.comment, HISTORY_MAX_COMMENT);
    return score === null && !comment ? null : { score, comment };
  };

  const out = input
    .map((row) => {
      const who = row?.contractorInfo ?? row?.freelancerInfo ?? row?.contractor ?? {};
      const what = row?.jobInfo ?? row?.job ?? {};
      /* `feedback` is the client reviewing the freelancer; `feedbackToClient`
         is the freelancer reviewing the client. Both are worth reading, and
         only the second one is about the person you would be working for. */
      const given = review(row?.feedback ?? row?.contractorFeedback);
      const received = review(row?.feedbackToClient);

      return {
        freelancer:
          who.contractorName ?? who.name ?? row?.contractorName ?? row?.freelancerName ?? null,
        profile: who.ciphertext ?? who.devProfileCiphertext ?? null,
        title: what.title ?? row?.jobTitle ?? row?.title ?? null,
        /* Null for private jobs, which have no public page to link to. */
        jobKey: what.ciphertext ?? null,
        type: what.type ?? null,
        status: row?.status ?? null,
        score: given?.score ?? null,
        comment: given?.comment ?? null,
        clientScore: received?.score ?? null,
        clientComment: received?.comment ?? null,
        startedAt: row?.startDate ?? row?.start ?? null,
        endedAt: row?.endDate ?? row?.end ?? null,
        spent: moneyValue(row?.totalCharge ?? row?.charge ?? row?.amount),
        rate: moneyValue(row?.rate ?? row?.hourlyRate),
        hours: numberOrNull(row?.totalHours ?? row?.hours),
      };
    })
    /* A row with neither a name nor a job title is not worth a line. */
    .filter((r) => r.freelancer || r.title)
    /* The response arrives in no useful order — active contracts are mixed in
       among closed ones from months earlier. */
    .sort((a, b) => timeValue(b.startedAt) - timeValue(a.startedAt))
    .slice(0, HISTORY_MAX_ROWS);

  return out.length ? out : null;
}

/* Reuses the token walk and the captured bearer; see fetchJobAuthDetails. */
async function authSideQuery(query, jobId, jobUrl) {
  const creds = orderTokens(await collectAuthTokens(), preferredAuthToken);
  if (!creds.length) throw new Error("no session token");

  const tenantId = await readCookie(TENANT_COOKIE);
  const res = await authGqlPost(query, jobId, jobUrl, creds, tenantId, null, new Set());
  if (!res.data) throw new Error(res.error || "refused");
  return res.data;
}

/*
 * Which shape answered last time, and whether the block is hopeless for now.
 *
 * Both halves matter on a list. "Check all jobs now" runs the static refresh
 * for every tracked job in turn: without the remembered index, twenty jobs
 * re-walk the same ladder to the same rung twenty times, and without the
 * cooldown a block this session cannot read at all costs a doomed request per
 * shape per job, for every job on the list, on every button press.
 */
const sideBlockState = new Map();
const SIDE_BLOCK_COOLDOWN_MS = 30 * 60000;

/*
 * Walks the shapes until one VALIDATES, then takes whatever it found —
 * including nothing. A narrower shape cannot find more than a wider one the
 * server already accepted, so an empty answer ends the walk rather than
 * re-asking every shape on every refresh forever.
 *
 * The one caller left is the price of a PAST job, which is the one lookup
 * that genuinely cannot ride the job-details request: it is a different job
 * id entirely — a row out of the client's work history, not the job on
 * screen. Screening questions used to be here too and are not any more; they
 * are a field of the job being viewed, so they belong in its own request.
 *
 * Never throws. This block is enrichment on its own.
 *
 * Three outcomes, told apart by JS's own two empties:
 *
 *   [ … ]      a shape validated and there is something there
 *   null       a shape validated and there is NOTHING there — an answer
 *   undefined  no shape validated; we do not know and must not claim to
 *
 * The card says something different for each, and the worker only overwrites
 * what it already holds for the first two.
 */
async function fetchSideBlock(key, shapes, pick, jobId, jobUrl, token) {
  const state = sideBlockState.get(key) ?? { index: 0, deadUntil: 0 };
  if (Date.now() < state.deadUntil) return undefined;

  /* Last winner first, the rest in their declared order. */
  const order = [state.index, ...shapes.map((_, i) => i).filter((i) => i !== state.index)];

  for (const index of order) {
    const shape = shapes[index];
    try {
      const data = shape.auth
        ? await authSideQuery(shape.query, jobId, jobUrl)
        : await gqlPost(UPWORK_GQL_DETAILS, shape.query, jobId, jobUrl, {
            token,
            /* None of these queries declares $isLoggedIn. */
            withLoginFlag: false,
          });

      if (data) {
        sideBlockState.set(key, { index, deadUntil: 0 });
        return pick(data) ?? null;
      }
    } catch {
      // Refused — try the next candidate shape.
    }
  }

  /* Nothing validated. Either every guessed shape is wrong or no endpoint here
     will answer; neither is fixed by asking again for the next job in the list. */
  sideBlockState.set(key, { index: 0, deadUntil: Date.now() + SIDE_BLOCK_COOLDOWN_MS });
  return undefined;
}

/* ── A hired freelancer's profile: the country and rate behind the name ──
 *
 * The hired rows carry a name and a public profile key and nothing else, so
 * where the freelancer is has to come from the profile itself. The private
 * GraphQL query for that is not known; the public profile PAGE is, and it is
 * server-rendered for search engines — so its structured data, the JSON-LD
 * and the <title>, name the person, their location and their rate in a form
 * built to be read by machines. That is what this reads.
 *
 * Deliberately NOT read: loose keys like "country" in the page's script state.
 * That state also carries the VIEWER's own profile, and a wrong country shown
 * with confidence is worse than none. Fails soft to null; cached for a week
 * upstream, one page per freelancer.
 */
const freelancerProfileUrl = (key) => `https://www.upwork.com/freelancers/${key}`;

const decodeEntities = (text) =>
  String(text ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");

function extractProfileFromHtml(html) {
  if (!html) return null;

  const out = { country: null, city: null, title: null, rate: null };
  const take = (key, value) => {
    const text = value === null || value === undefined ? "" : String(value).trim();
    if (out[key] === null && text) out[key] = text;
  };

  /* 1. JSON-LD: a Person node, on its own, inside @graph, or as mainEntity. */
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try {
      data = JSON.parse(decodeEntities(m[1]));
    } catch {
      continue;
    }
    const nodes = [].concat(data, data?.["@graph"] ?? [], data?.mainEntity ?? []);
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const person =
        node["@type"] === "Person"
          ? node
          : node.mainEntity?.["@type"] === "Person"
            ? node.mainEntity
            : null;
      if (!person) continue;

      /* addressCountry is a string or a { name } object, depending on the page. */
      take("country", person.address?.addressCountry?.name ?? person.address?.addressCountry);
      take("city", person.address?.addressLocality);
      take("title", person.jobTitle);

      const price =
        person.makesOffer?.priceSpecification?.price ??
        person.offers?.priceSpecification?.price ??
        person.offers?.price;
      const n = Number(price);
      if (out.rate === null && Number.isFinite(n) && n > 0) out.rate = n;
    }
  }

  /* 2. The title: "Name – Title | Upwork Freelancer from City, Country". */
  if (!out.country) {
    const titles = [
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1],
      /<title>([^<]*)<\/title>/i.exec(html)?.[1],
    ]
      .filter(Boolean)
      .map(decodeEntities);

    for (const t of titles) {
      const from = /freelancer (?:from|in)\s+([^|–—-]+?)\s*(?:\||–|—|-|$)/i.exec(t)?.[1];
      if (!from) continue;
      const parts = from.split(",").map((s) => s.trim()).filter(Boolean);
      take("country", parts.pop());
      take("city", parts.pop());
      break;
    }
  }

  /*
   * 3. The headline rate, from the VISIBLE markup only. Script blocks are cut
   *    first, because the page state also carries the viewer's own rate. Then
   *    the first "$15.00/hr" — the profile header comes before the work
   *    history, whose contract rates would otherwise be candidates too — and
   *    only when it sits ahead of those sections.
   */
  if (out.rate === null) {
    const visible = html.replace(/<script[\s\S]*?<\/script>/gi, "");
    const cut = visible.search(/Work history|Employment history|Portfolio/i);
    const header = visible.slice(0, cut < 0 ? visible.length : cut);
    const m = /\$\s?(\d{1,4}(?:\.\d{1,2})?)\s*(?:<[^>]+>\s*)*\/\s*hr\b/i.exec(header);
    const n = m ? Number(m[1]) : NaN;
    if (Number.isFinite(n) && n > 0) out.rate = n;
  }

  return Object.values(out).some((v) => v !== null) ? out : null;
}

async function fetchFreelancerProfile(key) {
  if (!/^~01[0-9a-f]+$/i.test(String(key ?? ""))) return null;
  try {
    const response = await fetch(freelancerProfileUrl(key), {
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) return null;
    return extractProfileFromHtml(await response.text());
  } catch {
    return null;
  }
}

/*
 * Everything the profile fetch saw, for the diagnostic. The parser above fails
 * soft to null by design, which is right for the card and useless for finding
 * out WHY — so this fetches the same page fresh, bypassing the cache, and
 * reports what it is: a profile, a login redirect, a Cloudflare challenge, or
 * a client-rendered shell with nothing in its markup to read.
 */
async function probeFreelancerProfile(key) {
  const report = { key, url: freelancerProfileUrl(key), ok: false };
  try {
    const response = await fetch(report.url, { credentials: "include", cache: "no-store" });
    report.status = response.status;
    report.finalUrl = response.url;
    report.redirected = response.redirected;
    report.contentType = response.headers.get("content-type");

    const html = await response.text();
    report.length = html.length;
    report.title = decodeEntities(/<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? "").trim() || null;
    report.challenge = /just a moment|cf-chl|challenge-platform|cf_chl/i.test(html);
    report.login = /\/ab\/account-security\/login|Log in to Upwork/i.test(
      response.url + html.slice(0, 5000)
    );
    report.nuxtState = /__NUXT__|__NUXT_DATA__/.test(html);
    report.freelancerFrom = /freelancer (?:from|in)\s+/i.test(html);

    report.jsonLd = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map(
      (m) => {
        try {
          const d = JSON.parse(decodeEntities(m[1]));
          return (
            [].concat(d, d?.["@graph"] ?? [])
              .map((n) => n?.["@type"])
              .filter(Boolean)
              .join("/") || "untyped"
          );
        } catch {
          return "unparseable";
        }
      }
    );

    /* Where "$15.00/hr" appears in the visible markup, with a little context
       each — enough to see whether the first one is the header rate. */
    const visible = html.replace(/<script[\s\S]*?<\/script>/gi, "");
    report.rateMentions = [...visible.matchAll(/\$\s?\d{1,4}(?:\.\d{1,2})?\s*(?:<[^>]+>\s*)*\/\s*hr\b/gi)]
      .slice(0, 4)
      .map((m) =>
        visible
          .slice(Math.max(0, m.index - 70), m.index + m[0].length)
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      );

    report.extracted = extractProfileFromHtml(html);
    report.ok = Boolean(report.extracted);
  } catch (err) {
    report.error = err?.message || String(err);
  }
  return report;
}

/* ── A past job's posted price ──
 *
 * The client's history says what each contract PAID; what the job was POSTED
 * at — the hourly range or the fixed budget the client wrote — is on the job
 * itself. For a public past job the key is right there (jobInfo.ciphertext),
 * and the fields are the ones this extension already reads for tracked jobs,
 * off the payload shape confirmed from a live response. Private jobs have no
 * key and no public page; nothing can be done for those.
 *
 * The authenticated endpoint first, because that is where these fields are
 * proven; the visitor endpoint as a fallback, asking for the same fields one
 * level up, where JobPubOpeningInfo sits on that side.
 */
function pastJobMeta(job) {
  if (!job) return null;
  const budget = job.extendedBudgetInfo ?? {};
  const hourlyMin = numberOrNull(budget.hourlyBudgetMin);
  const hourlyMax = numberOrNull(budget.hourlyBudgetMax);
  const fixedAmount = moneyValue(job.budget);
  const kind = String(job.info?.type ?? "");
  const type =
    /hourly/i.test(kind) || hourlyMin !== null || hourlyMax !== null
      ? "hourly"
      : /fixed/i.test(kind) || fixedAmount
        ? "fixed"
        : null;
  if (!type) return null;

  return {
    type,
    hourlyMin,
    hourlyMax,
    /* A zero here means "hourly job, no fixed amount", not "free". */
    fixedAmount: type === "hourly" ? null : fixedAmount || null,
    hidden: Boolean(job.info?.hideBudget),
  };
}

const PAST_JOB_PRICE_SHAPES = [
  {
    auth: true,
    /* $isLoggedIn is declared AND used, because authGqlPost always sends it. */
    query: `query PastJobPrice($id: ID!, $isLoggedIn: Boolean!) {
      jobAuthDetails(id: $id) {
        opening { job {
          info { type hideBudget @include(if: $isLoggedIn) }
          budget { amount currencyCode }
          extendedBudgetInfo { hourlyBudgetMin hourlyBudgetMax hourlyBudgetType }
        } }
      }
    }`,
  },
  {
    query: `query PastJobPricePub($id: ID!) {
      jobPubDetails(id: $id) {
        opening {
          info { type hideBudget }
          budget { amount currencyCode }
          extendedBudgetInfo { hourlyBudgetMin hourlyBudgetMax hourlyBudgetType }
        }
      }
    }`,
  },
];

const fetchPastJobPrice = (jobKey) =>
  fetchSideBlock(
    "jobPrice",
    PAST_JOB_PRICE_SHAPES,
    /* The auth shape nests under opening.job; the visitor one does not. */
    (d) => pastJobMeta(d?.opening?.job ?? d?.opening),
    jobKey,
    null
  );


/*
 * Never throws. Static data is enrichment: if it cannot be had, the job still
 * monitors perfectly well and must not be marked failed.
 */
async function fetchJobStatic(jobId, jobUrl, token) {
  let summary = null;

  for (const query of JOB_STATIC_QUERIES) {
    try {
      const details = await gqlPost(UPWORK_GQL_DETAILS, query, jobId, jobUrl, { token });
      summary = summarizeStatic(details);
      if (summary) break;
    } catch {
      // Try the next candidate shape.
    }
  }

  /*
   * No screening questions or work history here any more. Both belong to the
   * on-demand details fetch, not to this once-a-day one: gathered here, they
   * showed up on the card hours out of step with everything beside them.
   */
  return summary;
}

/* ── Authenticated job details (jobAuthDetails) ──
 *
 * A far richer endpoint than the visitor one above. Where jobPubDetails
 * returns the counters, `gql-query-get-auth-job-details-v2` returns the whole
 * job page: the description, the skills, the category, the budget and duration
 * as Upwork itself prints them, the client's profile, and the qualifications
 * the client set — plus, because it is authenticated, whether THIS freelancer
 * meets them.
 *
 * It is for display only. The polling path stays on the visitor query: that
 * one is smaller, needs no signed-in session, and nothing added here may be
 * able to stop a tracked job from being checked.
 */

const UPWORK_GQL_AUTH_DETAILS =
  "https://www.upwork.com/api/graphql/v1?alias=gql-query-get-auth-job-details-v2";

/*
 * Unlike jobPubDetails, this endpoint wants a token with job-details scopes.
 *
 * None of the bearer-shaped cookies below was measured to have them. Against
 * a real signed-in session the three per-page tokens answered 403 and the
 * three long-lived ones answered "not enough oauth2 permissions/scopes to
 * access: [...]" with a list that, read past its first line, names every
 * field in the query including Query.jobAuthDetails — a root refusal, not a
 * field one. The bearer Upwork's own job page sends with this alias matched
 * NO cookie in the same request's jar, so whatever mints it, it is not a
 * cookie this extension can go and read.
 *
 * So these are fallbacks only. The token that actually works is the one
 * captured off Upwork's own request — see loadCapturedAuth — and these are
 * kept behind it in case a session someday does carry the scope in a cookie.
 */
const AUTH_TOKEN_COOKIE_NAMES = [
  "oauth2_global_js_token",
  "user_oauth2_slave_access_token",
  "master_access_token",
  "JobDetailsNuxt_vt",
  "UniversalSearchNuxt_vt",
  "visitor_signup_gql_token",
];

/* Sent as x-upwork-api-tenantid — the org the request is made as. */
const TENANT_COOKIE = "current_organization_uid";

/*
 * Not all of these cookies are bare tokens: master_access_token is
 * "<prefix>.<token>" and the slave token pairs two of those with a colon. The
 * bearer is always the last oauth2v2 chunk in the value — for the slave token
 * that is the user-scoped half, which is the one carrying job scopes.
 */
function normalizeBearer(raw) {
  const value = decodeCookie(raw);
  if (!value) return null;
  const chunks = value.match(/oauth2v2_[A-Za-z0-9_]+/g);
  return chunks?.length ? chunks[chunks.length - 1] : value;
}

async function readCookie(name) {
  if (typeof document !== "undefined") {
    const inline = document.cookie.split("; ").find((c) => c.startsWith(`${name}=`));
    if (inline) {
      const value = decodeCookie(inline.slice(name.length + 1));
      if (value) return value;
    }
  }

  if (typeof chrome === "undefined" || !chrome.cookies) return null;
  for (const url of ["https://www.upwork.com/", "https://upwork.com/"]) {
    try {
      const cookie = await chrome.cookies.get({ url, name });
      if (cookie?.value) return decodeCookie(cookie.value);
    } catch {
      // Try the other host.
    }
  }
  return null;
}

/*
 * ── The bearer Upwork's own page uses ──
 *
 * The worker watches Upwork's requests to its GraphQL gateway (webRequest,
 * observe-only) and keeps the Authorization bearer it sees. That is the exact
 * token the job page itself used, whatever minted it — which sidesteps the
 * question the cookie jar could not answer. Two are kept: the one seen on the
 * job-details alias, which is known to carry the right scopes, and the most
 * recent seen on any alias, as a second guess.
 *
 * Lives in storage.session: memory-only, cleared when the browser closes, and
 * never synced — the right home for a bearer token. The content script's copy
 * of this file cannot read that area, and does not need to.
 */
const CAPTURED_AUTH_KEY = "capturedAuth";
const AUTH_ALIAS = "gql-query-get-auth-job-details-v2";

/*
 * The GraphQL documents Upwork's own pages send, by alias — the research aid
 * behind everything this extension reads. Written by the worker, listed in
 * Settings; see rememberCapturedQuery in background.js.
 */
const CAPTURED_QUERIES_KEY = "capturedQueries";

async function loadCapturedAuth() {
  try {
    const area = typeof chrome !== "undefined" ? chrome.storage?.session : null;
    if (!area) return null;
    return (await area.get(CAPTURED_AUTH_KEY))[CAPTURED_AUTH_KEY] ?? null;
  } catch {
    return null;
  }
}

/* "captured 3m ago" — for the diagnostic; the exact instant is not the point. */
function ageLabel(at) {
  const ms = Math.max(0, Date.now() - (at || 0));
  if (ms < 60000) return "just now";
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
  return `${Math.floor(ms / 86400000)}d ago`;
}

/*
 * Captured tokens first, then the cookie jar in AUTH_TOKEN_COOKIE_NAMES order.
 *
 * Returns { name, token } pairs, not bare tokens: when every candidate is
 * refused, WHICH one was refused is the whole diagnosis, and a list of
 * anonymous bearer strings cannot say it. The name is never sent anywhere —
 * it only ever reaches the diagnostic.
 */
async function collectAuthTokens() {
  const found = [];
  const add = (name, raw, tenant = null) => {
    const token = normalizeBearer(raw);
    if (token && !found.some((c) => c.token === token)) found.push({ name, token, tenant });
  };

  /*
   * A captured entry brings its own organization — the one Upwork's page sent
   * beside that exact bearer. A cookie token brings none, and gets whatever
   * the candidate walk in authGqlPost can find.
   */
  const captured = await loadCapturedAuth();
  if (captured?.details?.token) {
    add(
      `captured from Upwork's job-details request (${ageLabel(captured.details.at)})`,
      captured.details.token,
      captured.details.tenant
    );
  }
  if (captured?.latest?.token) {
    add(
      `captured from Upwork's ${captured.latest.alias || "GraphQL"} request (${ageLabel(captured.latest.at)})`,
      captured.latest.token,
      captured.latest.tenant
    );
  }

  const jar = typeof document !== "undefined" ? document.cookie.split("; ") : [];

  for (const name of AUTH_TOKEN_COOKIE_NAMES) {
    const inline = jar.find((c) => c.startsWith(`${name}=`));
    if (inline) add(name, inline.slice(name.length + 1));

    if (typeof chrome === "undefined" || !chrome.cookies) continue;
    for (const url of ["https://www.upwork.com/", "https://upwork.com/"]) {
      try {
        const cookie = await chrome.cookies.get({ url, name });
        if (cookie?.value) add(name, cookie.value);
      } catch {
        // Try the other host.
      }
    }
  }

  return found;
}

/*
 * The opening half of the query, copied field for field from the request
 * Upwork's own job-details page makes. Kept verbatim rather than trimmed to
 * what gets rendered: these names are known-good against the live schema, and
 * an unused field costs nothing next to a guess that fails validation.
 */
const AUTH_FRAGMENTS = `
  fragment JobInfoF on Job {
    ciphertext
    id
    type
    access
    title
    hideBudget
    createdOn
    notSureProjectDuration
    notSureFreelancersToHire
    notSureExperienceLevel
    notSureLocationPreference
    premium
  }
  fragment SandsF on SandsData {
    occupation { freeText ontologyId prefLabel id }
    ontologySkills { groupId id freeText prefLabel groupPrefLabel relevance }
    additionalSkills { groupId id freeText prefLabel relevance }
  }
  fragment OpeningF on JobPubOpeningInfo {
    status
    postedOn
    publishTime
    startDate
    deliveryDate
    workload
    contractorTier
    description
    info { ...JobInfoF }
    segmentationData { customValue label name sortOrder type value }
    sandsData { ...SandsF }
    category { name urlSlug }
    categoryGroup { name urlSlug }
    budget { amount currencyCode }
    engagementDuration { label weeks }
    extendedBudgetInfo { hourlyBudgetMin hourlyBudgetMax hourlyBudgetType }
    attachments @include(if: $isLoggedIn) { fileName length uri }
    clientActivity {
      lastBuyerActivity
      totalApplicants
      totalHired
      totalInvitedToInterview
      unansweredInvites
      invitationsSent
      numberOfPositionsToHire
    }
    deliverables
    deadline
    tools { name }
  }
  fragment QualsF on JobQualifications {
    countries
    earnings
    languages
    localDescription
    localFlexibilityDescription
    localMarket
    minJobSuccessScore
    minOdeskHours
    onSiteType
    prefEnglishSkill
    regions
    risingTalent
    shouldHavePortfolio
    states
    tests
    timezones
    type
    locationCheckRequired
    location { city country countryTimezone offsetFromUtcMillis state worldRegion }
    readyToStartToday { expiresAt }
  }
`;

/*
 * The buyer and current-user halves were not in the captured request body, so
 * unlike the fragments above their field names are read back off the RESPONSE
 * and their exact shape is inferred. Two candidates, then none, so a wrong
 * guess out here can never cost us the opening — which is where the
 * description, skills and terms live, and which is proven correct.
 */
const AUTH_BUYER_NESTED = `
      topClient
      buyer {
        enterprise
        isPaymentMethodVerified
        info {
          location { offsetFromUtcMillis countryTimezone city country }
          stats {
            totalAssignments
            activeAssignmentsCount
            hoursCount
            feedbackCount
            score
            totalJobsWithHires
            totalCharges { amount }
          }
          company { name companyId contractDate profile { industry size } }
          jobs { openCount postedCount }
          avgHourlyJobsRate { amount }
        }
        ${HISTORY_SELECTION}
      }
      phoneVerificationStatus { status }
      currentUserInfo {
        owner
        freelancerInfo {
          applied
          hired
          hourlyRate { amount }
          qualificationsMatches {
            matches {
              clientPreferredLabel
              freelancerValueLabel
              qualification
              qualified
            }
          }
        }
      }`;

/*
 * The client's history WITHOUT the stats subtree.
 *
 * A rung for a token that reaches the endpoint but is refused some of the
 * client's numbers. Whether such a token exists is not established: the one
 * scope error seen so far listed BuyerAssignmentsStats fields FIRST, and an
 * earlier version of this file read that as "only the stats are blocked" —
 * but the list is alphabetical and was cut off, and its tail turned out to
 * name the root as well. So this rung is a fallback for a case that may never
 * arise, kept because it costs one request and loses nothing.
 */
const AUTH_BUYER_NO_STATS = `
      topClient
      buyer {
        enterprise
        isPaymentMethodVerified
        info {
          location { offsetFromUtcMillis countryTimezone city country }
          company { name companyId contractDate profile { industry size } }
          jobs { openCount postedCount }
        }
        ${HISTORY_SELECTION}
      }
      phoneVerificationStatus { status }`;

/*
 * No client block at all. Kept ahead of the bare opening because
 * qualificationsMatches — whether THIS account meets the client's bar — is the
 * one thing no public query can answer, and it has nothing to do with the
 * buyer scopes that are failing.
 */
const AUTH_USER_ONLY = `
      currentUserInfo {
        owner
        freelancerInfo {
          applied
          hired
          qualificationsMatches {
            matches {
              clientPreferredLabel
              freelancerValueLabel
              qualification
              qualified
            }
          }
        }
      }`;

const buildAuthQuery = (extras, questions) => `${AUTH_FRAGMENTS}
  query JobAuthDetailsQuery($id: ID!, $isLoggedIn: Boolean!) {
    jobAuthDetails(id: $id) {
      opening {
        job { ...OpeningF ${questions?.at === "job" ? questions.sel : ""} }
        qualifications { ...QualsF }
        ${questions?.at === "opening" ? questions.sel : ""}
      }${extras}
    }
  }`;

/*
 * Widest first, then one rung down at a time. Each rung drops only what the
 * rung above it can plausibly have been refused for, so a session that cannot
 * read the client's stats still gets the description, the skills, the terms,
 * the client's profile AND its own qualification match — rather than falling
 * all the way to the bare opening, which is what a two-rung ladder did.
 *
 * Built per call rather than once at load, because the question selection
 * inside them is learned from the server's own validation errors and can
 * change during a walk.
 */
const AUTH_EXTRAS = [
  AUTH_BUYER_NESTED,
  AUTH_BUYER_NO_STATS + AUTH_USER_ONLY,
  AUTH_USER_ONLY,
  /* Last resort: only the half copied verbatim from Upwork's own call. */
  "",
];

/*
 * What worked last time, so the common case is one request rather than a walk
 * through the matrix. All three are re-validated on every call — a rotated
 * token just falls through to the next candidate and re-pins.
 */
let preferredAuthToken = null;
let preferredAuthQuery = 0;
let preferredQuestionShape = 0;

/*
 * The gateway's refusal when the bearer and the x-upwork-api-tenantid header
 * name different organizations. It arrives as a bare 403 with a plain
 * `{ "message": ... }` body — no GraphQL errors array — which is why it read
 * for so long as an ordinary expired token.
 */
const TENANT_REFUSED = /tenant \(organization\) id could not be found|could not be found in users tenants/i;

/*
 * The org a request last succeeded as, and whether the only thing standing
 * between us and an answer is which org we named.
 *
 * Three states, not two: `undefined` is "nothing pinned yet", while `null` is
 * the pinned result "sending no org header is what works here".
 */
let preferredTenant;
let tenantBlamed = false;

/*
 * A session with no job scopes at all fails every token against every query.
 * Without a cooldown that is a dozen doomed requests each time a row is
 * hovered, so a total failure is remembered for a few minutes.
 *
 * `authFailedTokens` is what makes the cooldown safe to have: the remedy this
 * failure tells the user about — open a job page on upwork.com — mints a NEW
 * token, so a cooldown that ignored the jar would sit there refusing to try
 * again for five minutes after the user had already fixed it. It holds only
 * while the jar is exactly what failed.
 */
let authUnavailableUntil = 0;
let authFailedTokens = "";
const AUTH_COOLDOWN_MS = 5 * 60000;

/*
 * Why the last attempt failed, in the endpoint's own words. The card shows it
 * and the diagnostic prints it: "open a job page once" is the right advice for
 * a missing token and useless advice for a rejected field, and without this
 * there is no way to tell those apart from the outside.
 */
let lastAuthError = null;
const getLastAuthError = () => lastAuthError;

/*
 * Upwork's scope errors carry the exact list, e.g.
 *   "…doesn't have enough oauth2 permissions/scopes to access:
 *    [BuyerAssignmentsStats.score, BuyerAssignmentsStats.hoursCount]"
 * Pulled out so the diagnostic can print which fields are blocked rather than
 * a truncated sentence, and so the ladder below can be reasoned about.
 */
function blockedFields(message) {
  if (!message) return null;
  const list = /to access:\s*\[([^\]]*)/i.exec(message);
  if (!list) return null;

  const names = list[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return names.length ? names : null;
}

/* Moves a known-good token to the front without dropping the others. */
const orderTokens = (creds, preferred) =>
  preferred && creds.some((c) => c.token === preferred)
    ? [
        creds.find((c) => c.token === preferred),
        ...creds.filter((c) => c.token !== preferred),
      ]
    : creds;

/*
 * The advice a refusal here has always ended in. Kept as one string so the
 * message can be tested for it before it is appended twice.
 */
/*
 * The remedy that is actually true. Opening a job page makes Upwork's own
 * code send this exact request with a working bearer, and the worker keeps
 * it — so this is not "maybe a cookie appears", it is the mechanism.
 */
const AUTH_REMEDY =
  " Open any job on upwork.com while signed in (the details panel or a job page) — " +
  "the extension picks up the token Upwork's own page uses — then hover again.";

/*
 * A different failure needs a different instruction. Here the token is good
 * and the ORGANIZATION is wrong, so minting a fresh token changes nothing;
 * what is needed is a request Upwork's own page made as the right org, which
 * is what the capture reads the tenant header from.
 */
const TENANT_REMEDY =
  " Your session token belongs to a different Upwork organization than the one " +
  "this browser last used. Switch to the account you want in Upwork's own " +
  "account menu and open a job there — the extension picks up the organization " +
  "alongside the token — then hover again.";

/*
 * The counterpart to refreshVisitorToken, for the session token THIS endpoint
 * wants. The two failures have the same shape and the same cause: these
 * tokens are short-lived, so a refusal means the one in the jar has expired or
 * rotated, not that the extension cannot see it.
 *
 * JobDetailsNuxt_vt is minted by Upwork's own job-details page — which is
 * exactly why "open a job page once" was the standing remedy. Requesting that
 * page with the session's cookies has the server set it on the way back, and
 * Chrome files it in the jar this extension reads. No tab, no navigation,
 * nothing the user has to do: the same trick the front page already plays for
 * the visitor token.
 *
 * Returns the jar as it stands afterwards. Whether anything in it is actually
 * new is the caller's question, because a refresh that changed nothing must
 * not buy a second round of the same refused requests.
 */
let lastAuthRefreshAt = 0;
let authRefreshInFlight = null;
const AUTH_REFRESH_COOLDOWN_MS = 60000;

async function refreshAuthToken(jobId, jobUrl) {
  /* Several rows can be hovered while one refresh is out; they share it. */
  if (authRefreshInFlight) return authRefreshInFlight;
  if (Date.now() - lastAuthRefreshAt < AUTH_REFRESH_COOLDOWN_MS) return collectAuthTokens();
  lastAuthRefreshAt = Date.now();

  authRefreshInFlight = (async () => {
    try {
      /* The body is of no interest — the Set-Cookie header is the whole point,
         and Chrome applies it for us. The job's own details page rather than a
         generic one: it is that route which mints the details token. */
      await fetch(jobUrl?.startsWith("http") ? jobUrl.split("?")[0] : jobReferrer(jobId), {
        credentials: "include",
        cache: "no-store",
      });
    } catch {
      /* A request that never landed cannot have set a cookie, but the jar is
         re-read regardless — another caller's refresh may have arrived while
         this one was out. */
    } finally {
      authRefreshInFlight = null;
    }

    return collectAuthTokens();
  })();

  return authRefreshInFlight;
}

/*
 * `report`, when passed, collects one row per attempt for the diagnostic.
 * Requests are made either way — the probe is the same code path as a hover,
 * on purpose, so what it reports is what actually happens.
 */
async function authGqlPost(query, jobId, jobUrl, creds, tenantId, report, dead) {
  const headers = {
    "content-type": "application/json",
    Referer: jobUrl?.startsWith("http") ? jobUrl.split("?")[0] : jobReferrer(jobId),
    "x-upwork-accept-language": "en-US",
  };

  let rejected = 0;
  let tried = 0;

  for (const cred of creds) {
    const { name, token } = cred;
    /* A token that answered 403 on a wider shape will answer 403 on a
       narrower one too — the ladder walks shapes, not sessions. */
    if (dead?.has(token)) continue;
    tried++;

    /*
     * Which organization to make the request AS, most trustworthy first:
     *
     *  1. the org Upwork's own page sent beside THIS very bearer, when the
     *     token was captured rather than read out of a cookie;
     *  2. whatever is pinned from an earlier success this session;
     *  3. the current_organization_uid cookie — a guess, and the one that
     *     produced "provided tenant (organization) id could not be found in
     *     users tenants": a bearer is minted for one org, and the cookie says
     *     which org the BROWSER last looked at, which need not be the same;
     *  4. no header at all, letting the gateway pick the token's own default.
     */
    /*
     * `null` is a real candidate here — "send no org header at all" — and
     * distinct from "this source has nothing to offer", which is `undefined`.
     * Collapsing the two put "no org header" at the FRONT of the list for
     * every cookie token, ahead of the cookie's own org; whatever org the
     * gateway then picks for us is not necessarily the one the user is
     * looking at. Omitting the header is a last resort unless it is what
     * worked last time.
     */
    const tenants = [];
    const seen = new Set();
    const candidate = (id, source) => {
      if (id === undefined || seen.has(id)) return;
      seen.add(id);
      tenants.push({ id, source });
    };
    candidate(cred.tenant || undefined, "captured beside this token");
    candidate(preferredTenant, "pinned from an earlier success");
    candidate(tenantId || undefined, "current_organization_uid cookie");
    candidate(null, "no org header");

    let response, text, tenantUsed, tenantIdUsed;
    for (const tenant of tenants) {
      /* The SOURCE, never the id: an organization id is account data, and
         this is the object the diagnostic prints. The id is kept separately,
         to be pinned on success and sent — never rendered. */
      tenantUsed = tenant.source;
      tenantIdUsed = tenant.id;
      const withTenant = tenant.id
        ? { ...headers, "x-upwork-api-tenantid": tenant.id }
        : headers;

      response = await fetch(UPWORK_GQL_AUTH_DETAILS, {
        method: "POST",
        credentials: "include",
        headers: { ...withTenant, authorization: `Bearer ${token}` },
        body: JSON.stringify({ query, variables: { id: jobId, isLoggedIn: true } }),
      });
      text = await response.text();

      /*
       * The one refusal that is about neither the token nor the query. Trying
       * the next TOKEN cannot help — they would all be sent the same wrong org
       * — so the retry has to happen here, against the same bearer.
       */
      if (!TENANT_REFUSED.test(text)) break;
      report?.push({
        cookie: name,
        status: response.status,
        outcome: "wrong organization",
        tenant: tenant.source,
      });
    }

    /*
     * The body was read as TEXT, whatever the status. Three reasons: a GraphQL
     * validation error comes back as HTTP 400 with the offending field named
     * in the body, which returning early on !response.ok threw away; a
     * Cloudflare challenge comes back as HTML, which is not a session problem
     * at all but is indistinguishable from one once the body has been
     * discarded; and the gateway's own refusals are not GraphQL at all.
     */
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      // Not JSON — the snippet below is then the only evidence there is.
    }

    /*
     * Two envelopes, because Upwork uses two. A GraphQL error arrives as
     * `errors: [...]`; a refusal from the gateway IN FRONT of GraphQL arrives
     * as a bare `{ "message": "..." }` with a 403. Reading only the first is
     * what made "provided tenant (organization) id could not be found" show
     * up as a contentless "token refused (HTTP 403)" — and sent the user off
     * to re-open a job page, which mints a new token and fixes nothing.
     *
     * Kept whole for the report: the blocked-field list is the diagnosis and
     * it runs well past any sensible one-line length.
     */
    const message = payload?.errors?.length
      ? String(payload.errors[0].message || "")
      : payload && typeof payload.message === "string"
        ? payload.message
        : null;

    /* Only when there is no GraphQL error to quote, and never for a success. */
    const snippet = payload || response.ok ? null : text.trim().slice(0, 200);

    const note = (outcome) => {
      lastAuthError = `${outcome}${
        message
          ? `: ${message.slice(0, 300)}`
          : ` (HTTP ${response.status}${payload ? "" : ", non-JSON body"})`
      }`;
      report?.push({
        cookie: name,
        status: response.status,
        outcome,
        error: message,
        blocked: blockedFields(message),
        tenant: tenantUsed,
        body: snippet,
      });
    };

    /*
     * Data first, errors second. GraphQL answers a partly-authorised query
     * with BOTH: the fields the token may read are populated and the ones it
     * may not come back null, alongside an error naming them. Reading the
     * error first and bailing threw away a perfectly good job description
     * because the client's stats were out of scope.
     */
    const details = payload?.data?.jobAuthDetails ?? null;
    if (details) {
      preferredAuthToken = token;
      /* Pin the org that actually worked, so the next job does not re-walk
         the candidates to reach the same answer. */
      preferredTenant = tenantIdUsed;
      report?.push({
        cookie: name,
        status: response.status,
        outcome: message ? "ok (partial)" : "ok",
        error: message,
        blocked: blockedFields(message),
        tenant: tenantUsed,
        body: null,
      });
      return { data: details, fatal: false };
    }

    /*
     * Every organization we could name was refused for this bearer. That is
     * not an expired token, so it says so plainly: minting a fresh one — what
     * "token refused" sets in motion — produces another token for the same
     * account and the same wrong org, and the user is told to go and do
     * something that cannot work.
     */
    if (message && TENANT_REFUSED.test(message)) {
      rejected++;
      dead?.add(token);
      note("wrong organization");
      tenantBlamed = true;
      continue;
    }

    /*
     * A scope error that names the ROOT means this token cannot reach the
     * endpoint at all, and another token might. One that names leaf fields
     * means the token is fine and the QUERY asked for too much — no other
     * token will do better, but a narrower shape will. Treating both as
     * "token refused" is what made a field-scope problem present itself as a
     * sign-in problem, and short-circuited the very fallbacks that fix it.
     */
    const scoped = message && /oauth2 permissions|scopes to access/i.test(message);
    const rootBlocked = scoped && /Query\.jobAuthDetails|\bjobAuthDetails\b(?!\.)/.test(message);

    if (
      response.status === 401 ||
      response.status === 403 ||
      (scoped && rootBlocked) ||
      (message && !scoped && /not authorized|unauthenticated|invalid[_ ]token/i.test(message))
    ) {
      rejected++;
      dead?.add(token);
      note("token refused");
      continue;
    }

    if (message) {
      /* About the QUERY, so more tokens cannot help — the caller moves on to
         the next candidate shape instead. */
      note(scoped ? "fields out of scope" : "query rejected");
      return { data: null, fatal: true, error: message };
    }

    if (!response.ok) {
      note("request failed");
      return { data: null, fatal: false };
    }

    note("empty response");
    return { data: null, fatal: false };
  }

  /*
   * Every token was refused — nothing about the query shape is at fault.
   * `tried === 0` is the same verdict reached earlier: an earlier rung has
   * already refused all of them, so this rung had nothing left to ask with.
   */
  return {
    data: null,
    fatal: false,
    allRejected: rejected > 0 || (creds.length > 0 && tried === 0),
  };
}

/*
 * Never throws. These details are enrichment for the hover card: a session
 * without the right cookie, or schema drift in the outer layers, must show
 * less rather than break the row.
 */
async function fetchJobAuthDetails(jobId, jobUrl, report) {
  /* Per call: last time's diagnosis must not steer this one's remedy. */
  tenantBlamed = false;

  let creds = orderTokens(await collectAuthTokens(), preferredAuthToken);

  if (report) {
    report.cookiesFound = creds.map((c) => c.name);
    /* Said separately from the list above, because "none yet" is the single
       most likely reason a fresh install sees no card. */
    const cap = await loadCapturedAuth();
    report.captured = cap?.details
      ? `yes — from Upwork's job-details request, ${ageLabel(cap.details.at)}`
      : cap?.latest
        ? `only from a ${cap.latest.alias || "GraphQL"} request (${ageLabel(cap.latest.at)}), not the job-details one`
        : null;
  }

  /* Reading the jar is cheap and local; it is the requests that are not. A
     probe always asks, because being told "still cooling down" is not an
     answer to "what is wrong". */
  if (
    !report &&
    Date.now() < authUnavailableUntil &&
    creds.map((c) => c.token).join("|") === authFailedTokens
  ) {
    return null;
  }

  /*
   * Whatever went wrong, it went wrong with whichever tokens were in hand
   * LAST — which, after a refresh, is not the set this started from. Reading
   * `creds` at the moment the cooldown is set, rather than closing over the
   * original fingerprint, is what stops a freshly refreshed jar being locked
   * out for five minutes on the strength of the old one's failure.
   */
  const giveUp = () => {
    authUnavailableUntil = Date.now() + AUTH_COOLDOWN_MS;
    authFailedTokens = creds.map((c) => c.token).join("|");
    return null;
  };

  if (!creds.length) {
    lastAuthError =
      "No Upwork session token found. None of " +
      AUTH_TOKEN_COOKIE_NAMES.join(", ") +
      " is in the cookie jar." +
      AUTH_REMEDY;
    return giveUp();
  }

  const tenantId = await readCookie(TENANT_COOKIE);
  if (report) report.tenantFound = Boolean(tenantId);

  const order = [
    preferredAuthQuery,
    ...AUTH_EXTRAS.map((_, i) => i).filter((i) => i !== preferredAuthQuery),
  ];

  /*
   * Every query shape against whatever `creds` currently holds. `refused`
   * says the tokens were the problem rather than the query — the one failure
   * a fresh token can still do something about.
   */
  const attemptAll = async () => {
    /* Shared across every rung of one walk: see the skip in authGqlPost. */
    const dead = new Set();

    for (const index of order) {
      /*
       * One rung, re-asked only when the server blamed the question selection
       * — which it names, so this is a correction and not a search. Bounded by
       * the ladder itself: the last entry asks for no questions at all, so
       * this can run at most QUESTION_SELECTIONS.length times and then the
       * rung is judged on its own merits.
       */
      for (let retry = 0; retry < QUESTION_SELECTIONS.length; retry++) {
        const attempts = [];
        const asked = preferredQuestionShape;
        try {
          const res = await authGqlPost(
            buildAuthQuery(AUTH_EXTRAS[index], QUESTION_SELECTIONS[asked]),
            jobId,
            jobUrl,
            creds,
            tenantId,
            report ? attempts : null,
            dead
          );
          report?.shapes.push({ shape: index, questionShape: asked, attempts });

          if (res.data) {
            preferredAuthQuery = index;
            return { data: summarizeAuthDetails(res.data) };
          }

          /* Token problem, not a shape problem — the other shapes would fare
             no better against the same refusals. */
          if (res.allRejected) return { refused: true };

          /* The selection we guessed is what it rejected: drop one rung of the
             question ladder and ask this same rung again. */
          if (questionShapeBlamed(res.error, asked)) {
            preferredQuestionShape = asked + 1;
            continue;
          }
        } catch (err) {
          lastAuthError = `Network error: ${err?.message || "request failed"}`;
          report?.shapes.push({ shape: index, questionShape: asked, attempts, thrown: lastAuthError });
        }
        break;
      }
    }

    /*
     * Every shape was answered and none of them worked, which means the query
     * itself is wrong for this schema — a condition no token can fix.
     */
    return {};
  };

  let out = await attemptAll();

  /*
   * Every token was refused. That is the expiry case, and it is one the
   * extension can settle itself instead of printing a status code and asking
   * the user to go and open a page. One retry, and only when the refresh put
   * something in the jar that was not there before — otherwise this is the
   * same requests a second time for the same answer.
   */
  if (out.refused && !tenantBlamed) {
    const refreshed = await refreshAuthToken(jobId, jobUrl);
    const gained = refreshed.filter((c) => !creds.some((had) => had.token === c.token));
    if (report) report.refreshed = gained.map((c) => c.name);

    if (gained.length) {
      creds = orderTokens(refreshed, preferredAuthToken);
      out = await attemptAll();
    }
  }

  if (out.data) {
    authUnavailableUntil = 0;
    lastAuthError = null;
    return out.data;
  }

  /*
   * "token refused (HTTP 403)" says what happened and nothing about what to do
   * next. A refusal that survived a refresh is about the session itself — and
   * which remedy is true depends on WHY, because the org mismatch is the one
   * failure that a fresh token provably cannot fix.
   */
  const remedy = tenantBlamed ? TENANT_REMEDY : AUTH_REMEDY;
  if (out.refused && lastAuthError && !lastAuthError.includes(remedy)) {
    lastAuthError += `.${remedy}`;
  }

  return giveUp();
}

/*
 * The same call a hover makes, with the cooldown ignored and every attempt
 * recorded. Deliberately not a separate cut-down query: a diagnostic that
 * exercises a different code path can report success while the real one keeps
 * failing.
 */
async function probeAuthDetails(jobId, jobUrl) {
  const report = { cookiesFound: [], tenantFound: false, shapes: [], ok: false, error: null };
  const data = await fetchJobAuthDetails(jobId, jobUrl, report);

  report.ok = Boolean(data);
  report.error = data ? null : lastAuthError;
  if (data) report.got = Object.keys(data).filter((k) => data[k] !== null && k !== "fetchedAt");
  return report;
}

/* ── Normalising the authenticated payload ── */

/* Upwork sends its lists of places, languages and tools in several shapes. */
function labelList(input) {
  if (!input) return null;
  const items = Array.isArray(input) ? input : [input];
  const out = items
    .map((item) => {
      if (item === null || item === undefined) return null;
      if (typeof item === "string" || typeof item === "number") return String(item).trim();
      return (
        item.prefLabel || item.name || item.label || item.country || item.title || item.value || null
      );
    })
    .filter(Boolean);
  return out.length ? out : null;
}

const numberOrNull = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/* Mandatory skills lead; within a tier the order Upwork sent is kept. */
function skillList(sands) {
  const seen = new Set();
  const out = [];

  for (const group of [sands?.ontologySkills, sands?.additionalSkills]) {
    for (const skill of group || []) {
      const name = (skill?.prefLabel || skill?.freeText || "").trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      out.push({ name, relevance: skill?.relevance ?? null });
    }
  }

  const rank = (s) => (s.relevance === "MANDATORY" ? 0 : s.relevance === "NICE_TO_HAVE" ? 1 : 2);
  return out.length ? out.sort((a, b) => rank(a) - rank(b)) : null;
}

/*
 * Flattens jobAuthDetails into the one object the hover card renders. Every
 * branch is guarded: the narrower fallback queries return only the opening, so
 * `buyer`, `currentUserInfo` and the rest are routinely absent.
 */
function summarizeAuthDetails(details) {
  if (!details) return null;

  const job = details.opening?.job ?? {};
  const info = job.info ?? {};
  const quals = details.opening?.qualifications ?? {};
  const budget = job.extendedBudgetInfo ?? {};
  const activity = job.clientActivity ?? {};

  const buyer = details.buyer ?? {};
  const binfo = buyer.info ?? {};
  const stats = binfo.stats ?? {};
  const bjobs = binfo.jobs ?? {};
  const bloc = binfo.location ?? {};

  const hourlyMin = numberOrNull(budget.hourlyBudgetMin);
  const hourlyMax = numberOrNull(budget.hourlyBudgetMax);
  const fixedAmount = moneyValue(job.budget);
  const isHourly =
    /hourly/i.test(String(info.type ?? "")) || hourlyMin !== null || hourlyMax !== null;

  /*
   * Same keys as normalizeJobMeta, so priceLabel and the dashboard's terms row
   * read either source through one code path.
   */
  const meta = {
    type: isHourly ? "hourly" : fixedAmount ? "fixed" : null,
    hourlyMin,
    hourlyMax,
    /* A zero here means "hourly job, no fixed amount", not "free". */
    fixedAmount: isHourly ? null : fixedAmount || null,
    duration: job.engagementDuration?.label ?? null,
    engagement: job.workload ?? null,
    tier: job.contractorTier ?? null,
    postedAt: job.publishTime ?? job.postedOn ?? info.createdOn ?? null,
    title: info.title ? String(info.title).trim() : null,
  };

  const client = {
    location: [bloc.city, bloc.country].filter(Boolean).join(", ") || null,
    timezone: bloc.countryTimezone ?? null,
    score: numberOrNull(stats.score),
    feedbackCount: numberOrNull(stats.feedbackCount),
    postedJobs: numberOrNull(bjobs.postedCount),
    openJobs: numberOrNull(bjobs.openCount),
    totalSpent: moneyValue(stats.totalCharges),
    memberSince: binfo.company?.contractDate ?? null,
    totalHires: numberOrNull(stats.totalAssignments),
    activeContracts: numberOrNull(stats.activeAssignmentsCount),
    hoursBilled: numberOrNull(stats.hoursCount),
    jobsWithHires: numberOrNull(stats.totalJobsWithHires),
    avgHourlyRate: moneyValue(binfo.avgHourlyJobsRate),
    industry: binfo.company?.profile?.industry ?? null,
    companySize: binfo.company?.profile?.size ?? null,
    enterprise: buyer.enterprise ?? null,
    paymentVerified: buyer.isPaymentMethodVerified ?? null,
    phoneVerified:
      details.phoneVerificationStatus?.status === undefined
        ? null
        : /verified/i.test(String(details.phoneVerificationStatus.status)),
  };

  const matches = (details.currentUserInfo?.freelancerInfo?.qualificationsMatches?.matches || [])
    .map((m) => ({
      qualification: m?.qualification ?? null,
      wanted: m?.clientPreferredLabel ?? null,
      yours: m?.freelancerValueLabel ?? null,
      qualified: m?.qualified ?? null,
    }))
    .filter((m) => m.qualification);

  return {
    fetchedAt: Date.now(),
    meta,
    title: meta.title,
    status: job.status ?? null,
    description: job.description ? String(job.description).trim() : null,
    premium: info.premium ?? null,
    topClient: details.topClient ?? null,
    category: job.category?.name ?? null,
    categoryGroup: job.categoryGroup?.name ?? null,
    occupation: job.sandsData?.occupation?.prefLabel ?? null,
    skills: skillList(job.sandsData),
    durationWeeks: numberOrNull(job.engagementDuration?.weeks),
    budgetType: budget.hourlyBudgetType ?? null,
    currency: job.budget?.currencyCode ?? null,
    deliverables: job.deliverables ? String(job.deliverables).trim() : null,
    deadline: job.deadline ?? null,
    startDate: job.startDate ?? null,
    tools: labelList(job.tools),
    attachments: (job.attachments || [])
      .map((a) => ({
        name: a?.fileName ?? null,
        size: numberOrNull(a?.length),
        uri: a?.uri ?? null,
      }))
      .filter((a) => a.name),
    activity: {
      proposals: numberOrNull(activity.totalApplicants),
      hires: numberOrNull(activity.totalHired),
      interviewing: numberOrNull(activity.totalInvitedToInterview),
      invitesSent: numberOrNull(activity.invitationsSent),
      unansweredInvites: numberOrNull(activity.unansweredInvites),
      positions: numberOrNull(activity.numberOfPositionsToHire),
      lastViewedRaw: activity.lastBuyerActivity ?? null,
    },
    quals: {
      minScore: numberOrNull(quals.minJobSuccessScore),
      minHours: numberOrNull(quals.minOdeskHours),
      english: quals.prefEnglishSkill ?? null,
      risingTalent: quals.risingTalent ?? null,
      portfolio: quals.shouldHavePortfolio ?? null,
      localMarket: quals.localMarket ?? null,
      locationCheck: quals.locationCheckRequired ?? null,
      onSiteType: quals.onSiteType ?? null,
      countries: labelList(quals.countries),
      regions: labelList(quals.regions),
      states: labelList(quals.states),
      languages: labelList(quals.languages),
      timezones: labelList(quals.timezones),
      location:
        [quals.location?.city, quals.location?.state, quals.location?.country]
          .filter(Boolean)
          .join(", ") || null,
    },
    client,
    /* Comes back with the client's profile in the same payload — see
       HISTORY_SELECTION. `undefined` when the rung that answered did not
       include the buyer block at all. */
    history: buyer.workHistory === undefined ? undefined : workHistoryList(buyer.workHistory),
    /* Same payload as everything above it — see QUESTION_SELECTIONS. */
    questions: readQuestions(details.opening),
    matches: matches.length ? matches : null,
    applied: details.currentUserInfo?.freelancerInfo?.applied ?? null,
    owner: details.currentUserInfo?.owner ?? null,
  };
}

const UpworkApi = {
  getVisitorToken,
  getVisitorTokenAsync,
  refreshVisitorToken,
  listUpworkCookieNames,
  TOKEN_COOKIE_NAMES,
  SEARCH_TOKEN_COOKIE,
  SEARCH_PAGE_URL,
  parseJobId,
  fetchJobDetails,
  fetchJobActivity,
  fetchJobStatic,
  fetchFreelancerProfile,
  probeFreelancerProfile,
  extractProfileFromHtml,
  freelancerProfileUrl,
  fetchPastJobPrice,
  pastJobMeta,
  fetchJobAuthDetails,
  probeAuthDetails,
  getLastAuthError,
  loadCapturedAuth,
  CAPTURED_AUTH_KEY,
  CAPTURED_QUERIES_KEY,
  AUTH_ALIAS,
  summarizeAuthDetails,
  collectAuthTokens,
  AUTH_TOKEN_COOKIE_NAMES,
  probeJobSchema,
  fetchJobTitle,
  titleFromUrl,
  lookupJob,
  summarizeJob,
  summarizeStatic,
  summarizeActivity,
  formatRelativeTime,
  formatAbsoluteTime,
};

if (typeof globalThis !== "undefined") {
  globalThis.UpworkApi = UpworkApi;
}
