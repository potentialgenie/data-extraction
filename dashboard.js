const TRACKED_JOBS_KEY = "trackedJobs";
const ACTIVITY_LOG_KEY = "activityLog";
/* Written by the worker — see JOB_DETAILS_KEY in background.js. */
const JOB_DETAILS_KEY = "jobDetails";

const jobsBadge = document.getElementById("jobsBadge");
const logBadge = document.getElementById("logBadge");

const addJobBtn = document.getElementById("addJobBtn");
const addForm = document.getElementById("addForm");
const nameInput = document.getElementById("nameInput");
const urlInput = document.getElementById("urlInput");
const formError = document.getElementById("formError");
const cancelBtn = document.getElementById("cancelBtn");
const saveJobBtn = document.getElementById("saveJobBtn");

const jobsTable = document.getElementById("jobsTable");
const jobsBody = document.getElementById("jobsBody");
const emptyJobs = document.getElementById("emptyJobs");
const tagFilterBar = document.getElementById("tagFilterBar");
const jobSubtabs = document.getElementById("jobSubtabs");
const emptyTitle = document.getElementById("emptyTitle");
const emptyHint = document.getElementById("emptyHint");

const logList = document.getElementById("logList");
const emptyLog = document.getElementById("emptyLog");
const clearLogBtn = document.getElementById("clearLogBtn");

const lookupInput = document.getElementById("lookupInput");
const lookupBtn = document.getElementById("lookupBtn");
const lookupActivityBtn = document.getElementById("lookupActivityBtn");
const lookupTrackBtn = document.getElementById("lookupTrackBtn");
const lookupStatus = document.getElementById("lookupStatus");
const lookupResult = document.getElementById("lookupResult");

const checkNowBtn = document.getElementById("checkNowBtn");
const openTabBtn = document.getElementById("openTabBtn");

let checking = false;
let cycleError = null;
/* jobId → job, refreshed on render so the ring ticker needs no storage reads. */
const ringJobs = new Map();

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function loadTrackedJobs() {
  const stored = await chrome.storage.local.get(TRACKED_JOBS_KEY);
  return Array.isArray(stored[TRACKED_JOBS_KEY]) ? stored[TRACKED_JOBS_KEY] : [];
}

async function saveTrackedJobs(jobs) {
  await chrome.storage.local.set({ [TRACKED_JOBS_KEY]: jobs });
}

const JOB_GROUPS_KEY = "jobGroups";

async function loadGroups() {
  const stored = await chrome.storage.local.get(JOB_GROUPS_KEY);
  return Array.isArray(stored[JOB_GROUPS_KEY]) ? stored[JOB_GROUPS_KEY] : [];
}

async function saveGroups(groups) {
  await chrome.storage.local.set({ [JOB_GROUPS_KEY]: groups });
}

async function loadActivityLog() {
  const stored = await chrome.storage.local.get(ACTIVITY_LOG_KEY);
  return Array.isArray(stored[ACTIVITY_LOG_KEY]) ? stored[ACTIVITY_LOG_KEY] : [];
}

function normalizeJobId(input) {
  return UpworkApi.parseJobId(input);
}

function setFormError(message) {
  formError.textContent = message || "";
  formError.classList.toggle("error", Boolean(message));
}

function openAddForm() {
  addForm.classList.remove("hidden");
  nameInput.value = "";
  urlInput.value = "";
  setFormError("");
  urlInput.focus();
}

function closeAddForm() {
  addForm.classList.add("hidden");
  setFormError("");
}

/* Falls back through: the real job title → the title slug in the URL → the job ID. */
async function resolveJobName(url, jobId) {
  try {
    const res = await chrome.runtime.sendMessage({ type: "upwork-simple:title", input: url });
    if (res?.ok && res.title) return res.title;
  } catch {
    // Fall through to the offline fallbacks below.
  }
  return UpworkApi.titleFromUrl(url) || jobId;
}

async function addJob() {
  const url = urlInput.value.trim();
  const jobId = normalizeJobId(url);
  if (!jobId) {
    setFormError("Could not find a job ID in that URL.");
    return;
  }

  const jobs = await loadTrackedJobs();
  if (jobs.some((job) => job.id === jobId)) {
    setFormError("This job is already tracked.");
    return;
  }

  let name = nameInput.value.trim();
  if (!name) {
    saveJobBtn.disabled = true;
    saveJobBtn.textContent = "Fetching title…";
    setFormError("");
    try {
      name = await resolveJobName(url, jobId);
    } finally {
      saveJobBtn.disabled = false;
      saveJobBtn.textContent = "Add job";
    }
  }

  jobs.unshift({
    id: jobId,
    url,
    name,
    /* Lands in the tab being looked at — the tabbed equivalent of "here". All
       and Unassigned both mean "no tab", which is what null says. */
    groupId: isRealGroup(activeGroupId) ? activeGroupId : null,
    addedAt: new Date().toISOString(),
    lastChecked: null,
    lastError: null,
    lastStats: null,
  });

  await saveTrackedJobs(jobs);
  closeAddForm();
  await refreshJobs();
  void requestCheck();
}

async function removeJob(jobId) {
  const jobs = await loadTrackedJobs();
  const job = jobs.find((j) => j.id === jobId);
  if (!job) return;

  const name = job.name || job.url || job.id;
  const hasDraft = Boolean(job.draft && job.draft.trim());

  const ok = await askConfirm({
    title: "Remove job?",
    /* Says exactly what is lost. The activity log keeps its entries, so this
       does not claim otherwise. */
    message:
      `<strong>${escapeHtml(name)}</strong> will stop being tracked.` +
      (hasDraft ? " Its saved proposal draft will be deleted." : ""),
    okLabel: "Remove",
  });
  if (!ok) return;

  /* Re-read rather than reusing the list from before the dialog: on a 5s tier
     several checks can land while it is open, and filtering the stale copy
     would write those fresh results back out. */
  const fresh = await loadTrackedJobs();
  await saveTrackedJobs(fresh.filter((j) => j.id !== jobId));
  await refreshJobs();
}

function paymentPill(stats) {
  if (!stats || stats.paymentVerified === null || stats.paymentVerified === undefined) return "—";
  return stats.paymentVerified
    ? `<span class="pill pill-verified">Verified</span>`
    : `<span class="pill pill-unverified">Unverified</span>`;
}

/* Payment is a priority field, so its previous state is struck through too. */
function paymentCell(job, stats) {
  const pill = paymentPill(stats);
  const alerted = job.alerts?.paymentVerified;
  const was = alerted ?? job.changes?.paymentVerified;
  if (was === null || was === undefined) return pill;

  const cls = alerted === null || alerted === undefined ? "was" : "was was-alert";
  return `<span class="${cls}">${escapeHtml(was)}</span> ${pill}`;
}

/*
 * Tag palette, in swatch order: the two muted hues first, then once around the
 * colour wheel — red, orange, yellow, green, teal, blue, indigo, purple, pink.
 * Neighbours in the row are neighbours in hue, so picking by eye means moving
 * in one direction rather than hunting.
 *
 * The names are also CSS class suffixes (.c-teal), so the list is the single
 * source of truth for both the swatch row and the chip. They are kept stable
 * for that reason: "amber" wears a yellow and "sky" a blue, because a rename
 * would strand every tag already stored under the old name.
 *
 * Red is in the set at the user's request. Note it is also the alert colour in
 * this UI, so a red tag on an alerting row reads as part of the alert.
 */
const TAG_COLORS = [
  "slate",
  "brown",
  "red",
  "orange",
  "amber",
  "emerald",
  "teal",
  "sky",
  "indigo",
  "violet",
  "pink",
];
const DEFAULT_TAG_COLOR = "slate";

/* Anything unrecognised — hand-edited storage, a colour dropped in a later
   version — falls back rather than rendering an unstyled chip. */
const tagColorOf = (job) =>
  TAG_COLORS.includes(job?.tagColor) ? job.tagColor : DEFAULT_TAG_COLOR;

/*
 * `filterable` renders the chip as a button that filters the list to its tag.
 * The editor's preview passes false: there it is a picture of the chip, not a
 * control, and a focusable button inside a dialog would be one more tab stop
 * on the way to the proposal field.
 */
function tagChip(job, filterable = false) {
  const text = job?.tag?.trim();
  if (!text) return "";

  const body = escapeHtml(text);
  const cls = `tag-chip c-${tagColorOf(job)}`;
  if (!filterable) return `<span class="${cls}">${body}</span>`;

  return (
    `<button type="button" class="${cls}" data-tag-filter="${body}" ` +
    `title="Show only jobs tagged &quot;${body}&quot;">${body}</button>`
  );
}

/*
 * What the copy-link button hands over. `job.url` is whatever was pasted when
 * the job was added, and the Add/Lookup fields both accept a bare "~021234…",
 * so it is not always a URL — fall back to the canonical job page built from
 * the ID rather than copying a fragment nobody can open.
 */
function shareUrl(job) {
  const url = (job.url || "").trim();
  return /^https?:\/\//i.test(url) ? url : `https://www.upwork.com/jobs/${job.id}`;
}

function jobCell(job) {
  const label = job.name || job.url || job.id;
  const id = escapeHtml(job.id);

  /*
   * The title carries three gestures, all bound in one place further down:
   * hover shows the client profile, one click opens the job, two open the
   * editor.
   * It stays an <a> so the href is real — middle-click and "open in new tab"
   * keep working, and the status bar still previews the destination.
   *
   * The tag leads the row, inside .job-head — it keeps its width while the
   * title shrinks and ellipsises, so a long title cannot push it out of view.
   */
  return (
    `<div class="job-head">` +
    tagChip(job, true) +
    `<a class="job-name" href="${escapeHtml(job.url)}" target="_blank" rel="noopener" ` +
    `data-client-id="${id}">${escapeHtml(label)}</a>` +
    /* Trails the title text itself rather than sitting in a column, so it
       reads as belonging to that job's name. Outside the <a> on purpose: the
       title's own click gestures never see it. */
    `<button type="button" class="job-copy-link" data-copy-url="${escapeHtml(shareUrl(job))}" ` +
    `title="Copy job link" aria-label="Copy job link">${ICON.link}</button>` +
    `</div>` +
    (job.lastError ? `<span class="job-sub error">${escapeHtml(job.lastError)}</span>` : "")
  );
}

/* ── Sub-tabs: one named group of jobs at a time ── */

/*
 * Null is "All". Held in memory, like the tabs above it: opening the dashboard
 * lands on the whole list, and a group you cannot see the contents of is a bad
 * thing to restore silently.
 */
let activeGroupId = null;

/*
 * The tab for jobs in no tab at all. Without it those jobs exist only inside
 * All, where they cannot be seen as a set — and the counts stop adding up,
 * since All is everything and the named tabs are only their own.
 */
const NO_GROUP = "__none";

/* Cached from the last render so handlers can name a group without re-reading
   storage on every click. */
let groupsCache = [];

const groupName = (id) =>
  id === NO_GROUP ? "Unassigned" : groupsCache.find((g) => g.id === id)?.name || "";

/* Named tabs can be renamed and removed; All and Unassigned are neither. */
const isRealGroup = (id) => Boolean(id) && id !== NO_GROUP;

function renderSubTabs(jobs) {
  /*
   * A name being typed lives inside this strip, and rebuilding would throw it
   * away mid-word. Committing always refreshes, so the counts are late by one
   * edit rather than lost.
   */
  if (jobSubtabs.querySelector(".subtab-input")) return;

  /* Selecting a tab rebuilds the strip, which destroys the element the user
     was standing on — without this, arrow keys walked focus into the body. */
  const keepFocus = jobSubtabs.contains(document.activeElement);

  const counts = new Map();
  let loose = 0;
  for (const job of jobs) {
    if (job.groupId) counts.set(job.groupId, (counts.get(job.groupId) || 0) + 1);
    else loose++;
  }

  const tab = (id, label, count, extra = "") =>
    `<button type="button" class="subtab${id === activeGroupId ? " active" : ""}" ` +
    `role="tab" aria-selected="${id === activeGroupId}" ` +
    `tabindex="${id === activeGroupId ? 0 : -1}" ` +
    `data-group-id="${escapeHtml(id ?? "")}" ` +
    `title="${
      isRealGroup(id)
        ? "Double-click to rename · Delete to remove · drop a job here to move it"
        : id === NO_GROUP
          ? "Jobs that are in no tab · drop a job here to take it out of its tab"
          : "Every tracked job"
    }">` +
    `<span class="subtab-name">${escapeHtml(label)}</span>` +
    `<span class="subtab-badge">${count}</span>${extra}</button>`;

  /*
   * One segmented block, then the add button outside it: the block is the set
   * of places a job can be, and adding a new one is not one of those places.
   */
  jobSubtabs.innerHTML =
    `<div class="subtab-group" role="tablist" aria-label="Job tabs">` +
    tab(null, "All", jobs.length) +
    groupsCache
      .map((group) =>
        tab(
          group.id,
          group.name,
          counts.get(group.id) || 0,
          /* Only on the tab you are looking at, so a list of groups is not a
             row of delete buttons. Hidden from screen readers because Delete
             does the same job for the keyboard. */
          group.id === activeGroupId
            ? `<span class="subtab-x" data-remove-group="${escapeHtml(group.id)}" ` +
              `aria-hidden="true" title="Remove this tab">&#215;</span>`
            : ""
        )
      )
      .join("") +
    /* Only while something is actually loose — an Unassigned tab reading 0 is
       just a tab that does nothing. */
    (loose ? tab(NO_GROUP, "Unassigned", loose) : "") +
    `</div>` +
    `<button type="button" class="subtab-add" id="subtabAddBtn" ` +
    `title="New tab" aria-label="New tab">+</button>`;

  const active = jobSubtabs.querySelector(".subtab.active");
  /* With the strip scrolling sideways, the tab you are on has to be in view. */
  active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  if (keepFocus) active?.focus();
}

/* Shared by add and rename: one text field living in the bar itself, so the
   tab appears where it will end up rather than in a dialog somewhere else. */
function subtabInput(value, onCommit, anchor) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "subtab-input";
  input.maxLength = 24;
  input.spellcheck = false;
  input.value = value;
  anchor.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;
  const finish = (save) => {
    if (settled) return;
    settled = true;
    const next = input.value.trim();

    /*
     * Taken out before anything refreshes. renderSubTabs refuses to rebuild
     * while this field is on screen — that is what stops a background check
     * from eating a half-typed name — so leaving it in place would block the
     * very render that replaces it.
     */
    input.remove();

    /* An empty name is "never mind", not "call it nothing". */
    if (save && next) void onCommit(next);
    else void refreshJobs();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

async function addGroup(name) {
  const groups = await loadGroups();
  const existing = groups.find((g) => g.name.toLowerCase() === name.toLowerCase());
  /* A second tab with the same name would be indistinguishable, so this opens
     the one that already exists instead of making a twin. */
  if (existing) {
    activeGroupId = existing.id;
    showToast(`"${existing.name}" already exists`);
    await refreshJobs();
    return;
  }

  const group = { id: `g${Date.now().toString(36)}`, name };
  groups.push(group);
  await saveGroups(groups);
  /* Lands on the new tab: it is empty, and that is the cue to put jobs in it. */
  activeGroupId = group.id;
  await refreshJobs();
}

async function renameGroup(id, name) {
  const groups = await loadGroups();
  const group = groups.find((g) => g.id === id);
  if (group) {
    group.name = name;
    await saveGroups(groups);
  }
  await refreshJobs();
  jobSubtabs.querySelector(".subtab.active")?.focus();
}

async function removeGroup(id) {
  const jobs = await loadTrackedJobs();
  const held = jobs.filter((job) => job.groupId === id).length;

  const ok = await askConfirm({
    title: "Remove tab?",
    /* Says where the jobs go, since removing a tab that holds work reads as
       destructive and is not. */
    message:
      `<strong>${escapeHtml(groupName(id))}</strong> will be removed.` +
      (held
        ? held === 1
          ? " Its 1 job stays tracked and moves back to All."
          : ` Its ${held} jobs stay tracked and move back to All.`
        : ""),
    okLabel: "Remove tab",
  });
  if (!ok) return;

  await saveGroups((await loadGroups()).filter((g) => g.id !== id));

  const fresh = await loadTrackedJobs();
  for (const job of fresh) if (job.groupId === id) job.groupId = null;
  await saveTrackedJobs(fresh);

  if (activeGroupId === id) activeGroupId = null;
  await refreshJobs();
}

jobSubtabs.addEventListener("click", (e) => {
  const remove = e.target.closest("[data-remove-group]");
  if (remove) {
    /* Sits inside the tab button; without this the tab would also activate. */
    e.stopPropagation();
    void removeGroup(remove.dataset.removeGroup);
    return;
  }

  if (e.target.closest("#subtabAddBtn")) {
    subtabInput("", addGroup, document.getElementById("subtabAddBtn"));
    return;
  }

  const tab = e.target.closest(".subtab");
  if (!tab) return;
  const id = tab.dataset.groupId || null;
  if (id === activeGroupId) return;
  activeGroupId = id;
  /* A tag filter belongs to the list you were looking at, not to this one. */
  tagFilter = null;
  void refreshJobs();
});

/*
 * Drag a row by its grip and drop it on a tab. The row drag already exists for
 * reordering, so this is the same gesture aimed somewhere else — and the bar
 * lights up as a target only while a drag is actually in progress.
 */
async function moveJobToGroup(jobId, groupId, label) {
  const jobs = await loadTrackedJobs();
  const job = jobs.find((j) => j.id === jobId);
  if (!job || (job.groupId || null) === groupId) return;

  job.groupId = groupId;
  await saveTrackedJobs(jobs);
  await refreshJobs();
  /* The row usually vanishes from the current view when it moves, so the toast
     is the only confirmation that it went somewhere rather than away. Named
     after the tab that took it, which is what the user aimed at. */
  showToast(`Moved to ${label || groupName(groupId) || "All"}`);
}

const clearDropTarget = () =>
  jobSubtabs.querySelectorAll(".is-drop").forEach((el) => el.classList.remove("is-drop"));

/*
 * Everything a finished drag has to undo. Called from drop as well as dragend:
 * a drop re-renders the table, which removes the very node dragend would have
 * fired on, and a dragend that never arrives used to leave every tab outlined
 * and refreshJobs deferred behind isDragging.
 */
function endRowDrag() {
  isDragging = false;
  dragId = null;
  clearDropMarkers();
  jobSubtabs.classList.remove("can-drop");
  clearDropTarget();
  jobsBody.querySelectorAll(".is-dragging").forEach((el) => el.classList.remove("is-dragging"));
  jobsBody.querySelectorAll("tr[draggable]").forEach((row) => {
    row.draggable = false;
  });
}

jobSubtabs.addEventListener("dragover", (e) => {
  const tab = e.target.closest(".subtab");
  if (!tab || !dragId) return;
  /* Without preventDefault the browser refuses the drop. */
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  clearDropTarget();
  tab.classList.add("is-drop");
});

jobSubtabs.addEventListener("dragleave", (e) => {
  e.target.closest(".subtab")?.classList.remove("is-drop");
});

jobSubtabs.addEventListener("drop", (e) => {
  const tab = e.target.closest(".subtab");
  if (!tab || !dragId) return;
  e.preventDefault();

  /* Captured before the drag state is torn down, which has to happen first:
     until isDragging clears, refreshJobs defers and the list would not move
     until the pointer was released somewhere else. */
  const jobId = dragId;
  const target = tab.dataset.groupId || null;
  endRowDrag();

  /* All and Unassigned both mean "out of any tab" — the editor calls it None. */
  void moveJobToGroup(jobId, target === NO_GROUP ? null : target, groupName(target) || "All");
});

jobSubtabs.addEventListener("dblclick", (e) => {
  const tab = e.target.closest(".subtab");
  const id = tab?.dataset.groupId;
  if (!isRealGroup(id)) return;
  subtabInput(groupName(id), (name) => renameGroup(id, name), tab);
});

/*
 * A tab strip is expected to answer the arrow keys, and the × is a decoration
 * a keyboard cannot reach — so Delete does the removing. One tab stop for the
 * whole strip, the way the colour palette works in the editor.
 */
function focusTabAt(index) {
  const tabs = [...jobSubtabs.querySelectorAll(".subtab")];
  if (!tabs.length) return;
  /* Wraps, so the strip is a loop rather than two dead ends. Focus first, so
     the re-render that follows knows the strip had it and puts it back on the
     tab that is now selected. */
  const next = tabs[(index + tabs.length) % tabs.length];
  next.focus();
  next.click();
}

jobSubtabs.addEventListener("keydown", (e) => {
  const tab = e.target.closest(".subtab");
  if (!tab) return;

  const tabs = [...jobSubtabs.querySelectorAll(".subtab")];
  const at = tabs.indexOf(tab);

  if (e.key === "ArrowRight" || e.key === "ArrowDown") {
    e.preventDefault();
    focusTabAt(at + 1);
  } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
    e.preventDefault();
    focusTabAt(at - 1);
  } else if (e.key === "Home") {
    e.preventDefault();
    focusTabAt(0);
  } else if (e.key === "End") {
    e.preventDefault();
    focusTabAt(tabs.length - 1);
  } else if (e.key === "Delete" || e.key === "Backspace") {
    /* Same confirmation the × goes through — nothing is removed on a keypress
       alone. */
    if (!isRealGroup(tab.dataset.groupId)) return;
    e.preventDefault();
    void removeGroup(tab.dataset.groupId);
  }
});

/*
 * The sub-tab strip sticks under the main tabs, so it needs that row's height.
 * Measured rather than hardcoded: the tabs wrap on a narrow panel, and a wrong
 * offset would either float the strip in a gap or slide it under the tabs.
 */
function syncTabsHeight() {
  const tabs = document.querySelector(".db-tabs");
  if (!tabs) return;
  document.documentElement.style.setProperty("--tabs-h", `${Math.round(tabs.getBoundingClientRect().height)}px`);
}

syncTabsHeight();
/* Fires on wrap as well as on resize, which a window listener alone misses. */
new ResizeObserver(syncTabsHeight).observe(document.querySelector(".db-tabs"));

/* ── Filter the list to one tag ── */

/*
 * Null means "show everything". Held in memory only: a filter is a way of
 * looking at the list for a moment, not a setting, and finding the list
 * mysteriously short after a reload would be worse than retyping it.
 */
let tagFilter = null;

const jobTag = (job) => (job.tag || "").trim();

function applyTagFilter(tag) {
  tagFilter = tag || null;
  void refreshJobs();
}

/* Delegated: chips are rebuilt on every render. */
jobsBody.addEventListener("click", (e) => {
  const chip = e.target.closest("[data-tag-filter]");
  if (!chip) return;
  e.preventDefault();
  /* Clicking the tag you are already filtered to clears it, so the chip is a
     toggle rather than a one-way door. */
  applyTagFilter(chip.dataset.tagFilter === tagFilter ? null : chip.dataset.tagFilter);
});

function renderTagFilterBar() {
  if (!tagFilter) {
    tagFilterBar.classList.add("hidden");
    tagFilterBar.innerHTML = "";
    return;
  }

  /* Coloured like the chip that opened it, so the connection is obvious. */
  const sample = [...ringJobs.values()].find((job) => jobTag(job) === tagFilter);
  tagFilterBar.classList.remove("hidden");
  tagFilterBar.innerHTML =
    `<span class="filter-lead">Showing</span>` +
    tagChip({ tag: tagFilter, tagColor: sample?.tagColor }) +
    `<button type="button" class="btn btn-ghost btn-sm" id="tagFilterClear">Clear filter</button>`;

  document
    .getElementById("tagFilterClear")
    .addEventListener("click", () => applyTagFilter(null));
}

/* ── Client profile on hover ── */

const clientPop = document.getElementById("clientPop");

const money = (n) =>
  typeof n === "number" ? `$${Math.round(n).toLocaleString()}` : null;

/*
 * Job-terms formatting, shared by the hover panel and the lookup panel.
 */
/* "$25–$45/hr", "$25/hr" or "$1,500 fixed" — whichever the job actually is. */
function priceLabel(meta) {
  if (!meta) return null;

  /* Loose comparison on purpose: normalizeJobMeta writes explicit nulls, but a
     record from an older version — or one hand-edited — simply lacks the keys,
     and `undefined !== null` sent every fixed-price job down the hourly path,
     where it came out with no rate at all. */
  if (meta.type === "hourly" || meta.hourlyMin != null || meta.hourlyMax != null) {
    const lo = money(meta.hourlyMin);
    const hi = money(meta.hourlyMax);
    if (lo && hi && lo !== hi) return `${lo}–${hi}/hr`;
    if (lo || hi) return `${lo || hi}/hr`;
    return meta.type === "hourly" ? "Hourly" : null;
  }

  const fixed = money(meta.fixedAmount);
  if (fixed) return `${fixed} fixed`;
  return meta.type === "fixed" ? "Fixed price" : null;
}

/* Upwork's tier codes read as machine values; these are the labels it shows. */
const TIER_LABELS = {
  1: "Entry level",
  2: "Intermediate",
  3: "Expert",
  ENTRY_LEVEL: "Entry level",
  INTERMEDIATE: "Intermediate",
  EXPERT: "Expert",
};

/*
 * Upwork sends some of these as enum constants and some as the phrase it shows
 * on the job page. "MORE_THAN_6_MONTHS" is not something to put in front of a
 * user, and neither is guessing: an all-caps token is unpacked into words, and
 * anything already written for humans is left exactly as it came.
 */
function enumLabel(value) {
  const text = String(value ?? "").trim();
  /* Single-word constants count too — "ACTIVE" and "MANDATORY" are shouted at
     the user for exactly the same reason "MORE_THAN_6_MONTHS" is. */
  if (!text || !/^[A-Z0-9]+(_[A-Z0-9]+)*$/.test(text)) return text || null;
  const words = text.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/*
 * Upwork sends some of its dates as date-only values stamped midnight UTC.
 * Printed as a local instant those slide back to the previous evening — a
 * client who joined on the 4th reads as having joined the 3rd, at 8pm — so the
 * day is taken in UTC and the time dropped, since it never meant anything.
 */
function formatDay(input) {
  if (!input) return null;
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return null;

  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/* The workload line — "More than 30 hrs/week" on the job page. */
function workloadLabel(engagement) {
  const text = String(engagement ?? "").trim();
  if (!text) return null;
  if (/full.?time/i.test(text) || /^30\+/.test(text)) return "More than 30 hrs/week";
  if (/part.?time/i.test(text) || /less than 30/i.test(text)) return "Less than 30 hrs/week";
  return enumLabel(text);
}

/*
 * The terms the job page prints above the description, as pills — the rate
 * excluded, because it is rendered ahead of these and picked out in colour.
 * `meta` is whichever source is better: the authenticated details call returns
 * the budget and duration exactly as Upwork words them, and the job record's
 * own copy stands in until that lands.
 */
function termPills(meta) {
  return [
    workloadLabel(meta?.engagement),
    enumLabel(meta?.duration),
    meta?.tier ? TIER_LABELS[meta.tier] || enumLabel(meta.tier) : null,
  ].filter(Boolean);
}

/*
 * `stats` is the client profile. Payment comes in separately because it is the
 * one client value that changes, so it lives in the volatile half — passing it
 * in keeps it on the Client side of the panel where it belongs, rather than
 * dropping the row entirely.
 */
function clientRows(stats) {
  if (!stats) return [];

  const hireRate =
    typeof stats.jobsWithHires === "number" && stats.postedJobs > 0
      ? `${Math.round(Math.min(stats.jobsWithHires / stats.postedJobs, 1) * 100)}%`
      : null;

  return [
    ["Location", stats.location],
    ["Member since", formatDay(stats.memberSince)],
    [
      "Rating",
      typeof stats.score === "number" && stats.score > 0
        ? `${stats.score.toFixed(2)} / 5` +
          (stats.feedbackCount ? ` (${stats.feedbackCount})` : "")
        : null,
    ],
    ["Total spent", money(stats.totalSpent)],
    ["Jobs posted", stats.postedJobs],
    ["Hire rate", hireRate],
    ["Open jobs", stats.openJobs],
    ["Hires", stats.totalHires],
    ["Active contracts", stats.activeContracts],
    [
      "Avg rate paid",
      typeof stats.avgHourlyRate === "number" ? `$${stats.avgHourlyRate.toFixed(2)}/hr` : null,
    ],
    [
      "Hours billed",
      typeof stats.hoursBilled === "number" && stats.hoursBilled > 0
        ? Math.round(stats.hoursBilled).toLocaleString()
        : null,
    ],
    ["Company size", stats.companySize],
  ];
}

/* ── The hover card ──
 *
 * Hovering a job title opens the whole job page in miniature: description,
 * skills, terms, live activity, the client's profile and the qualifications
 * the client set — including, because the call is authenticated, whether this
 * account meets them.
 *
 * The data comes from jobAuthDetails, fetched on the first hover rather than
 * on a schedule: it is display-only, so nothing needs it until a row is
 * pointed at. What the job record already carries is rendered immediately, so
 * the card is never empty while that request is in the air.
 */

/* Matches the worker's own window — see DETAILS_TTL_MS in background.js. */
const DETAILS_TTL_MS = 30 * 60000;

/*
 * jobId → { state, data, error, at }. The worker keeps the durable copy under
 * its own storage key; this is hydrated from it on open and on every change,
 * which is what makes a reopened dashboard show a full card on the very first
 * hover rather than a spinner.
 */
const detailsCache = new Map();

async function hydrateDetailsCache() {
  const store = (await chrome.storage.local.get(JOB_DETAILS_KEY))[JOB_DETAILS_KEY] || {};

  for (const [id, held] of Object.entries(store)) {
    if (!held?.data) continue;
    /* Never downgrade a copy this session fetched more recently. */
    const cached = detailsCache.get(id);
    if (cached && (cached.at ?? 0) >= (held.at ?? 0)) continue;
    detailsCache.set(id, { state: "ok", data: held.data, at: held.at ?? 0 });
  }

  if (popJobId) renderClientPop();
  if (detailJobId) renderJobDetail();
}

let popJobId = null;
let popAnchor = null;
let popHideTimer = null;

/*
 * The card waits before appearing. Sweeping the pointer down a list of twenty
 * rows should not strobe twenty cards — this one is for a title you stopped
 * on, and the pause is what tells the two apart. It also means no details
 * request is made for a title merely passed over, since openClientPop is
 * where that starts.
 *
 * 500ms, arrived at from both ends. A second — where this started — is
 * Nielsen's limit for holding a train of thought, well past the point where
 * the card stops feeling connected to the hover that asked for it. 300ms
 * cleared transit (a pointer crosses a row in roughly 50–150ms) but came up
 * fast enough to feel twitchy while reading the list. 500 is the long-settled
 * middle: the classic tooltip delay, deliberate without dragging.
 */
const POP_SHOW_DELAY_MS = 500;

/*
 * Having just had a card up is itself a statement of intent, so the next one
 * comes almost at once: scanning six rows in a row should not mean six waits.
 * The window is short enough that coming back to the list a few seconds later
 * gets the considered delay again.
 */
const POP_WARM_DELAY_MS = 200;
const POP_WARM_WINDOW_MS = 1500;
let popLastShownAt = 0;
let popShowTimer = null;
/* Which job the countdown is for, so passing back over the same title does
   not restart it, and so any move elsewhere can call it off. */
let popPendingId = null;

function cancelPendingPop() {
  clearTimeout(popShowTimer);
  popShowTimer = null;
  popPendingId = null;
}


const detailsFor = (job) => (job ? (detailsCache.get(job.id)?.data ?? null) : null);
const detailsState = (job) => (job ? (detailsCache.get(job.id)?.state ?? "idle") : "idle");

function requestDetails(job) {
  if (!job) return;

  const cached = detailsCache.get(job.id);
  if (cached?.state === "loading") return;

  const have = cached?.data ?? null;
  const at = cached?.at ?? 0;
  if (have && Date.now() - at < DETAILS_TTL_MS) return;

  /* A failure is remembered briefly, so sweeping the pointer down a list of
     twenty rows does not fire twenty hopeless requests. */
  if (cached?.state === "error" && Date.now() - cached.at < 60000) return;

  /* Marked before the request goes out, so a card opening right now renders
     its "loading" footer on the first pass rather than a second one. */
  detailsCache.set(job.id, { state: "loading", data: have, at });

  const fail = (error) =>
    detailsCache.set(job.id, { state: "error", data: have, error, at: Date.now() });

  chrome.runtime
    .sendMessage({ type: "upwork-simple:details", jobId: job.id, url: job.url })
    .then((res) => {
      if (res?.ok && res.data) {
        /* The worker's stamp, not now: a copy it served from store is already
           part-way through its life and must not be given a fresh one. */
        detailsCache.set(job.id, { state: "ok", data: res.data, at: res.at ?? Date.now() });
      } else {
        fail(res?.error || "Upwork returned no details for this job.");
      }
    })
    .catch((err) => fail(err?.message || "Details request failed."))
    .finally(() => {
      if (popJobId === job.id) renderClientPop();
      if (detailJobId === job.id) renderJobDetail();
    });
}

/*
 * Two profiles of the same client, from two calls. Non-null wins, and the
 * authenticated one is passed last so it takes precedence where it has a
 * value — it is both fresher and more complete.
 */
function mergeNonNull(...sources) {
  const out = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source || {})) {
      if (value !== null && value !== undefined && value !== "") out[key] = value;
    }
  }
  return out;
}

/* Drops rows Upwork had nothing for — a wall of em-dashes helps nobody. Zero
   is kept: "Proposals 0" is a fact, and a useful one. */
const rowList = (rows) =>
  rows
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(
      ([label, value, title]) =>
        `<div class="cp-row"${title ? ` title="${escapeHtml(title)}"` : ""}>` +
        `<span>${escapeHtml(label)}</span>` +
        `<strong>${escapeHtml(String(value))}</strong></div>`
    )
    .join("");

/*
 * `action` rides in the heading, hard right — a copy control, where there is
 * one. It is only ever rendered alongside a body, so a section with nothing in
 * it can never offer to copy nothing.
 */
const cpSection = (head, body, action = "") =>
  body
    ? `<section class="cp-sec">` +
      `<div class="cp-head">${escapeHtml(head)}${action}</div>` +
      `${body}</section>`
    : "";

const COPY_LABELS = {
  description: "Description",
  skills: "Skills",
  questions: "Screening questions",
  proposal: "Proposal",
};

/*
 * Description, Skills and the screening questions are copied to be pasted
 * somewhere that needs to know both WHAT the block is and where it stops — a
 * prompt, usually — so they go over named and bracketed, one item to a line.
 * Pasting two of them in a row then reads as two labelled blocks rather than
 * as one run-on.
 *
 * The proposal is the exception: it goes into Upwork's own form, where a label
 * and a bracket are only things to delete again.
 */
const labelled = (kind, lines) => `${COPY_LABELS[kind]}:\n[\n${lines.join("\n")}\n]`;

const copyAction = (kind) => {
  const what = `Copy the ${COPY_LABELS[kind].toLowerCase()}`;
  return (
    `<button type="button" class="cp-copy" data-jd-copy="${kind}" ` +
    `title="${what}" aria-label="${what}">Copy</button>`
  );
};

const cpCol = (head, body, empty) =>
  `<div class="cp-col"><div class="cp-head">${escapeHtml(head)}</div>` +
  (body || `<div class="cp-empty">${escapeHtml(empty)}</div>`) +
  `</div>`;

/* What the client asked for. Thresholds of zero mean "no preference" — Upwork
   does not print those, and neither does this. */
function qualRows(details) {
  const q = details?.quals;
  if (!q) return "";

  const places = q.countries || q.regions || q.states || null;

  return rowList([
    ["Job success", q.minScore > 0 ? `At least ${Math.round(q.minScore)}%` : null],
    ["Hours billed", q.minHours > 0 ? `At least ${q.minHours.toLocaleString()}` : null],
    ["English", q.english && !/^any$/i.test(q.english) ? enumLabel(q.english) : null],
    ["Located in", places ? places.join(", ") : q.location],
    ["Languages", q.languages ? q.languages.join(", ") : null],
    ["Time zones", q.timezones ? q.timezones.join(", ") : null],
    ["Rising talent", q.risingTalent ? "Required" : null],
    ["Portfolio", q.portfolio ? "Required" : null],
    ["On site", q.onSiteType ? enumLabel(q.onSiteType) : null],
    ["Local only", q.localMarket ? "Yes" : null],
    ["ID check", q.locationCheck ? "Required" : null],
  ]);
}

/* "MinimumJobSuccessScore" → "Minimum job success score". */
const humanizeQual = (name) => {
  const words = String(name ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
};

/*
 * The half of this payload no public query can answer: for each qualification
 * the client set, what this account actually has, and whether it passes.
 *
 * The value shown is the freelancer's own — the client's ask is one column to
 * the left, and repeating it here under the heading "You have" would be the
 * one thing this section must not say.
 */
function matchRows(details) {
  if (!details?.matches?.length) return "";

  return details.matches
    .map((m) => {
      const mark =
        m.qualified === null || m.qualified === undefined
          ? ""
          : `<span class="cp-mark ${m.qualified ? "is-ok" : "is-no"}" aria-hidden="true">` +
            `${m.qualified ? "✓" : "✗"}</span>`;
      const value = m.yours || m.wanted || "—";
      const title = m.wanted ? `Client wants ${m.wanted} · you have ${m.yours || "—"}` : null;

      return (
        `<div class="cp-row"${title ? ` title="${escapeHtml(title)}"` : ""}>` +
        `<span>${escapeHtml(humanizeQual(m.qualification))}</span>` +
        `<strong>${escapeHtml(String(value))}${mark}</strong></div>`
      );
    })
    .join("");
}

/*
 * The questions a proposal will be made to answer, in the order Upwork asks
 * them. Worth knowing before writing one rather than after — which is why
 * they sit directly above the proposal panel.
 */
/*
 * Never returns "": on the detail slide these two sections are always shown,
 * because "this job asks nothing" and "we could not read it" are both things
 * worth knowing before writing a proposal — and a section that simply is not
 * there says neither. See the three states in readQuestions.
 */
/*
 * Both of these arrive with the rest of the payload now, so their empty text
 * is the SAME text every other section on the slide uses — no more sitting on
 * "not fetched yet" while the description beside them is already there.
 */
const notYet = (state) =>
  state === "loading" ? "Loading…" : state === "error" ? "Unavailable." : "Appears after the first check";

function questionBlock(job, state) {
  const list = detailsFor(job)?.questions;
  if (!list?.length) {
    return `<div class="cp-empty">${
      list === null ? "No screening questions on this job." : notYet(state)
    }</div>`;
  }

  return (
    `<ol class="jd-questions">` +
    list.map((q) => `<li>${escapeHtml(q)}</li>`).join("") +
    `</ol>`
  );
}

/*
 * Who this client has hired before, and what they said about them. The single
 * most useful thing about a client that a counter cannot tell you: whether
 * they finish contracts and how they talk about the people who did them.
 */
function historyBlock(job, state) {
  const rows = detailsFor(job)?.history;
  if (!rows?.length) {
    return `<div class="cp-empty">${
      rows === null ? "No completed contracts on this client's record yet." : notYet(state)
    }</div>`;
  }

  return (
    `<ul class="jd-history">` +
    rows
      .map((r) => {
        const when = [formatDay(r.startedAt), r.endedAt ? formatDay(r.endedAt) : "ongoing"]
          .filter(Boolean)
          .join(" – ");

        /*
         * "Ari (India • $10/hr)": where they are and what this client paid
         * them, right behind the name. The rate is the CONTRACT rate — what
         * actually changed hands here, which is the number a bidder wants —
         * with a fixed job's amount standing in for hourly rows that have
         * none. Whole dollars stay whole; "$10.00/hr" is not how anyone
         * says it.
         */
        /*
         * Two different rates, kept apart on purpose. Behind the name: who
         * the freelancer IS — their country and the rate on their PROFILE,
         * both from the profile lookup. On the facts line below: what
         * happened on THIS contract — the rate this client actually paid,
         * or the fixed amount. Mixing them would put "$5/hr" behind a
         * freelancer whose profile asks $15, and read as their rate.
         */
        const fmtRate = (n) => (Number.isInteger(n) ? n : n.toFixed(2));
        const profile = r.profile ? profileCache.get(r.profile) : null;
        const behindName = [
          profile?.country ?? null,
          typeof profile?.rate === "number" && profile.rate > 0 ? `$${fmtRate(profile.rate)}/hr` : null,
        ].filter(Boolean);
        const nameHtml =
          escapeHtml(r.freelancer || "Freelancer not named") +
          (behindName.length
            ? ` <span class="jh-facts">(${escapeHtml(behindName.join(" • "))})</span>`
            : "");
        /* Hovering the name answers "what do they do" — the profile title, and
           nothing else. Absent when the profile has not been read. */
        const hoverTitle = profile?.title ? ` title="${escapeHtml(profile.title)}"` : "";

        /*
         * The money on one line: what the job was POSTED at, then what was
         * PAID. The posted price is the client's own range or budget, read
         * off the job itself — so it is only there for public jobs, and only
         * once its lookup has landed; until then, or for a private job, the
         * contract type ("Hourly", "Fixed") stands in its place. The paid
         * half carries the hourly rate it was paid at, which is a different
         * number from the posted range and from the freelancer's own rate.
         * "$0 paid so far" is said outright for an open contract with hours
         * logged and nothing billed; the label leaves no room to read it as a
         * missing value.
         */
        const posted = r.jobKey ? jobPriceCache.get(r.jobKey) : null;
        const postedText = posted
          ? priceLabel(posted) || (posted.hidden ? "Budget hidden" : null)
          : null;
        const paidRate =
          typeof r.rate === "number" && r.rate > 0 ? ` at $${fmtRate(r.rate)}/hr` : "";
        const paid =
          typeof r.spent === "number"
            ? `${money(r.spent)} paid${r.endedAt ? "" : " so far"}${paidRate}`
            : null;
        const priceLine = [postedText ?? (r.type ? enumLabel(r.type) : null), paid]
          .filter(Boolean)
          .join(" • ");

        const facts = [
          typeof r.score === "number" && r.score > 0 ? `★ ${r.score.toFixed(2)}` : null,
          typeof r.hours === "number" && r.hours > 0
            ? `${Math.round(r.hours).toLocaleString()} hrs`
            : null,
          when || null,
        ].filter(Boolean);

        return (
          `<li class="jh-row">` +
          /*
           * Line 1 — Name (Country • Rate), then the open icon. The name is
           * text, so its hover is free to say what the freelancer does; the
           * icon is the link, to the same public page the client saw when
           * they hired. Upwork withholds the name on some contracts; the row
           * still earns its place, because the money and the reviews do not
           * depend on it. Line 2 — the job, linked when it has a public page.
           * Line 3 — the money. Then the rest.
           */
          `<div class="jh-top">` +
          `<span class="jh-who"${hoverTitle}>${nameHtml}</span>` +
          (r.profile
            ? `<a class="jh-open" href="https://www.upwork.com/freelancers/${escapeHtml(r.profile)}" ` +
              `target="_blank" rel="noopener" title="Open profile on Upwork" ` +
              `aria-label="Open profile on Upwork">${ICON.external}</a>`
            : "") +
          `</div>` +
          (r.title
            ? r.jobKey
              ? `<a class="jh-job" href="https://www.upwork.com/jobs/${escapeHtml(r.jobKey)}" ` +
                `target="_blank" rel="noopener" title="${escapeHtml(r.title)}">${escapeHtml(r.title)}</a>`
              : `<span class="jh-job" title="${escapeHtml(r.title)} — private job, no public page">` +
                `${escapeHtml(r.title)}</span>`
            : "") +
          (priceLine ? `<div class="jh-price">${escapeHtml(priceLine)}</div>` : "") +
          (facts.length ? `<div class="jh-meta">${escapeHtml(facts.join(" · "))}</div>` : "") +
          (r.comment ? `<p class="jh-note">${escapeHtml(r.comment)}</p>` : "") +
          /* The half that is about the client rather than the freelancer, and
             the reason this section is worth reading before bidding. */
          (r.clientComment
            ? `<p class="jh-note is-inbound">` +
              `<span class="jh-note-who">Said about this client` +
              (typeof r.clientScore === "number" && r.clientScore > 0
                ? ` · ★ ${r.clientScore.toFixed(2)}`
                : "") +
              `</span>${escapeHtml(r.clientComment)}</p>`
            : "") +
          `</li>`
        );
      })
      .join("") +
    `</ul>`
  );
}

function skillChips(details) {
  if (!details?.skills?.length) return "";

  const chips = details.skills
    .map(
      (s) =>
        `<span class="cp-skill${s.relevance === "MANDATORY" ? " is-must" : ""}"` +
        (s.relevance ? ` title="${escapeHtml(enumLabel(s.relevance) || "")}"` : "") +
        `>${escapeHtml(s.name)}</span>`
    )
    .join("");

  return `<div class="cp-chips">${chips}</div>`;
}

/* Upwork sends attachment sizes in bytes. */
const fileSize = (bytes) => {
  if (typeof bytes !== "number" || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
};

/*
 * The brief, clamped until asked for. Everything under it on this slide —
 * skills, the proposal box, the client — is below the fold on a long post
 * otherwise, and a brief is something you skim before deciding to read.
 */
function descriptionBlock(job, details) {
  const text = details?.description;
  if (!text) return "";

  /* A rough threshold: it only decides whether the toggle is offered at all.
     The clamp itself is CSS, so short briefs never grow a pointless button. */
  const long = text.length > 620;
  const open = expandedDescriptions.has(job.id);

  return (
    `<p class="cp-desc${long && !open ? " is-clamped" : ""}">${escapeHtml(text)}</p>` +
    (long
      ? `<button type="button" class="cp-more" data-cp-more>` +
        `${open ? "Show less" : "Show more"}</button>`
      : "")
  );
}

/*
 * The proposal, written where the job is being read rather than behind a
 * dialog. Saved on a debounce as you type, so there is no Save button to
 * forget — the dialog remains for the title, tag and tab.
 */
function draftPanelHtml(job) {
  const text = job.draft || "";

  return (
    `<textarea class="jd-draft" data-jd-draft spellcheck="true" ` +
    `placeholder="Write your proposal here…">${escapeHtml(text)}</textarea>` +
    /* No Copy button down here any more — it sits in the heading now, beside
       the two the other sections have. */
    `<div class="jd-draft-foot">` +
    `<span class="jd-draft-meta" data-jd-draft-meta>${text.length} characters</span>` +
    `</div>`
  );
}

/*
 * The counters, read from `lastStats` first: the polling query runs every few
 * seconds, so it is always fresher than a details payload that may be half an
 * hour old. The details fill in what polling does not ask for.
 */
function activityRows(job, details) {
  const live = job?.lastStats ?? {};
  const snap = details?.activity ?? {};
  const pick = (key) => ((live[key] ?? null) !== null ? live[key] : (snap[key] ?? null));
  const seenRaw = live.lastViewedRaw ?? snap.lastViewedRaw ?? null;

  return rowList([
    ["Proposals", pick("proposals")],
    ["Interviewing", pick("interviewing")],
    ["Invites sent", pick("invitesSent")],
    ["Unanswered", pick("unansweredInvites")],
    ["Hired", pick("hires")],
    /* Only worth a row when the client wants more than one person. */
    ["Openings", snap.positions > 1 ? snap.positions : null],
    [
      "Last viewed",
      seenRaw ? UpworkApi.formatRelativeTime(seenRaw) : null,
      seenRaw ? UpworkApi.formatAbsoluteTime(seenRaw) : null,
    ],
  ]);
}

/*
 * Everything both views derive from one job, worked out once. The hover card
 * uses the terms; the detail slide uses all of it.
 */
function jobFacts(job) {
  const details = detailsFor(job);
  /* The authenticated payload is authoritative where it has an answer. */
  const meta = mergeNonNull(job?.meta, details?.meta);
  const stats = mergeNonNull(job?.client, details?.client);

  const pills = termPills(meta);
  const postedAt = details?.meta?.postedAt || job?.meta?.postedAt || null;
  if (postedAt) pills.push(`Posted ${UpworkApi.formatRelativeTime(postedAt)}`);

  return {
    details,
    state: detailsState(job),
    meta,
    stats,
    postedAt,
    rate: priceLabel(meta),
    pills,
  };
}

/* The block Upwork prints above every job description, in the same order. */
const pillsHtml = ({ rate, pills }) =>
  rate || pills.length
    ? `<div class="cp-pills">` +
      (rate ? `<span class="cp-pill is-rate">${escapeHtml(rate)}</span>` : "") +
      pills.map((p) => `<span class="cp-pill">${escapeHtml(p)}</span>`).join("") +
      `</div>`
    : "";

/* "upwork.com/jobs/~0221…" — the address without the parts nobody reads. */
const linkLabel = (url) => String(url).replace(/^https?:\/\//i, "").replace(/^www\./i, "");

const stateNote = (job, state) =>
  state === "loading"
    ? `<span class="cp-state is-loading">Loading full job details…</span>`
    : state === "error"
      ? `<span class="cp-state is-error">${escapeHtml(
          detailsCache.get(job?.id)?.error || "Details unavailable."
        )}</span>`
      : "";

function cpBadges(job, details) {
  const badges = [];
  const add = (text, tone) => badges.push({ text, tone });

  if (details?.status && details.status !== "ACTIVE") add(enumLabel(details.status), "warn");
  if (details?.premium) add("Premium", "accent");
  if (details?.topClient) add("Top client", "accent");
  if (details?.client?.enterprise) add("Enterprise", "plain");
  if (details?.applied) add("Applied", "accent");
  else if (job?.applied) add("Applied", "accent");

  if (!badges.length) return "";
  return (
    `<div class="cp-badges">` +
    badges.map((b) => `<span class="cp-badge is-${b.tone}">${escapeHtml(b.text)}</span>`).join("") +
    `</div>`
  );
}

/*
 * The terms Upwork prints above a job description, as label/value rows.
 *
 * These are the whole Job column now. They used to run along the top of the
 * card as pills with category, status and skills beneath them — but pills are
 * a headline treatment, and next to a column of the client's plain rows they
 * read as a different kind of information than they are. As rows they line up
 * with Client and the two halves can be compared down the page. The detail
 * slide still leads with the pill bar, where it IS the headline.
 */
function jobTermRows({ meta, postedAt }) {
  return rowList([
    ["Rate", priceLabel(meta)],
    ["Workload", workloadLabel(meta?.engagement)],
    ["Duration", enumLabel(meta?.duration)],
    ["Level", meta?.tier ? TIER_LABELS[meta.tier] || enumLabel(meta.tier) : null],
    [
      "Posted",
      postedAt ? UpworkApi.formatRelativeTime(postedAt) : null,
      postedAt ? UpworkApi.formatAbsoluteTime(postedAt) : null,
    ],
  ]);
}

/*
 * The hover card answers the two questions asked before opening anything: what
 * is the job, and who is the client — as two columns under the terms bar. The
 * brief is not among them: it is paragraphs, it is the one thing here that
 * cannot be skimmed in a column, and it is the first thing on the detail
 * slide, which is one click away.
 */
function clientPopHtml(job) {
  const facts = jobFacts(job);
  const { details, state, stats } = facts;

  /* Same empty line for both halves, because the reason is the same one. */
  const waiting = `<div class="cp-empty">${
    state === "loading" ? "Loading…" : "Appears after the first check"
  }</div>`;

  const terms = jobTermRows(facts);
  const client = rowList(clientRows(stats));
  const url = shareUrl(job);

  return (
    /*
     * The job's own address, spelled out rather than hidden behind a word, and
     * above the columns because it says WHICH job everything below it is
     * about. The text copies it; the icon beside it opens the job. Scheme and
     * "www." are dropped from the label only — the href, the copied value and
     * the tooltip are all the real URL.
     */
    `<div class="cp-top">` +
    `<button type="button" class="cp-link" data-copy-url="${escapeHtml(url)}" ` +
    `title="Click to copy · ${escapeHtml(url)}">${escapeHtml(linkLabel(url))}</button>` +
    `<a class="cp-open" href="${escapeHtml(url)}" target="_blank" rel="noopener" ` +
    `title="Open the job on Upwork" aria-label="Open the job on Upwork">${ICON.external}</a>` +
    `</div>` +
    `<div class="cp-body">` +
    /* Side by side, split by a hairline, and matching row for row — which is
       the point of dropping the pill bar that used to sit above them. */
    `<div class="cp-cols">` +
    cpSection("Job", terms || waiting) +
    cpSection("Client", client || waiting) +
    `</div>` +
    `</div>` +
    /* The only place these gestures are discoverable, and the title's two are
       no longer what a row click does — so both get said. */
    `<div class="cp-foot">${stateNote(job, state)}` +
    `<span class="cp-hint">Click row for details · Title opens Upwork</span></div>`
  );
}

/* ── Slide two: one job in full ── */

const jobSlides = document.getElementById("jobSlides");
const jobDetail = document.getElementById("jobDetail");

let detailJobId = null;
/* Where the list was standing, so coming back does not dump you at the top. */
let listScrollY = 0;
/* Guards a needless innerHTML write — see renderJobDetail. */
let lastDetailHtml = "";
/* Which briefs have been opened out. Held here rather than in the slide, so a
   re-render mid-read does not collapse the text again. */
const expandedDescriptions = new Set();

function jobDetailHtml(job) {
  if (!job) return "";

  const facts = jobFacts(job);
  const { details, state, meta, stats } = facts;

  const crumbs = [details?.categoryGroup, details?.category, details?.occupation]
    .filter(Boolean)
    /* Dedupe: the occupation is often worded the same as the category. */
    .filter((value, i, all) => all.indexOf(value) === i);

  const extras = rowList([
    ["Starts", formatDay(details?.startDate)],
    ["Deadline", formatDay(details?.deadline)],
    /* Only when the duration pill above is missing — "9 weeks" under
       "1 to 3 months" is the same fact said twice. */
    [
      "Duration",
      !enumLabel(meta?.duration) && details?.durationWeeks
        ? `${details.durationWeeks} weeks`
        : null,
    ],
    ["Tools", details?.tools ? details.tools.join(", ") : null],
    ["Deliverables", details?.deliverables],
  ]);

  const attachments = details?.attachments?.length
    ? rowList(details.attachments.map((a) => [a.name, fileSize(a.size) || "—"]))
    : "";

  const waiting = state === "loading" ? "Loading…" : "Appears after the first check";

  /* The same fallback chain the row's title uses, so the two always agree. */
  const displayTitle = job.name || details?.title || job.url || job.id;

  return (
    `<div class="jd-head">` +
    `<button type="button" class="btn btn-icon jd-back" data-jd-back ` +
    `title="Back to the list" aria-label="Back to the list">${ICON.back}</button>` +
    `<div class="jd-titles">` +
    /*
     * The DISPLAY title — what the row shows and what the user chose to call
     * this job — rather than Upwork's own wording, which used to win here and
     * so quietly undid every rename the moment the slide opened. Upwork's
     * title is kept on the tooltip for the renamed case, where knowing what
     * the post is actually called is the whole reason to look.
     */
    `<div class="jd-titleline">${tagChip(job)}` +
    `<span class="jd-title"${
      details?.title && details.title !== displayTitle
        ? ` title="On Upwork: ${escapeHtml(details.title)}"`
        : ""
    }>${escapeHtml(displayTitle)}</span>` +
    `</div>` +
    (crumbs.length ? `<div class="cp-crumbs">${escapeHtml(crumbs.join(" · "))}</div>` : "") +
    `</div>` +
    `<div class="jd-actions">` +
    /* The proposal is written inline below now, so what this dialog is still
       uniquely for is the title, the tag and which tab the job sits in. */
    `<button type="button" class="btn btn-ghost btn-sm" data-jd-edit>Title &amp; tag</button>` +
    `<a class="btn btn-outline btn-sm" href="${escapeHtml(shareUrl(job))}" ` +
    `target="_blank" rel="noopener">Open on Upwork</a>` +
    `</div>` +
    `</div>` +
    `<div class="jd-body">` +
    cpBadges(job, details) +
    pillsHtml(facts) +
    cpSection("Description", descriptionBlock(job, details), copyAction("description")) +
    /* Directly under the brief, which is the only thing that explains them. */
    cpSection("Attachments", attachments) +
    cpSection("Skills", skillChips(details), copyAction("skills")) +
    /* Above the proposal, because they are part of writing one. */
    cpSection(
      details?.questions?.length === 1 ? "Screening question" : "Screening questions",
      questionBlock(job, state),
      /* questionBlock renders an explanatory line when there are none, so the
         section exists either way — but there is nothing to copy from it. */
      details?.questions?.length ? copyAction("questions") : ""
    ) +
    cpSection("Proposal", draftPanelHtml(job), copyAction("proposal")) +
    `<div class="cp-cols">` +
    cpCol("Activity", activityRows(job, details), waiting) +
    cpCol("Client", rowList(clientRows(stats)), waiting) +
    `</div>` +
    cpSection("Who this client hired before", historyBlock(job, state)) +
    (qualRows(details) || matchRows(details)
      ? `<div class="cp-cols">` +
        cpSection("Client wants", qualRows(details)) +
        cpSection("You have", matchRows(details)) +
        `</div>`
      : "") +
    cpSection("Other terms", extras) +
    (stateNote(job, state) ? `<div class="jd-state">${stateNote(job, state)}</div>` : "") +
    `</div>`
  );
}

/* ── Hired freelancers' profiles: the "(India • $10/hr)" behind a name ── */

/* profile key → { country, city, title, rate }, or null once looked up and
   found empty. Session-only; the worker keeps the durable copy. */
const profileCache = new Map();
const profilesRequested = new Set();
/* After a failed round trip, hold off — a render lands every few seconds on
   a hot job, and each one would otherwise re-ask the same dead question. */
let profilesRetryAt = 0;

/*
 * Asks the worker about whichever freelancers in this job's history are not
 * yet known. Called after every slide render, so a history that arrives a
 * second after the slide opened still gets its countries filled in.
 */
function requestProfilesFor(job) {
  if (Date.now() < profilesRetryAt) return;

  const keys = (detailsFor(job)?.history || [])
    .map((r) => r.profile)
    .filter((k) => k && !profileCache.has(k) && !profilesRequested.has(k));
  if (!keys.length) return;

  keys.forEach((k) => profilesRequested.add(k));

  chrome.runtime
    .sendMessage({ type: "upwork-simple:profiles", keys })
    .then((res) => {
      if (!res?.ok) throw new Error(res?.error || "no reply");
      for (const [key, data] of Object.entries(res.profiles || {})) profileCache.set(key, data);
      if (detailJobId === job.id) renderJobDetail();
    })
    .catch(() => {
      profilesRetryAt = Date.now() + 60000;
    })
    .finally(() => keys.forEach((k) => profilesRequested.delete(k)));
}

/*
 * What each past public job was POSTED at — the client's hourly range or
 * fixed budget — as opposed to what the contract paid. Same lazy, cached,
 * bounded shape as the profiles above; private jobs have no key and are
 * never asked about.
 */
const jobPriceCache = new Map();
const jobPricesRequested = new Set();
let jobPricesRetryAt = 0;

function requestJobPricesFor(job) {
  if (Date.now() < jobPricesRetryAt) return;

  const keys = (detailsFor(job)?.history || [])
    .map((r) => r.jobKey)
    .filter((k) => k && !jobPriceCache.has(k) && !jobPricesRequested.has(k));
  if (!keys.length) return;

  keys.forEach((k) => jobPricesRequested.add(k));

  chrome.runtime
    .sendMessage({ type: "upwork-simple:jobPrices", keys })
    .then((res) => {
      if (!res?.ok) throw new Error(res?.error || "no reply");
      for (const [key, meta] of Object.entries(res.prices || {})) jobPriceCache.set(key, meta);
      if (detailJobId === job.id) renderJobDetail();
    })
    .catch(() => {
      jobPricesRetryAt = Date.now() + 60000;
    })
    .finally(() => keys.forEach((k) => jobPricesRequested.delete(k)));
}

function renderJobDetail() {
  if (!detailJobId) return;

  const job = ringJobs.get(detailJobId);
  /* Removed from another window, or filtered out of existence. */
  if (!job) {
    closeJobDetail();
    return;
  }

  /*
   * A check lands every few seconds on a hot job and each one calls this.
   * Writing identical HTML back would still destroy a text selection and any
   * open native menu, so the write only happens when something moved.
   */
  const html = jobDetailHtml(job);
  if (html === lastDetailHtml) return;

  /*
   * The proposal box is the one thing here holding work that is not in
   * storage yet — up to half a second of typing, between keystroke and
   * debounced save. Replacing the slide under it would take that with it, and
   * the caret too. Its value survives the swap; everything else is rebuilt.
   */
  const box = jobDetail.querySelector("[data-jd-draft]");
  const keep = box && {
    value: box.value,
    start: box.selectionStart,
    end: box.selectionEnd,
    top: box.scrollTop,
    focused: document.activeElement === box,
  };

  lastDetailHtml = html;
  jobDetail.innerHTML = html;

  /* After the write, so the names are on screen before their countries are
     asked for — the parentheses fill in rather than hold the row up. */
  requestProfilesFor(job);
  requestJobPricesFor(job);

  const next = keep && jobDetail.querySelector("[data-jd-draft]");
  if (!next) return;

  next.value = keep.value;
  next.scrollTop = keep.top;
  if (keep.focused) {
    next.focus();
    next.setSelectionRange(keep.start, keep.end);
  }
}

/*
 * Typing saves itself. A Save button on a box you can walk away from just
 * loses proposals, and this pane has no modal edges to make "done" obvious.
 */
let draftTimer = null;
let pendingDraft = null;

function flushDraft() {
  clearTimeout(draftTimer);
  draftTimer = null;
  if (!pendingDraft) return;

  const { jobId, value } = pendingDraft;
  pendingDraft = null;
  void updateJob(jobId, { draft: value });
}

function queueDraftSave(jobId, value) {
  pendingDraft = { jobId, value };
  clearTimeout(draftTimer);
  draftTimer = setTimeout(flushDraft, 500);
}

const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");

/* A short travel, not a full-width sweep: at a side panel's width the latter
   reads as a page reload rather than as a step sideways. */
function slideIn(el, fromX) {
  if (!el || reducedMotion?.matches) return;
  el.animate(
    [
      { transform: `translateX(${fromX}px)`, opacity: 0 },
      { transform: "none", opacity: 1 },
    ],
    { duration: 220, easing: "cubic-bezier(0.32, 0.72, 0, 1)" }
  );
}

function openJobDetail(jobId) {
  const job = ringJobs.get(jobId);
  if (!job) return;

  /* The row it was opened from is about to be hidden, so its mouseout never
     fires and the card would hang over the detail. */
  hideClientPop();

  listScrollY = window.scrollY;
  detailJobId = jobId;
  lastDetailHtml = "";
  /* Emptied first so the proposal box of the job being left behind cannot be
     carried into the next one by the preservation in renderJobDetail. */
  jobDetail.innerHTML = "";
  renderJobDetail();

  jobSlides.classList.add("is-detail");
  window.scrollTo({ top: 0 });
  slideIn(jobDetail, 28);

  /* No-op when a fresh copy is already held. */
  requestDetails(job);
}

function closeJobDetail() {
  if (!detailJobId) return;

  /* Leaving is a commit — the debounce must not outlive the pane. */
  flushDraft();
  detailJobId = null;
  lastDetailHtml = "";
  jobSlides.classList.remove("is-detail");

  /* After the class flip, so the list is laid out and the offset is real. */
  window.scrollTo({ top: listScrollY });
  slideIn(jobSlides.querySelector(".slide-list"), -28);
}

jobDetail.addEventListener("click", (e) => {
  if (e.target.closest("[data-jd-back]")) {
    closeJobDetail();
    return;
  }

  if (e.target.closest("[data-jd-edit]") && detailJobId) {
    /* The dialog reads from storage, so anything still on the debounce has to
       land first or it would open showing the older text. */
    flushDraft();
    void openDraft(detailJobId);
    return;
  }

  if (e.target.closest("[data-cp-more]") && detailJobId) {
    if (expandedDescriptions.has(detailJobId)) expandedDescriptions.delete(detailJobId);
    else expandedDescriptions.add(detailJobId);
    renderJobDetail();
    return;
  }

  const copy = e.target.closest("[data-jd-copy]");
  if (copy) void copySlideSection(copy.dataset.jdCopy);
});

/* What each Copy control puts on the clipboard. See `labelled`. */
function slideClipboardText(kind) {
  if (kind === "proposal") {
    /* The box, not the record: what is on screen is what the user means, and
       the last keystroke may still be inside the debounce. */
    return jobDetail.querySelector("[data-jd-draft]")?.value ?? "";
  }

  const job = ringJobs.get(detailJobId);
  const details = detailsFor(job);

  if (kind === "questions") {
    const list = details?.questions || [];
    /* Numbered, as the <ol> on screen already shows them — and because the
       answers written against them will be numbered to match. */
    return list.length ? labelled(kind, list.map((q, i) => `${i + 1}. ${q}`)) : "";
  }

  if (kind === "description") {
    return details?.description ? labelled(kind, [details.description]) : "";
  }
  if (kind === "skills") {
    const names = (details?.skills || []).map((skill) => skill.name);
    return names.length ? labelled(kind, names) : "";
  }
  return "";
}

async function copySlideSection(kind) {
  const text = slideClipboardText(kind);
  if (!text.trim()) {
    showToast("Nothing to copy yet", "is-bad");
    return;
  }

  const ok = await writeClipboard(text);
  showToast(
    ok ? `${COPY_LABELS[kind]} copied` : "Could not access the clipboard",
    ok ? "" : "is-bad"
  );
}

jobDetail.addEventListener("input", (e) => {
  const box = e.target.closest("[data-jd-draft]");
  if (!box || !detailJobId) return;

  const meta = jobDetail.querySelector("[data-jd-draft-meta]");
  if (meta) meta.textContent = `${box.value.length} characters`;
  queueDraftSave(detailJobId, box.value);
});

/* Clicking away is as much a commit as closing the pane is. */
jobDetail.addEventListener("focusout", (e) => {
  if (e.target.closest("[data-jd-draft]")) flushDraft();
});

/*
 * A row click opens the detail. Everything in the row that already had a
 * gesture keeps it: the title link still opens Upwork in a new tab, the copy
 * button copies, the ring pauses and checks, a tag chip filters the list.
 */
jobsBody.addEventListener("click", (e) => {
  if (e.target.closest("a, button, [data-ring-id], .drag-handle")) return;

  const row = e.target.closest("tr[data-job-id]");
  if (!row || isDragging) return;

  /* A click that finishes a text selection is not a navigation. */
  if (!window.getSelection()?.isCollapsed) return;

  openJobDetail(row.dataset.jobId);
});

function hideClientPop() {
  clearTimeout(popHideTimer);
  cancelPendingPop();
  /* Stamped only when one was really up, so the warm window measures time
     since you last had a card — not since something called this. */
  if (clientPop.classList.contains("is-shown")) popLastShownAt = Date.now();
  clientPop.classList.remove("is-shown");
  popJobId = null;
  popAnchor = null;
}

/* Small grace period, so crossing the gap between the title and the card — or
   between two rows — does not close it. */
function scheduleHideClientPop() {
  clearTimeout(popHideTimer);
  popHideTimer = setTimeout(hideClientPop, 220);
}

function positionClientPop() {
  if (!popAnchor?.isConnected) return;

  const anchor = popAnchor.getBoundingClientRect();
  const pop = clientPop.getBoundingClientRect();
  const gap = 8;

  let left = anchor.left;
  if (left + pop.width > window.innerWidth - gap) {
    left = Math.max(gap, window.innerWidth - pop.width - gap);
  }

  /* Below by default, above when there is no room — and when neither side
     fits, pinned to whatever the window has. The card's own max-height means
     the measured height is already capped, so this cannot run off-screen. */
  let top = anchor.bottom + gap;
  if (top + pop.height > window.innerHeight - gap) top = anchor.top - pop.height - gap;
  if (top < gap) top = Math.max(gap, window.innerHeight - pop.height - gap);

  clientPop.style.left = `${Math.round(left)}px`;
  clientPop.style.top = `${Math.round(top)}px`;
}

/* Rebuilds the open card in place. Called when details arrive, and whenever a
   check refreshes the underlying job. */
function renderClientPop() {
  if (!popJobId) return;
  const job = ringJobs.get(popJobId);
  if (!job) return;

  /* Preserved across the rebuild so an arriving payload does not yank the
     reader back to the top of a description they were part-way through. */
  const body = clientPop.querySelector(".cp-body");
  const scrollTop = body?.scrollTop ?? 0;

  clientPop.innerHTML = clientPopHtml(job);
  const nextBody = clientPop.querySelector(".cp-body");
  if (nextBody && scrollTop) nextBody.scrollTop = scrollTop;

  positionClientPop();
}

function openClientPop(target) {
  const job = ringJobs.get(target.dataset.clientId);
  if (!job) return;

  const same = popJobId === job.id && clientPop.classList.contains("is-shown");
  popJobId = job.id;
  popAnchor = target;

  /* Ahead of the render, and a no-op when a fresh copy is already held — so a
     card that has to wait for the network opens already saying so. */
  requestDetails(job);

  if (!same) {
    clientPop.innerHTML = clientPopHtml(job);
    /* Shown before measuring, so the size the positioner reads is real. */
    clientPop.classList.add("is-shown");
  }

  positionClientPop();
}

/*
 * One delegated listener on the document rather than two on the table body.
 * The card is interactive now — it scrolls, its text can be selected, its
 * description expands — so moving the pointer INTO it must not dismiss it, and
 * a table re-render that destroys the anchor mid-hover must not leave it
 * stranded. Both fall out of asking "what is under the pointer now".
 */
document.addEventListener("mouseover", (e) => {
  if (clientPop.contains(e.target)) {
    clearTimeout(popHideTimer);
    return;
  }

  const anchor = e.target.closest?.("[data-client-id]");
  if (anchor) {
    clearTimeout(popHideTimer);
    const id = anchor.dataset.clientId;

    /* Already up for this job — keep it, and re-measure in case a re-render
       moved the row underneath it. */
    if (popJobId === id && clientPop.classList.contains("is-shown")) {
      cancelPendingPop();
      popAnchor = anchor;
      positionClientPop();
      return;
    }

    /* Its countdown is already running; a second pass must not restart it. */
    if (popPendingId === id) return;

    /* Moved onto a different title: whatever is open is about the wrong job
       now, so it goes at once rather than lingering through the new wait. */
    if (popJobId) hideClientPop();

    cancelPendingPop();
    popPendingId = id;
    const warm = Date.now() - popLastShownAt < POP_WARM_WINDOW_MS;
    popShowTimer = setTimeout(() => {
      popShowTimer = null;
      popPendingId = null;
      /* Looked up again rather than closed over: a check landing mid-wait
         rebuilds the table body, and the element captured a second ago is by
         then detached, which would place the card against a dead rectangle. */
      const live = jobsBody.querySelector(`[data-client-id="${CSS.escape(id)}"]`);
      if (live) openClientPop(live);
    }, warm ? POP_WARM_DELAY_MS : POP_SHOW_DELAY_MS);
    return;
  }

  /* Off every anchor: drop the countdown as well as the open card, or a card
     appears a second after the pointer has already moved on. */
  cancelPendingPop();
  if (popJobId) scheduleHideClientPop();
});

/*
 * The pointer left the window entirely — for the URL bar, another window, the
 * desktop. No mouseover follows, so without this a card that is already up has
 * nothing left to dismiss it and hangs over the list until the pointer comes
 * back and moves off a row.
 */
document.addEventListener("mouseleave", () => {
  cancelPendingPop();
  if (popJobId) scheduleHideClientPop();
});

clientPop.addEventListener("mouseleave", scheduleHideClientPop);

/* Escape backs out one layer at a time: the hover card first, then the slide. */
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (popJobId) hideClientPop();
  else closeJobDetail();
});

/*
 * A scroll or a drag would leave it stranded beside nothing — but the card has
 * its own scroller now, and scrolling the description is not a reason to close
 * the thing being read.
 */
window.addEventListener(
  "scroll",
  (e) => {
    if (clientPop.contains(e.target)) return;
    hideClientPop();
  },
  true
);
jobsBody.addEventListener("dragstart", hideClientPop);

/*
 * A changed value renders as the old figure struck through followed by the new
 * one. `job.changes` holds only fields that moved on the most recent completed
 * check and is cleared when the next one starts, so this is a momentary marker.
 */
/*
 * "+2" / "−1" shown once when a value actually moves. Driven by `job.moved`,
 * which the worker clears at the start of every check — so a sticky alert that
 * stays undismissed cannot make the badge re-fire on each later check.
 *
 * Numeric fields only: a timestamp or a payment boolean has no useful delta.
 */
function deltaBadge(job, key, value) {
  const was = job.moved?.[key];
  if (typeof was !== "number" || typeof value !== "number") return "";

  const diff = value - was;
  if (!diff) return "";

  const token = `${job.id}:${key}:${was}:${value}`;
  if (playedBadges.has(token)) return "";
  /* Cheap bound: one token per movement, so this only grows slowly. */
  if (playedBadges.size > 600) playedBadges.clear();
  playedBadges.add(token);

  const sign = diff > 0 ? "+" : "−";
  return `<span class="delta-badge">${sign}${Math.abs(diff)}</span>`;
}

function delta(job, key, value) {
  const shown = value ?? "—";

  /* Sticky red alert (priority fields) takes precedence over the calm marker. */
  const alerted = job.alerts?.[key];
  if (alerted !== null && alerted !== undefined) {
    return (
      `<span class="was was-alert">${escapeHtml(alerted)}</span> ` +
      `<span class="now now-alert">${escapeHtml(shown)}</span>` +
      deltaBadge(job, key, value)
    );
  }

  const was = job.changes?.[key];
  if (was === null || was === undefined) return String(shown);
  return (
    `<span class="was">${escapeHtml(was)}</span> ` +
    `<span class="now">${escapeHtml(shown)}</span>` +
    deltaBadge(job, key, value)
  );
}

function hasAlerts(job) {
  return Boolean(job.alerts && Object.keys(job.alerts).length);
}

/* ── Countdown ring ── */

/* Fallback only — each job carries its own adaptive interval. */
const DEFAULT_INTERVAL_MS = 60000;
const RING_R = 9;
const RING_C = 2 * Math.PI * RING_R;

/* Badges already played this page session, so a re-render cannot replay them. */
const playedBadges = new Set();
/* Jobs we have already asked to refresh, cleared when their data comes back. */
const requested = new Set();

function ringCell(job, extraClass = "") {
  const secs = Math.round((job.checkIntervalMs || DEFAULT_INTERVAL_MS) / 1000);
  const title = job.paused
    ? "Paused — click to resume, double-click to check once"
    : `Refreshes every ${secs}s · click to pause, double-click to check now`;

  /*
   * The arc and label are rendered at their CURRENT values, not at zero.
   *
   * They used to be hardcoded to dashoffset="0" and an empty label, with
   * tickRings filling them in on its next 1s beat. Since any storage write
   * re-renders the whole table, every other job's ring snapped to a full circle
   * and blank label for up to a second — and .ring-fill has a 1s transition, so
   * it animated the wrong value on its way back. One job finishing a check made
   * every other ring visibly jump.
   */
  const interval = job.checkIntervalMs || DEFAULT_INTERVAL_MS;
  const remainingMs = Math.max(0, (job.nextCheckAt ?? Date.now()) - Date.now());
  const progress = job.paused ? 1 : 1 - Math.min(1, remainingMs / interval);
  const label = job.paused ? "&#8214;" : String(Math.ceil(remainingMs / 1000));

  return (
    `<span class="ring ${extraClass}${job.paused ? " is-paused" : ""}" ` +
    `data-ring-id="${escapeHtml(job.id)}" title="${escapeHtml(title)}">` +
    `<svg viewBox="0 0 24 24" aria-hidden="true">` +
    `<circle class="ring-track" cx="12" cy="12" r="${RING_R}"></circle>` +
    `<circle class="ring-fill" cx="12" cy="12" r="${RING_R}" ` +
    `stroke-dasharray="${RING_C.toFixed(2)}" ` +
    `stroke-dashoffset="${(RING_C * progress).toFixed(2)}"></circle>` +
    `</svg>` +
    `<span class="ring-label">${label}</span>` +
    `</span>`
  );
}

/* Updates rings in place — never re-renders the table, which would restart
   every change animation and throw away the badge state. */
function tickRings() {
  const now = Date.now();

  document.querySelectorAll("[data-ring-id]").forEach((el) => {
    const job = ringJobs.get(el.dataset.ringId);
    if (!job) return;

    const label = el.querySelector(".ring-label");
    const fill = el.querySelector(".ring-fill");

    if (checking || requested.has(job.id)) {
      el.classList.add("is-busy");
      if (label) label.textContent = "";
      return;
    }
    el.classList.remove("is-busy");

    /*
     * Paused: no countdown, no due check. The ring is drawn empty and holds a
     * pause glyph, so a stopped job is obvious at a glance in a long list.
     */
    if (job.paused) {
      el.classList.add("is-paused");
      el.classList.remove("is-hot");
      if (label) label.textContent = "‖";
      if (fill) fill.setAttribute("stroke-dashoffset", RING_C.toFixed(2));
      return;
    }
    el.classList.remove("is-paused");

    const interval = job.checkIntervalMs || DEFAULT_INTERVAL_MS;
    const remainingMs = Math.max(0, (job.nextCheckAt ?? now) - now);
    const seconds = Math.ceil(remainingMs / 1000);
    if (label) label.textContent = String(seconds);
    if (fill) {
      const progress = 1 - Math.min(1, remainingMs / interval);
      fill.setAttribute("stroke-dashoffset", (RING_C * progress).toFixed(2));
    }
    /* Fast tiers mean the ring is visibly quick — mark it so it reads as "hot". */
    el.classList.toggle("is-hot", interval <= 10000);

    /* Due: ask the worker to refresh just this job. */
    if (remainingMs <= 0) checkJobNow(job.id);
  });
}

async function dismissAlerts(jobId) {
  const jobs = await loadTrackedJobs();
  const job = jobs.find((j) => j.id === jobId);
  if (!job) return;
  job.alerts = null;
  await saveTrackedJobs(jobs);
  await refreshJobs();
}

/*
 * The status badge can say "4 jobs need attention" while the only way to act on
 * that was a per-row Clear button — four separate clicks to get back to a clean
 * list. Not destructive: the activity log keeps every event this dismisses.
 */
async function dismissAllAlerts() {
  const jobs = await loadTrackedJobs();
  let cleared = false;

  jobs.forEach((job) => {
    if (hasAlerts(job)) {
      job.alerts = null;
      cleared = true;
    }
  });

  if (!cleared) return;
  await saveTrackedJobs(jobs);
  await refreshJobs();
}

document.getElementById("dismissAllBtn").addEventListener("click", () => void dismissAllAlerts());

/* ── Manual ordering (drag and drop) ── */

/* Stored order is the display order, so a re-render must not fight a drag. */
let isDragging = false;
let pendingRefresh = false;
let dragId = null;

async function reorderJobs(fromId, toId, placeAfter) {
  if (!fromId || fromId === toId) return;

  const jobs = await loadTrackedJobs();
  const from = jobs.findIndex((job) => job.id === fromId);
  const to = jobs.findIndex((job) => job.id === toId);
  if (from === -1 || to === -1) return;

  const [moved] = jobs.splice(from, 1);
  /* Recomputed after the splice: removing the dragged row shifts later indexes. */
  const target = jobs.findIndex((job) => job.id === toId);
  jobs.splice(placeAfter ? target + 1 : target, 0, moved);

  await saveTrackedJobs(jobs);
  await refreshJobs();
}

/*
 * FLIP: rows are rebuilt by innerHTML, so they cannot be transitioned directly.
 * Record where each row was, let the new markup land, then translate each row
 * back to its old position and release it — the browser animates the gap.
 */
function capturePositions() {
  const positions = new Map();
  jobsBody.querySelectorAll("tr[data-job-id]").forEach((row) => {
    positions.set(row.dataset.jobId, row.getBoundingClientRect().top);
  });
  return positions;
}

function playReorder(previous) {
  if (!previous || !previous.size) return;
  /* Inline transforms bypass CSS media queries, so check the preference here. */
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const moves = [];
  jobsBody.querySelectorAll("tr[data-job-id]").forEach((row) => {
    const before = previous.get(row.dataset.jobId);
    if (before === undefined) {
      /* Newly added row: fade it in rather than letting it pop. */
      row.classList.add("is-entering");
      setTimeout(() => row.classList.remove("is-entering"), 420);
      return;
    }
    const delta = before - row.getBoundingClientRect().top;
    /* Sub-pixel drift is not movement worth animating. */
    if (Math.abs(delta) < 1) return;
    moves.push(row);
    row.style.transition = "none";
    row.style.transform = `translateY(${delta}px)`;
  });

  if (!moves.length) return;

  /*
   * Forced reflow, not requestAnimationFrame. Inside a single frame the browser
   * can coalesce "apply inverted transform" and "clear it" into one style
   * recalculation, so no transition ever runs. Reading offsetHeight commits the
   * inverted position first, which is what gives the release something to
   * animate from.
   */
  void jobsBody.offsetHeight;

  for (const row of moves) {
    row.style.transition = "transform 300ms cubic-bezier(0.32, 0.72, 0, 1)";
    row.style.transform = "";
  }

  /* Inline styles removed once settled so they cannot fight the next render. */
  setTimeout(() => {
    for (const row of moves) {
      row.style.transition = "";
      row.style.transform = "";
    }
  }, 340);
}

function clearDropMarkers() {
  jobsBody.querySelectorAll(".drop-before, .drop-after").forEach((el) => {
    el.classList.remove("drop-before", "drop-after");
  });
}

/* Delegated so the handlers survive the innerHTML re-render. */
jobsBody.addEventListener("mousedown", (e) => {
  const handle = e.target.closest(".drag-handle");
  const row = e.target.closest("tr");
  /* Rows are only draggable while the grip is held, so text stays selectable
     and the job link does not start a link-drag. */
  if (handle && row) row.draggable = true;
});

document.addEventListener("mouseup", () => {
  jobsBody.querySelectorAll("tr[draggable]").forEach((row) => {
    row.draggable = false;
  });
});

jobsBody.addEventListener("dragstart", (e) => {
  const row = e.target.closest("tr");
  if (!row) return;
  isDragging = true;
  dragId = row.dataset.jobId;
  row.classList.add("is-dragging");
  /* Tabs are drop targets too — say so, but only for the length of the drag. */
  jobSubtabs.classList.add("can-drop");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", dragId);
});

/*
 * Placement follows the drag direction, not the pointer's position within the
 * row. With a midpoint test, dragging row 1 onto the top half of row 2 resolves
 * to "insert before row 2" — where it already was — so half of every adjacent
 * hover was a silent no-op. Direction makes the whole row a live target.
 */
function placeAfterTarget(row) {
  const rows = [...jobsBody.querySelectorAll("tr[data-job-id]")];
  const from = rows.findIndex((r) => r.dataset.jobId === dragId);
  const to = rows.indexOf(row);
  return to > from;
}

jobsBody.addEventListener("dragover", (e) => {
  const row = e.target.closest("tr");
  if (!row || !dragId || row.dataset.jobId === dragId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";

  clearDropMarkers();
  row.classList.add(placeAfterTarget(row) ? "drop-after" : "drop-before");
});

jobsBody.addEventListener("drop", (e) => {
  const row = e.target.closest("tr");
  if (!row || !dragId || row.dataset.jobId === dragId) return;
  e.preventDefault();

  const after = placeAfterTarget(row);
  clearDropMarkers();
  void reorderJobs(dragId, row.dataset.jobId, after);
});

jobsBody.addEventListener("dragend", () => {
  /* Also resets draggable: mouseup does not fire after a drag, and without it
     the row stays draggable from anywhere, not just its grip. */
  endRowDrag();
  /* A check that landed mid-drag was deferred; apply it now. */
  if (pendingRefresh) {
    pendingRefresh = false;
    void refreshJobs();
  }
});

/*
 * Formatted at render time from the raw timestamp, not read back from the
 * string the worker stored at fetch time — otherwise a 60s-tier job displays a
 * value that is already a minute stale.
 */
function liveViewed(stats) {
  if (!stats) return null;
  return stats.lastViewedRaw
    ? UpworkApi.formatRelativeTime(stats.lastViewedRaw)
    : stats.lastViewed ?? null;
}

/* How fresh the client's last look was — drives the dot colour so a list of
   jobs can be scanned for "who is active right now" at a glance. */
function activityTone(raw) {
  if (!raw) return "none";
  const hours = (Date.now() - new Date(raw).getTime()) / 3600000;
  if (Number.isNaN(hours)) return "none";
  if (hours < 2) return "hot";
  if (hours < 24) return "warm";
  return "cold";
}

/* Green badge when the client's payment method is verified, red when it is not. */
function paymentMark(job, stats) {
  if (stats.paymentVerified === null || stats.paymentVerified === undefined) return "";

  const alerted = job.alerts?.paymentVerified;
  const was = alerted !== null && alerted !== undefined ? alerted : job.changes?.paymentVerified;
  const prefix =
    was === null || was === undefined
      ? ""
      : `<span class="was${alerted !== null && alerted !== undefined ? " was-alert" : ""}">` +
        `${escapeHtml(was)}</span> `;

  return stats.paymentVerified
    ? `${prefix}<span class="pay-badge is-ok" title="Payment method verified">` +
        `&#10003; Verified</span>`
    : `${prefix}<span class="pay-badge is-bad" title="Payment method not verified">` +
        `&#9888; Unverified</span>`;
}

/* One metric in the aligned strip: big number, small label beneath. Always
   rendered, including zeros — every job shows every figure. */
function metricCell(job, key, label, full, value) {
  const alerted = job.alerts?.[key];
  const isAlert = alerted !== null && alerted !== undefined;
  const was = isAlert ? alerted : job.changes?.[key];
  const changed = was !== null && was !== undefined;

  const state = isAlert ? " is-alert" : changed ? " is-changed" : !(value > 0) ? " is-zero" : "";

  return (
    `<div class="metric${state}" title="${escapeHtml(full)}">` +
    `<span class="metric-val">` +
    (changed ? `<span class="was${isAlert ? " was-alert" : ""}">${escapeHtml(was)}</span> ` : "") +
    escapeHtml(value ?? "—") +
    deltaBadge(job, key, value) +
    `</span>` +
    `<span class="metric-lab">${escapeHtml(label)}</span>` +
    `</div>`
  );
}

/*
 * The narrow-screen view of a row: a hero line carrying the one signal that
 * matters (how recently the client looked) and a fixed metric strip beneath,
 * with every figure shown — including zeros. Nothing here is hidden.
 */
function summaryCell(job) {
  const s = job.lastStats;
  if (!s) {
    return (
      `<div class="sum-hero"><span class="hero-idle">` +
      `${job.lastError ? "Check failed" : "Not checked yet"}</span>${ringCell(job, "sum-ring")}</div>`
    );
  }

  const viewAlert = job.alerts?.lastViewed;
  const viewAlerted = viewAlert !== null && viewAlert !== undefined;
  const tone = viewAlerted ? "alert" : activityTone(s.lastViewedRaw);

  const viewedText = liveViewed(s);
  const viewedExact = s.lastViewedRaw ? UpworkApi.formatAbsoluteTime(s.lastViewedRaw) : null;

  const hero =
    `<div class="sum-hero">` +
    `<span class="hero-dot tone-${tone}"></span>` +
    (viewAlerted ? `<span class="was was-alert">${escapeHtml(viewAlert)}</span> ` : "") +
    `<span class="hero-time${viewAlerted ? " is-alert" : ""}"` +
    (viewedExact ? ` title="Client last active ${escapeHtml(viewedExact)}"` : "") +
    `>${viewedText ? escapeHtml(viewedText) : "no client activity"}</span>` +
    paymentMark(job, s) +
    (job.applied ? `<span class="applied-tag">Applied</span>` : "") +
    ringCell(job, "sum-ring") +
    `</div>`;

  const metrics =
    `<div class="sum-metrics">` +
    metricCell(job, "proposals", "Proposals", "Total proposals", s.proposals) +
    metricCell(job, "interviewing", "Interview", "Interviewing", s.interviewing) +
    metricCell(job, "invitesSent", "Invited", "Invites sent", s.invitesSent) +
    metricCell(job, "unansweredInvites", "No reply", "Invites the client sent that got no reply", s.unansweredInvites) +
    metricCell(job, "hires", "Hired", "Hired", s.hires) +
    `</div>`;

  return hero + metrics;
}

const ICON = {
  copy: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
  check: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
  close: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
  link: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
  back: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>`,
  /* Box with an arrow leaving it — the one glyph everybody already reads as
     "opens somewhere else". Same shape the open-in-a-tab button uses. */
  external: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>`,
};

function actionsCell(job) {
  const id = escapeHtml(job.id);
  const hasDraft = Boolean(job.draft && job.draft.trim());

  /*
   * The countdown leads the cluster, in the slot the editor button used to
   * hold — the editor now opens from a double-click on the title. It no longer
   * has a column of its own, so the title starts at the left edge of the row.
   *
   * The card layout has its own ring in the summary hero, so this one is
   * hidden there rather than rendered twice.
   */
  return (
    (hasAlerts(job)
      ? `<button type="button" class="btn btn-sm alert-clear" data-dismiss-id="${id}" ` +
        `title="Dismiss this alert">Clear</button>`
      : "") +
    ringCell(job, "row-ring") +
    `<button type="button" class="btn btn-icon btn-xs" data-copy-id="${id}" ` +
    `title="${hasDraft ? "Copy proposal to clipboard" : "No draft to copy yet"}"` +
    `${hasDraft ? "" : " disabled"}>${ICON.copy}</button>` +
    `<button type="button" class="btn btn-icon btn-xs${job.applied ? " is-on" : ""}" ` +
    `data-applied-id="${id}" ` +
    `title="${job.applied ? "Applied — click to unmark" : "Mark as applied"}">${ICON.check}</button>` +
    `<button type="button" class="btn btn-icon btn-xs is-remove" data-remove-id="${id}" ` +
    `title="Remove job">${ICON.close}</button>`
  );
}

function renderJobsTable(jobs) {
  jobsTable.classList.toggle("hidden", jobs.length === 0);
  emptyJobs.classList.toggle("hidden", jobs.length !== 0);

  /* "No jobs tracked yet" would be a lie inside an empty tab, and the way out
     of one is different: move a job in, or add one while it is open. */
  if (!jobs.length) {
    emptyTitle.textContent = isRealGroup(activeGroupId)
      ? `Nothing in "${groupName(activeGroupId)}" yet`
      : "No jobs tracked yet";
    emptyHint.innerHTML = isRealGroup(activeGroupId)
      ? `Add a job while this tab is open, or set <strong>Tab</strong> in a job's editor.`
      : `Click <strong>+ Add Job</strong> and paste an Upwork job URL to start monitoring.`;
  }

  /* Reserves the tag gutter only when a tag is actually in play, so an untagged
     list keeps its full width for titles. */
  jobsTable.classList.toggle("has-tags", jobs.some((job) => jobTag(job)));

  /* Only offered when there is more than one alert to clear — with a single
     one the row's own Clear button is right there. */
  document
    .getElementById("dismissAllBtn")
    .classList.toggle("hidden", jobs.filter(hasAlerts).length < 2);

  ringJobs.clear();
  jobs.forEach((job) => ringJobs.set(job.id, job));

  /* Stored order is the user's order — no automatic sorting. */
  jobsBody.innerHTML = jobs
    .map((job) => {
      const stats = job.lastStats;
      return (
        `<tr data-job-id="${escapeHtml(job.id)}"${hasAlerts(job) ? ' class="alert-row"' : ""}>` +
        `<td class="cell-drag">` +
        `<span class="drag-handle" title="Drag to reorder">` +
        `<svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">` +
        `<circle cx="2" cy="3" r="1.2"/><circle cx="8" cy="3" r="1.2"/>` +
        `<circle cx="2" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/>` +
        `<circle cx="2" cy="13" r="1.2"/><circle cx="8" cy="13" r="1.2"/>` +
        `</svg></span></td>` +
        `<td class="cell-job">${jobCell(job)}</td>` +
        /* Narrow-screen digest; display:none on wide screens, where the real
           columns below take over. */
        `<td class="cell-summary">${summaryCell(job)}</td>` +
        `<td class="num" data-label="Proposals">${delta(job, "proposals", stats?.proposals)}</td>` +
        `<td data-label="Last client activity"` +
        (stats?.lastViewedRaw
          ? ` title="${escapeHtml(UpworkApi.formatAbsoluteTime(stats.lastViewedRaw) || "")}"`
          : "") +
        `>${delta(job, "lastViewed", liveViewed(stats))}</td>` +
        `<td data-label="Payment">${paymentCell(job, stats)}</td>` +
        `<td class="num" data-label="Interviewing">${delta(job, "interviewing", stats?.interviewing)}</td>` +
        `<td class="num" data-label="Invites sent">${delta(job, "invitesSent", stats?.invitesSent)}</td>` +
        `<td class="num" data-label="Unanswered">${delta(job, "unansweredInvites", stats?.unansweredInvites)}</td>` +
        `<td class="num" data-label="Hired">${delta(job, "hires", stats?.hires)}</td>` +
        `<td data-label="Last checked"` +
        (job.lastChecked
          ? ` title="${escapeHtml(UpworkApi.formatAbsoluteTime(job.lastChecked) || "")}"`
          : "") +
        `>${job.lastChecked ? UpworkApi.formatRelativeTime(job.lastChecked) : "Never"}</td>` +
        `<td class="cell-actions">${actionsCell(job)}</td>` +
        `</tr>`
      );
    })
    .join("");

  jobsBody.querySelectorAll("[data-remove-id]").forEach((btn) => {
    btn.addEventListener("click", () => void removeJob(btn.dataset.removeId));
  });
  jobsBody.querySelectorAll("[data-dismiss-id]").forEach((btn) => {
    btn.addEventListener("click", () => void dismissAlerts(btn.dataset.dismissId));
  });
  jobsBody.querySelectorAll("[data-copy-id]").forEach((btn) => {
    btn.addEventListener("click", () => void copyDraft(btn.dataset.copyId));
  });
  jobsBody.querySelectorAll("[data-applied-id]").forEach((btn) => {
    btn.addEventListener("click", () => void toggleApplied(btn.dataset.appliedId));
  });

  /* Brings the state classes (is-hot, is-busy) up to date now rather than on
     the next 1s beat, so a re-render never shows a stale ring. */
  tickRings();

  /*
   * A check lands every few seconds on a hot job, and each one rebuilds this
   * body — which destroys the <a> an open hover card is measured against. The
   * card is re-pointed at the new one and its counters refreshed, so reading it
   * while the job is being polled is not a moving target.
   */
  if (popJobId) {
    const anchor = jobsBody.querySelector(`[data-client-id="${CSS.escape(popJobId)}"]`);
    if (!anchor) hideClientPop();
    else {
      popAnchor = anchor;
      renderClientPop();
    }
  }

  /* The open slide is looking at one of these jobs — keep its counters live,
     and back out if the job it was showing is gone. */
  if (detailJobId) renderJobDetail();
}

/* ── Ring: pause / check now ── */

/*
 * Same grace period as the job title, and for the same reason: the single-click
 * action has to wait to find out it is not half of a double-click. Pausing is
 * the one that waits, since a check already takes far longer than 260ms.
 */
let ringClickTimer = null;

async function togglePause(jobId) {
  const jobs = await loadTrackedJobs();
  const job = jobs.find((j) => j.id === jobId);
  if (!job) return;

  job.paused = !job.paused;
  /* Resuming starts a fresh countdown rather than firing instantly on a
     deadline that expired while the job was stopped. */
  if (!job.paused) job.nextCheckAt = Date.now() + (job.checkIntervalMs || DEFAULT_INTERVAL_MS);

  await saveTrackedJobs(jobs);
  await refreshJobs();
  showToast(job.paused ? "Checks paused for this job" : "Checks resumed");
}

function checkJobNow(jobId) {
  if (requested.has(jobId)) return;
  requested.add(jobId);

  /* querySelectorAll, not querySelector: a row carries two rings at card width
     — the timer cell and the digest line — both keyed to the same job. */
  jobsBody
    .querySelectorAll(`[data-ring-id="${CSS.escape(jobId)}"]`)
    .forEach((el) => el.classList.add("is-busy"));

  chrome.runtime
    .sendMessage({ type: "upwork-simple:checkJob", jobId })
    .catch(() => {})
    .finally(() => requested.delete(jobId));
}

jobsBody.addEventListener("click", (e) => {
  const ring = e.target.closest("[data-ring-id]");
  if (!ring) return;
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

  if (ringClickTimer) {
    clearTimeout(ringClickTimer);
    ringClickTimer = null;
    return;
  }

  const jobId = ring.dataset.ringId;
  ringClickTimer = setTimeout(() => {
    ringClickTimer = null;
    void togglePause(jobId);
  }, DBL_CLICK_GRACE_MS);
});

jobsBody.addEventListener("dblclick", (e) => {
  const ring = e.target.closest("[data-ring-id]");
  if (!ring) return;

  if (ringClickTimer) {
    clearTimeout(ringClickTimer);
    ringClickTimer = null;
  }

  /* Works on a paused job too — an explicit one-shot check, which does not
     resume the schedule. */
  checkJobNow(ring.dataset.ringId);
});

/* ── Confirm dialog ── */

const confirmModal = document.getElementById("confirmModal");
const confirmTitle = document.getElementById("confirmTitle");
const confirmText = document.getElementById("confirmText");
const confirmOkBtn = document.getElementById("confirmOkBtn");
const confirmCancelBtn = document.getElementById("confirmCancelBtn");

let confirmResolve = null;

/*
 * Resolves true only when the confirm button was pressed. Every other way out
 * — Cancel, Esc, the backdrop — resolves false, and all of them land on the
 * dialog's own close event, so there is exactly one place the promise settles.
 */
function askConfirm({ title, message, okLabel }) {
  /* showModal() throws on an already-open dialog, and stacking two questions
     would orphan the first promise. Second asker simply gets "no". */
  if (confirmModal.open) return Promise.resolve(false);

  confirmTitle.textContent = title;
  /* `message` is trusted markup — callers interpolate through escapeHtml. */
  confirmText.innerHTML = message;
  confirmOkBtn.textContent = okLabel;

  confirmModal.returnValue = "";
  confirmModal.showModal();
  /* Cancel takes focus, not the destructive button: a stray Enter should not
     delete anything. */
  confirmCancelBtn.focus();

  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}

confirmOkBtn.addEventListener("click", () => confirmModal.close("ok"));
confirmCancelBtn.addEventListener("click", () => confirmModal.close("cancel"));

confirmModal.addEventListener("click", (e) => {
  if (e.target === confirmModal) confirmModal.close("cancel");
});

confirmModal.addEventListener("close", () => {
  const resolve = confirmResolve;
  confirmResolve = null;
  resolve?.(confirmModal.returnValue === "ok");
});

/* ── The job title ── */

/*
 * Matched to the platform's own double-click window (Windows defaults to
 * 500ms, SPI_GETDBLCLKTIME) — still used by the ring, which does have two
 * gestures.
 */
const DBL_CLICK_GRACE_MS = 450;

/*
 * The title is a plain link again.
 *
 * It used to carry two gestures — one click to open Upwork, two to open the
 * editor — which meant every single click sat on a 450ms timer waiting to find
 * out whether a second one was coming. The editor now has its own button on
 * the detail slide, so the second gesture is gone and with it the wait: the
 * anchor navigates natively, which also hands ctrl/cmd-click, middle-click and
 * "open in new tab" back to the browser instead of re-implementing them.
 *
 * All that is left is dismissing the hover card, which would otherwise hang
 * over the list while the new tab takes focus.
 */
jobsBody.addEventListener("click", (e) => {
  if (e.target.closest(".job-name")) hideClientPop();
});

/*
 * Any [data-copy-url] under `root` copies that link. Delegated, so it survives
 * the re-render of whatever drew it, and taken as an argument because the same
 * control now appears in two places that are not in the same subtree: the row,
 * and the hover card (which is a sibling of the whole page).
 */
function bindCopyUrl(root) {
  root.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-copy-url]");
    if (!btn) return;

    e.preventDefault();
    void (async () => {
      const ok = await writeClipboard(btn.dataset.copyUrl);
      showToast(ok ? "Job link copied" : "Could not access the clipboard", ok ? "" : "is-bad");
    })();
  });
}

/* The link icon trailing the title, and the one in the hover card's footer. */
bindCopyUrl(jobsBody);
bindCopyUrl(clientPop);

/* Events from the priority fields, coloured to match the row alerts. */
const PRIORITY_EVENTS = new Set(["Viewed", "Interviewing", "Invites sent", "Payment"]);

function renderLog(log) {
  logList.classList.toggle("hidden", log.length === 0);
  emptyLog.classList.toggle("hidden", log.length !== 0);

  logList.innerHTML = log
    .map((entry) => {
      const priority = PRIORITY_EVENTS.has(entry.event);
      return (
        `<li class="log-item${priority ? " is-priority" : ""}">` +
        `<span class="log-dot"></span>` +
        `<div class="log-main">` +
        `<div class="log-event">${escapeHtml(entry.event)} ` +
        `<span class="was">${escapeHtml(entry.was)}</span> ` +
        `<strong>${escapeHtml(entry.now)}</strong></div>` +
        `<div class="log-job">${escapeHtml(entry.jobName)}</div>` +
        `</div>` +
        `<time class="log-time" title="${escapeHtml(UpworkApi.formatAbsoluteTime(entry.time) || "")}">` +
        `${UpworkApi.formatRelativeTime(entry.time)}</time>` +
        `</li>`
      );
    })
    .join("");
}

function updateStatus(jobs) {
  const errored = jobs.filter((job) => job.lastError).length;

  /* Ordered by what the user most needs to know, same as the old badge. */
  const state = checking
    ? { tone: "", note: "Checking jobs…" }
    : cycleError
      ? { tone: "is-error", note: cycleError }
      : errored > 0
        ? {
            tone: "is-error",
            note: `${errored} job${errored === 1 ? "" : "s"} failed last check`,
          }
        : { tone: "", note: null };

  checkNowBtn.classList.toggle("is-error", state.tone === "is-error");
  /* The tooltip keeps saying what the button does — the state is added to it,
     not substituted for it. */
  checkNowBtn.title = state.note
    ? `Check all jobs now — ${state.note}`
    : "Check all jobs now";
}

async function refreshJobs() {
  /* Re-rendering mid-drag would destroy the row being dragged. */
  if (isDragging) {
    pendingRefresh = true;
    return;
  }

  /*
   * The editor needs no such guard: it is a dialog outside the table, so a
   * re-render underneath it cannot disturb what is being typed.
   */
  const jobs = await loadTrackedJobs();
  jobsBadge.textContent = String(jobs.length);

  groupsCache = await loadGroups();
  /* A tab removed in another window would otherwise leave this one showing an
     empty list under a heading that no longer exists. Unassigned goes the same
     way once its last job has been filed somewhere. */
  if (isRealGroup(activeGroupId) && !groupsCache.some((g) => g.id === activeGroupId)) {
    activeGroupId = null;
  }
  if (activeGroupId === NO_GROUP && jobs.every((job) => job.groupId)) activeGroupId = null;
  renderSubTabs(jobs);

  /* Two filters, narrowing in the order the user set them: the sub-tab is
     where they are, the tag is what they asked to see there. */
  const inGroup = !activeGroupId
    ? jobs
    : activeGroupId === NO_GROUP
      ? jobs.filter((job) => !job.groupId)
      : jobs.filter((job) => job.groupId === activeGroupId);

  /* A filter whose last job was retagged, removed or moved to another tab
     would leave an empty list and no obvious way back, so it lets go. */
  if (tagFilter && !inGroup.some((job) => jobTag(job) === tagFilter)) tagFilter = null;

  const visible = tagFilter ? inGroup.filter((job) => jobTag(job) === tagFilter) : inGroup;

  const positions = capturePositions();
  renderJobsTable(visible);
  playReorder(positions);
  renderTagFilterBar();

  /* Counted over every job, not the visible ones: the badge and the status line
     describe what is tracked, which a filter does not change. */
  updateStatus(jobs);
  tickRings();
}

async function refreshLog() {
  const log = await loadActivityLog();
  logBadge.textContent = String(log.length);
  renderLog(log);
}

async function requestCheck() {
  if (checking) return;
  checking = true;
  cycleError = null;
  checkNowBtn.classList.add("spinning");
  checkNowBtn.disabled = true;
  updateStatus(await loadTrackedJobs());

  try {
    const res = await chrome.runtime.sendMessage({ type: "upwork-simple:checkNow" });
    if (res && res.ok === false) cycleError = res.error || "Check failed.";
  } catch (err) {
    cycleError = err?.message || "Could not reach the extension worker.";
  } finally {
    checking = false;
    checkNowBtn.classList.remove("spinning");
    checkNowBtn.disabled = false;
    await refreshJobs();
  }
}

/* ── Proposal draft, copy, applied ── */

const draftModal = document.getElementById("draftModal");
const draftText = document.getElementById("draftText");
const draftTag = document.getElementById("draftTag");
const draftTagColors = document.getElementById("draftTagColors");
const draftTagOptions = document.getElementById("draftTagOptions");
const draftGroup = document.getElementById("draftGroup");
const draftTagPreview = document.getElementById("draftTagPreview");
const draftJobName = document.getElementById("draftJobName");
const draftName = document.getElementById("draftName");
const draftMeta = document.getElementById("draftMeta");
const draftCopyBtn = document.getElementById("draftCopyBtn");
const draftSaveBtn = document.getElementById("draftSaveBtn");
const draftCloseBtn = document.getElementById("draftCloseBtn");

let draftJobId = null;
let draftTagColor = DEFAULT_TAG_COLOR;

/*
 * A real radio group: one tab stop for the whole palette, arrows to move
 * within it. Eleven swatches as separate tab stops would have put the proposal
 * field eleven presses away.
 *
 * The name is a tooltip rather than a caption: eleven labelled rows would own
 * more of the dialog than the proposal field does.
 */
draftTagColors.innerHTML = TAG_COLORS.map(
  (color) =>
    `<button type="button" class="swatch c-${color}" data-color="${color}" ` +
    `role="radio" aria-checked="false" tabindex="-1" ` +
    `title="${color[0].toUpperCase()}${color.slice(1)}" ` +
    `aria-label="${color} tag colour"></button>`
).join("");

/*
 * Chip in the modal and chip in the row are the same markup, so what the
 * preview shows is what the list gets. With the field empty there is no chip
 * to show, and an empty box made the swatches look dead — so it shows the
 * chosen colour on a dimmed placeholder instead of nothing.
 */
function renderTagPreview() {
  const text = draftTag.value.trim();
  draftTagPreview.classList.toggle("is-placeholder", !text);
  draftTagPreview.innerHTML = tagChip({
    tag: text || "tag",
    tagColor: draftTagColor,
  });
}

function selectTagColor(color, moveFocus = false) {
  draftTagColor = TAG_COLORS.includes(color) ? color : DEFAULT_TAG_COLOR;

  draftTagColors.querySelectorAll(".swatch").forEach((btn) => {
    const on = btn.dataset.color === draftTagColor;
    btn.classList.toggle("is-on", on);
    btn.setAttribute("aria-checked", String(on));
    /* Roving tabindex: only the chosen swatch is in the tab order. */
    btn.tabIndex = on ? 0 : -1;
    if (on && moveFocus) btn.focus();
  });

  renderTagPreview();
}

draftTagColors.addEventListener("click", (e) => {
  const btn = e.target.closest(".swatch");
  if (btn) selectTagColor(btn.dataset.color);
});

/* Arrows move the selection, the way a radio group is expected to behave. */
const TAG_COLOR_KEYS = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

draftTagColors.addEventListener("keydown", (e) => {
  const step = TAG_COLOR_KEYS[e.key];
  const at = TAG_COLORS.indexOf(draftTagColor);

  if (step) {
    e.preventDefault();
    /* Wraps, so the palette is a loop rather than two dead ends. */
    const next = (at + step + TAG_COLORS.length) % TAG_COLORS.length;
    selectTagColor(TAG_COLORS[next], true);
  } else if (e.key === "Home") {
    e.preventDefault();
    selectTagColor(TAG_COLORS[0], true);
  } else if (e.key === "End") {
    e.preventDefault();
    selectTagColor(TAG_COLORS[TAG_COLORS.length - 1], true);
  }
});

async function updateJob(jobId, patch) {
  const jobs = await loadTrackedJobs();
  const job = jobs.find((j) => j.id === jobId);
  if (!job) return null;
  Object.assign(job, patch);
  await saveTrackedJobs(jobs);
  await refreshJobs();
  return job;
}

/* What the row would show if the title were left empty: its URL, or its id. */
let draftFallbackLabel = "";

function renderDraftHeading() {
  draftJobName.textContent = draftName.value.trim() || draftFallbackLabel;
}

function setDraftMeta(text) {
  draftMeta.textContent = text;
}

/*
 * Grows the textarea to fit its content. CSS max-height is the actual limit —
 * setting an oversized style.height past it is harmless, the box just clamps
 * and overflow-y:auto takes over, so this never needs to know that limit
 * itself.
 */
function autoGrowDraft() {
  draftText.style.height = "auto";
  draftText.style.height = `${draftText.scrollHeight}px`;
}

async function openDraft(jobId) {
  const jobs = await loadTrackedJobs();
  const job = jobs.find((j) => j.id === jobId);
  if (!job) return;

  draftJobId = jobId;
  /* Assigned as a property, never as markup, so quotes or angle brackets in a
     stored title cannot break out. */
  draftName.value = job.name || "";
  draftFallbackLabel = job.url || job.id;
  renderDraftHeading();
  draftTag.value = job.tag || "";
  /* Reads back the stored colour, or the default for a job with no tag yet. */
  selectTagColor(tagColorOf(job));

  /* Rebuilt per open, so a tab added since the last time is offered. "None"
     is a real choice: it means the job shows under All only. */
  draftGroup.innerHTML =
    `<option value="">None</option>` +
    groupsCache
      .map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}</option>`)
      .join("");
  /* Assigned as a property so a stale id simply selects nothing. */
  draftGroup.value = job.groupId || "";

  const inUse = [...new Set(jobs.map(jobTag).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
  draftTagOptions.innerHTML = inUse
    .map((tag) => `<option value="${escapeHtml(tag)}"></option>`)
    .join("");
  draftText.value = job.draft || "";
  setDraftMeta(`${draftText.value.length} characters`);
  draftModal.showModal();
  autoGrowDraft();

  /* The title is what was double-clicked, so it is what the caret lands in —
     the same gesture that used to open an inline rename field. */
  draftName.focus();
  draftName.select();
}

function draftPatch() {
  const name = draftName.value.trim();
  const tag = draftTag.value.trim();
  /* Clearing the text clears the colour too, so a re-tagged job starts from
     the default instead of inheriting a colour nothing is wearing. */
  const patch = {
    draft: draftText.value,
    tag: tag || null,
    tagColor: tag ? draftTagColor : null,
    groupId: draftGroup.value || null,
  };

  /* An empty title is "no change", not a clear — a job with no name falls back
     to its raw URL in the row, which is never what emptying the field meant. */
  if (name) patch.name = name;
  return patch;
}

async function persistDraft() {
  if (!draftJobId) return;
  await updateJob(draftJobId, draftPatch());
}

/*
 * Confirmations live outside the table on purpose. Feedback rendered onto a row
 * button used to be wiped when a check re-rendered that row mid-flash, which on
 * a 5s-tier job happened often enough to look broken.
 */
const toastEl = document.getElementById("toast");
let toastTimer = null;

function showToast(message, tone = "") {
  toastEl.textContent = message;
  toastEl.className = `toast is-shown ${tone}`.trim();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.className = "toast";
  }, 2000);
}

/* Clipboard needs a secure context; extension pages qualify. */
async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function copyDraft(jobId) {
  const jobs = await loadTrackedJobs();
  const job = jobs.find((j) => j.id === jobId);
  if (!job?.draft) return;

  const ok = await writeClipboard(job.draft);
  showToast(ok ? "Proposal copied to clipboard" : "Could not access the clipboard", ok ? "" : "is-bad");
}

async function toggleApplied(jobId) {
  const jobs = await loadTrackedJobs();
  const job = jobs.find((j) => j.id === jobId);
  if (!job) return;
  await updateJob(jobId, {
    applied: !job.applied,
    appliedAt: job.applied ? null : new Date().toISOString(),
  });
}

draftName.addEventListener("input", renderDraftHeading);

/*
 * Enter committed the old inline rename, so it still commits here. Closing is
 * what saves (see the close handler), so there is nothing else to do. The
 * textarea is left out on purpose: Enter there is a newline.
 */
[draftName, draftTag].forEach((input) => {
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      draftModal.close();
    }
  });
});

draftTag.addEventListener("input", renderTagPreview);

draftText.addEventListener("input", () => {
  setDraftMeta(`${draftText.value.length} characters`);
  autoGrowDraft();
});

draftSaveBtn.addEventListener("click", () => draftModal.close());
draftCloseBtn.addEventListener("click", () => draftModal.close());

draftCopyBtn.addEventListener("click", async () => {
  /* Copy what is on screen, saving it first so the two never disagree. */
  await persistDraft();
  const ok = await writeClipboard(draftText.value);
  showToast(ok ? "Proposal copied to clipboard" : "Could not access the clipboard", ok ? "" : "is-bad");
});

/* Backdrop click closes; clicks inside the panel must not bubble out to it. */
draftModal.addEventListener("click", (e) => {
  if (e.target === draftModal) draftModal.close();
});

/*
 * Single save point, so every close path persists — Save, the × button, the
 * backdrop and Esc. Previously only Save wrote, and Esc silently discarded a
 * proposal the user had just typed.
 */
draftModal.addEventListener("close", () => {
  const id = draftJobId;
  const patch = draftPatch();
  draftJobId = null;
  if (id) void updateJob(id, patch);
});

/* ── Signed-out state ── */

const AUTH_ERROR_KEY = "authError";
const authBanner = document.getElementById("authBanner");
const authOpenBtn = document.getElementById("authOpenBtn");

async function refreshAuthBanner() {
  const { [AUTH_ERROR_KEY]: signedOut } = await chrome.storage.local.get(AUTH_ERROR_KEY);
  authBanner.classList.toggle("hidden", !signedOut);
}

authOpenBtn.addEventListener("click", async () => {
  /* The search page specifically — that is what sets UniversalSearchNuxt_vt. */
  await chrome.tabs.create({ url: UpworkApi.SEARCH_PAGE_URL });
  showToast("Let the page load, then press refresh here");
});

/* ── Settings ── */

const SETTINGS_KEY = "settings";

/* Must stay in step with DEFAULT_SETTINGS in background.js. */
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

const notifyGroup = document.getElementById("notifyGroup");
const throttleSelect = document.getElementById("throttleSelect");
const throttleDesc = document.getElementById("throttleDesc");

async function loadSettings() {
  const stored = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || {};
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    notify: { ...DEFAULT_SETTINGS.notify, ...(stored.notify || {}) },
  };
}

function describeThrottle(ms) {
  if (!ms) {
    return "Every event notifies. Expect frequent popups on an active job.";
  }
  const label = ms >= 60000 ? `${ms / 60000} min` : `${ms / 1000}s`;
  return `At most one popup per job per ${label}. Nothing is lost — suppressed events fold into the next popup, and the Activity Log keeps everything.`;
}

async function renderSettings() {
  const settings = await loadSettings();

  document.querySelectorAll("[data-setting]").forEach((input) => {
    input.checked = Boolean(settings[input.dataset.setting]);
  });
  document.querySelectorAll("[data-notify]").forEach((input) => {
    input.checked = Boolean(settings.notify[input.dataset.notify]);
  });

  throttleSelect.value = String(settings.throttleMs);
  throttleDesc.textContent = describeThrottle(settings.throttleMs);
  /* The per-event list is meaningless while the master switch is off. */
  notifyGroup.classList.toggle("is-disabled", !settings.notifyEnabled);
}

async function writeSettings(mutate) {
  const settings = await loadSettings();
  mutate(settings);
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  await renderSettings();
}

document.querySelectorAll("[data-setting]").forEach((input) => {
  input.addEventListener("change", () =>
    void writeSettings((s) => {
      s[input.dataset.setting] = input.checked;
    })
  );
});

document.querySelectorAll("[data-notify]").forEach((input) => {
  input.addEventListener("change", () =>
    void writeSettings((s) => {
      s.notify[input.dataset.notify] = input.checked;
    })
  );
});

const diagBtn = document.getElementById("diagBtn");
const diagOut = document.getElementById("diagOut");

const probeBtn = document.getElementById("probeBtn");
const probeOut = document.getElementById("probeOut");

probeBtn.addEventListener("click", async () => {
  probeBtn.disabled = true;
  probeOut.classList.remove("hidden");
  probeOut.textContent = "Probing… this makes several requests.";

  try {
    const res = await chrome.runtime.sendMessage({ type: "upwork-simple:probeSchema" });
    if (!res?.ok) throw new Error(res?.error || "The extension worker did not respond.");

    const { introspection, types, probes, note } = res.result;
    const lines = [`Probed with job ${res.jobId}`, ""];

    if (introspection) {
      lines.push("Introspection is OPEN — these are the real field names:");
      for (const [name, fields] of Object.entries(types)) {
        lines.push("", `${name}:`);
        fields.forEach((f) => lines.push(`  ${f}`));
      }
    } else {
      if (note) lines.push(note, "");

      const ok = probes.filter((p) => p.ok);
      lines.push(ok.length ? "FIELDS THAT EXIST:" : "No candidate field was accepted.");
      ok.forEach((p) => lines.push(`  ${p.path}`));

      lines.push("", "REJECTED (the message often names the right field):");
      probes
        .filter((p) => !p.ok)
        .forEach((p) => lines.push(`  ${p.path}`, `    ${p.message}`));
    }

    probeOut.textContent = lines.join("\n");
  } catch (err) {
    probeOut.textContent = err?.message || "Probe failed.";
  } finally {
    probeBtn.disabled = false;
  }
});

/* ── Why the hover card has no details ── */

/* ── Captured Upwork queries ── */

const capturedBtn = document.getElementById("capturedBtn");
const capturedCopyBtn = document.getElementById("capturedCopyBtn");
const capturedClearBtn = document.getElementById("capturedClearBtn");
const capturedOut = document.getElementById("capturedOut");

/* What the last Show produced, so Copy hands over exactly what is on screen. */
let capturedText = "";

function formatCaptured(queries) {
  if (!queries.length) {
    return [
      "Nothing captured yet.",
      "",
      "Browse upwork.com in this browser — open a freelancer's profile, a job,",
      "the search page — then press Show captured again. Every distinct GraphQL",
      "alias Upwork's own pages send is listed here with its query.",
    ].join("\n");
  }

  const lines = [`${queries.length} alias${queries.length === 1 ? "" : "es"} captured this session`, ""];

  for (const q of queries) {
    lines.push(`━━ ${q.alias}`);
    lines.push(`   seen ${UpworkApi.formatRelativeTime(q.at) || "just now"}${q.page ? ` on ${q.page}` : ""}`);
    if (q.operation) lines.push(`   operation: ${q.operation}`);
    if (q.variables && Object.keys(q.variables).length) {
      lines.push(`   variables: ${JSON.stringify(q.variables)}`);
    }
    lines.push("", q.query.trim(), "");
  }

  return lines.join("\n");
}

async function showCaptured() {
  capturedBtn.disabled = true;
  capturedOut.classList.remove("hidden");
  capturedOut.textContent = "Reading…";

  try {
    const res = await chrome.runtime.sendMessage({ type: "upwork-simple:capturedQueries" });
    if (!res?.ok) throw new Error(res?.error || "The extension worker did not respond.");
    capturedText = formatCaptured(res.queries);
    capturedOut.textContent = capturedText;
  } catch (err) {
    capturedText = "";
    capturedOut.textContent = err?.message || "Could not read captured queries.";
  } finally {
    capturedBtn.disabled = false;
  }
}

capturedBtn.addEventListener("click", () => void showCaptured());

capturedCopyBtn.addEventListener("click", async () => {
  /* Copy without a prior Show still means "copy what has been captured". */
  if (!capturedText) await showCaptured();
  if (!capturedText) return;
  const ok = await writeClipboard(capturedText);
  showToast(ok ? "Captured queries copied" : "Could not access the clipboard", ok ? "" : "is-bad");
});

capturedClearBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "upwork-simple:capturedQueries", clear: true });
  capturedText = "";
  capturedOut.classList.remove("hidden");
  capturedOut.textContent = "Cleared.";
});

/* ── Why a hired freelancer has no country or rate ── */

const profileProbeBtn = document.getElementById("profileProbeBtn");
const profileProbeOut = document.getElementById("profileProbeOut");

function formatProfileProbe(r) {
  const lines = [`Probed ${r.url}`, ""];

  if (r.error) {
    lines.push(`Request failed before any answer: ${r.error}`);
    return lines.join("\n");
  }

  lines.push(
    `HTTP ${r.status}${r.redirected ? ` → redirected to ${r.finalUrl}` : ""}`,
    `Content-type: ${r.contentType || "?"} · ${r.length.toLocaleString()} chars`,
    `Title: ${r.title || "(none)"}`,
    ""
  );

  /* The three ways a page can be the wrong page, checked in the order they
     would explain everything else. */
  if (r.challenge) {
    lines.push("This is a Cloudflare challenge, not a profile. Open upwork.com in a tab,",
      "clear the challenge, then probe again.", "");
  } else if (r.login) {
    lines.push("Upwork sent the login page: the worker's request did not carry a signed-in",
      "session for this URL. Sign in at upwork.com, then probe again.", "");
  }

  lines.push(
    `JSON-LD blocks: ${r.jsonLd.length ? r.jsonLd.join(", ") : "none"}`,
    `"Freelancer from …" in page: ${r.freelancerFrom ? "yes" : "no"}`,
    `Nuxt state present: ${r.nuxtState ? "yes" : "no"}`,
    `"$…/hr" in visible markup: ${r.rateMentions.length ? "" : "none"}`
  );
  r.rateMentions.forEach((m) => lines.push(`   …${m}…`));
  lines.push("");

  lines.push(
    `RESULT: ${r.ok ? "parsed — " + JSON.stringify(r.extracted) : "nothing usable in the markup"}`,
    ""
  );

  if (!r.ok && !r.challenge && !r.login) {
    lines.push(
      "The page came back but carries none of the structured data the parser",
      "reads — it is rendered by script after load. The profile query Upwork's",
      "own page uses is the real answer:"
    );
    if (r.profileAliases?.length) {
      lines.push("", "Captured from Upwork's profile page this session:");
      for (const q of r.profileAliases) {
        lines.push(`  ━━ ${q.alias}  (${q.page})`);
        if (q.operation) lines.push(`     operation: ${q.operation}`);
        if (q.variables && Object.keys(q.variables).length) {
          lines.push(`     variables: ${JSON.stringify(q.variables)}`);
        }
        lines.push("", q.query.trim(), "");
      }
      lines.push("Copy this output when reporting it.");
    } else {
      lines.push(
        "",
        "None captured yet. Open any freelancer's profile on upwork.com in a tab,",
        "then probe again — the aliases that page sends will be listed here."
      );
    }
  }

  return lines.join("\n");
}

profileProbeBtn.addEventListener("click", async () => {
  profileProbeBtn.disabled = true;
  profileProbeOut.classList.remove("hidden");
  profileProbeOut.textContent = "Fetching one profile page…";

  try {
    const res = await chrome.runtime.sendMessage({ type: "upwork-simple:probeProfile" });
    if (!res?.ok) throw new Error(res?.error || "The extension worker did not respond.");
    profileProbeOut.textContent = formatProfileProbe(res.report);
  } catch (err) {
    profileProbeOut.textContent = err?.message || "Probe failed.";
  } finally {
    profileProbeBtn.disabled = false;
  }
});

const detailsProbeBtn = document.getElementById("detailsProbeBtn");
const detailsProbeOut = document.getElementById("detailsProbeOut");

/* The four candidate query shapes, in the order api.js tries them. */
const SHAPE_NAMES = [
  "full (job + client incl. stats + your match)",
  "no client stats (job + client profile + your match)",
  "no client at all (job + your match)",
  "job only (fields copied from Upwork's own request)",
];

/*
 * The screening-question selection carried by that rung. A rung can appear
 * more than once in this report — once per correction — and without this the
 * repeat reads as a pointless retry rather than as the ladder working.
 */
const QUESTION_SHAPE_NAMES = [
  "on opening, as objects with position",
  "on opening, as objects",
  "on opening, as plain strings",
  "on job, as objects with position",
  "on job, as objects",
  "on job, as plain strings",
  "no questions asked for",
];

detailsProbeBtn.addEventListener("click", async () => {
  detailsProbeBtn.disabled = true;
  detailsProbeOut.classList.remove("hidden");
  detailsProbeOut.textContent = "Running the real request…";

  try {
    const res = await chrome.runtime.sendMessage({ type: "upwork-simple:probeDetails" });
    if (!res?.ok) throw new Error(res?.error || "The extension worker did not respond.");

    const { cookiesFound, tenantFound, shapes, ok, error, got, refreshed, captured } = res.report;
    const lines = [`Probed with job ${res.jobId}`, ""];

    lines.push(
      cookiesFound.length
        ? `Session cookies found: ${cookiesFound.join(", ")}`
        : "Session cookies found: NONE — this is the problem."
    );
    lines.push(`Org header (${"current_organization_uid"}): ${tenantFound ? "found" : "missing"}`);
    /* The line that decides most outcomes. No cookie carries the scopes this
       endpoint wants; the token that works is the one Upwork's own page sent,
       and this says whether the worker has seen one yet. */
    lines.push(
      `Token captured from Upwork's own page: ${
        captured || "none yet — open any job on upwork.com and this fills in"
      }`
    );

    /*
     * Only present when every token was refused and the built-in refresh ran.
     * It separates the two failures that otherwise read identically: a session
     * that is genuinely signed out, and a refresh that never minted anything
     * for the retry to use.
     */
    if (refreshed) {
      lines.push(
        refreshed.length
          ? `Refresh minted: ${refreshed.join(", ")} — retried with those`
          : "Refresh minted: nothing new — Upwork set no fresh token."
      );
    }
    lines.push("");

    if (!cookiesFound.length) {
      lines.push(
        "The extension could not see any of these cookies:",
        ...UpworkApi.AUTH_TOKEN_COOKIE_NAMES.map((n) => `  ${n}`),
        "",
        "Cookies are only the fallback, though — see the captured-token line",
        "above. Open any job on upwork.com while signed in, then probe again.",
        ""
      );
    }

    for (const { shape, questionShape, attempts, thrown } of shapes) {
      lines.push(`Query shape ${shape + 1} — ${SHAPE_NAMES[shape] || "?"}`);
      if (questionShape !== undefined) {
        lines.push(`  + ${QUESTION_SHAPE_NAMES[questionShape] || "?"}`);
      }
      if (thrown) lines.push(`  ${thrown}`);
      if (!attempts.length && !thrown) lines.push("  (not tried)");

      for (const a of attempts) {
        /* Where the org header came from — api.js reports the source, never
           the id, which is account data like every token in this report. */
        const org = a.tenant ? ` · org from ${a.tenant}` : "";
        lines.push(`  ${a.cookie} → HTTP ${a.status} · ${a.outcome}${org}`);
        /* The blocked-field list, when Upwork gave one, is the whole
           diagnosis — printed as a list rather than buried in a sentence. */
        if (a.blocked?.includes("Query.jobAuthDetails")) {
          /* The whole query, listed field by field. Fifty lines of that hide
             the one line that matters. */
          lines.push(
            `    no access to jobAuthDetails at all (Upwork listed all ${a.blocked.length} requested fields)`
          );
        } else if (a.blocked) {
          lines.push("    out of scope for this token:");
          a.blocked.forEach((f) => lines.push(`      ${f}`));
        } else if (a.error) {
          lines.push(`    ${a.error}`);
        }
        /* Not JSON: almost always a Cloudflare interstitial, which is a very
           different problem from anything the API itself said. */
        if (a.body) lines.push(`    non-JSON body: ${a.body.replace(/\s+/g, " ")}`);
      }
      lines.push("");
    }

    const anyOutcome = (...names) =>
      shapes.some((s) => s.attempts.some((a) => names.includes(a.outcome)));

    if (ok) {
      lines.push("RESULT: success — the hover card has what it needs.");
      if (got?.length) lines.push(`Fields returned: ${got.join(", ")}`);

      /* Succeeding on a narrower rung is a normal, permanent state for most
         sessions, not a fault — but it explains a missing row, so it is said
         plainly rather than left to look like a bug. */
      if (anyOutcome("ok (partial)", "fields out of scope")) {
        lines.push(
          "",
          "Some client fields are outside your token's scopes, so the card",
          "shows them from the tracking query instead where it has them. The",
          "job description, skills, terms and your qualification match are",
          "unaffected. Nothing to fix."
        );
      }
    } else {
      lines.push(`RESULT: failed — ${error || "no reason reported."}`, "");
      /* These failures have opposite remedies, so the probe says which. */
      const blocked = shapes.some((s) => s.attempts.some((a) => a.body));

      if (blocked) {
        lines.push(
          "Upwork answered with a page instead of JSON — that is Cloudflare,",
          "not the API. Open upwork.com in a tab, clear any challenge it shows,",
          "then probe again."
        );
      } else if (anyOutcome("wrong organization")) {
        /* Said before "token refused", because it arrives AS a 403 and the
           remedy is the opposite one: a fresh token cannot fix it. */
        lines.push(
          "Upwork refused the ORGANIZATION, not the token:",
          "  \"provided tenant (organization) id could not be found in users tenants\"",
          "",
          "Your session token belongs to one Upwork organization and the org id",
          "this browser last used belongs to another, so no amount of re-signing-in",
          "will help. Switch to the account you want in Upwork's own account menu",
          "and open a job there — the extension picks up the organization alongside",
          "the token — then probe again."
        );
      } else if (anyOutcome("token refused")) {
        /* Two very different situations print the same status codes: never
           having captured a token, and holding one that has since expired. */
        lines.push(
          ...(captured
            ? [
                "Every token was REFUSED — including the one captured from Upwork's",
                "own page, so that one has most likely expired since it was seen.",
                "Open any job on upwork.com again to capture a fresh one, then",
                "probe again. If it fails immediately after that, the signed-in",
                "account cannot see this job.",
              ]
            : [
                "Every token was REFUSED, and no token has been captured from",
                "Upwork's own page yet — the cookies alone do not carry the scopes",
                "this endpoint wants, so this is the expected result until one is.",
                "Open any job on upwork.com while signed in (the details panel or a",
                "job page), then probe again.",
              ])
        );
      } else if (anyOutcome("fields out of scope")) {
        lines.push(
          "Your token reached the endpoint but every shape asked for at least",
          "one field it may not read, down to the narrowest. The lists above",
          "name them — copy this output when reporting it."
        );
      } else if (anyOutcome("query rejected")) {
        lines.push(
          "The tokens were accepted and the QUERY was rejected, so Upwork's",
          "schema differs from what this build asks for. The messages above",
          "name the offending fields — copy this output when reporting it."
        );
      }
    }

    detailsProbeOut.textContent = lines.join("\n");
  } catch (err) {
    detailsProbeOut.textContent = err?.message || "Probe failed.";
  } finally {
    detailsProbeBtn.disabled = false;
  }
});

diagBtn.addEventListener("click", async () => {
  diagBtn.disabled = true;
  diagOut.classList.remove("hidden");
  diagOut.textContent = "Checking…";

  try {
    const res = await chrome.runtime.sendMessage({ type: "upwork-simple:diagnose" });
    const lines = [];

    if (!res?.ok) throw new Error("The extension worker did not respond.");

    lines.push(`Upwork cookies visible: ${res.cookieCount}`);
    lines.push(`Search token (${UpworkApi.SEARCH_TOKEN_COOKIE}): ${res.tokenFound ? "found" : "missing"}`);

    if (!res.cookieCount) {
      lines.push("");
      lines.push("No Upwork cookies at all — either not signed in, or the");
      lines.push("extension needs reloading to pick up its host permissions.");
    } else if (!res.tokenFound) {
      lines.push("");
      lines.push("Signed in, but the search token is absent. It is set by the job");
      lines.push("search page, not by signing in — open it once, then test again.");
      lines.push("");
      lines.push(`Cookies present: ${res.names.join(", ")}`);
    } else {
      lines.push("");
      lines.push("Ready. Checks should run normally.");
    }

    diagOut.textContent = lines.join("\n");
  } catch (err) {
    diagOut.textContent = err?.message || "Test failed.";
  } finally {
    diagBtn.disabled = false;
  }
});

throttleSelect.addEventListener("change", () =>
  void writeSettings((s) => {
    s.throttleMs = Number(throttleSelect.value);
  })
);

/* ── Lookup (was the toolbar popup) ── */

const LOOKUP_LABELS = {
  price: "Price",
  duration: "Duration",
  workload: "Workload",
  level: "Experience level",
  posted: "Posted",
  proposals: "Proposals",
  lastViewed: "Last client activity",
  interviewing: "Interviewing",
  invitesSent: "Invites sent",
  unansweredInvites: "Unanswered invites",
  hires: "Hired",
  paymentVerified: "Payment verified",
  location: "Client location",
  score: "Client rating",
  postedJobs: "Jobs posted",
  openJobs: "Open jobs",
  totalSpent: "Total spent",
};

function formatLookupValue(key, value) {
  if (value === null || value === undefined || value === "") return "—";
  if (key === "paymentVerified") return value ? "Verified" : "Unverified";
  if (key === "score") return `★ ${Number(value).toFixed(1)}`;
  if (key === "totalSpent") return `$${Math.round(Number(value)).toLocaleString()}`;
  return String(value);
}

function setLookupStatus(message, isError = false) {
  lookupStatus.textContent = message || "";
  lookupStatus.classList.toggle("error", Boolean(message) && isError);
}

function renderLookup(data) {
  /*
   * `meta` arrives as a nested object, which this generic key/value renderer
   * would print as "[object Object]" — so it is expanded into real rows and
   * removed. Its rows are dropped when empty rather than shown as five
   * em-dashes, since a job-terms probe that found nothing is not information.
   */
  const { meta, ...flat } = data;

  const metaRows = meta
    ? [
        ["price", priceLabel(meta)],
        ["duration", meta.duration],
        ["workload", meta.engagement],
        ["level", meta.tier ? TIER_LABELS[meta.tier] || meta.tier : null],
        ["posted", meta.postedAt ? UpworkApi.formatAbsoluteTime(meta.postedAt) : null],
      ].filter(([, value]) => value !== null && value !== undefined && value !== "")
    : [];

  /* lastViewedRaw is plumbing for the diffing, not something to show. */
  const rows = [...metaRows, ...Object.entries(flat)]
    .filter(([key]) => key !== "lastViewedRaw")
    .map(
      ([key, value]) =>
        `<tr><th>${escapeHtml(LOOKUP_LABELS[key] || key)}</th>` +
        `<td>${escapeHtml(formatLookupValue(key, value))}</td></tr>`
    )
    .join("");

  lookupResult.innerHTML = `<table class="lookup-table"><tbody>${rows}</tbody></table>`;
  lookupResult.classList.remove("hidden");
}

async function runLookup(mode) {
  const input = lookupInput.value.trim();
  if (!UpworkApi.parseJobId(input)) {
    setLookupStatus("Could not find a job ID in that input.", true);
    lookupResult.classList.add("hidden");
    lookupTrackBtn.classList.add("hidden");
    return;
  }

  setLookupStatus("Loading…");
  lookupResult.classList.add("hidden");
  lookupBtn.disabled = true;
  lookupActivityBtn.disabled = true;

  try {
    const res = await chrome.runtime.sendMessage({
      type: "upwork-simple:lookup",
      input,
      mode,
    });
    if (!res?.ok) throw new Error(res?.error || "Request failed.");

    renderLookup(res.data);
    setLookupStatus(mode === "activity" ? "Client activity only." : "Job loaded.");

    /* Offer to track it, unless it already is. */
    const jobs = await loadTrackedJobs();
    const jobId = UpworkApi.parseJobId(input);
    lookupTrackBtn.classList.toggle("hidden", jobs.some((job) => job.id === jobId));
  } catch (err) {
    setLookupStatus(err?.message || "Request failed.", true);
    lookupTrackBtn.classList.add("hidden");
  } finally {
    lookupBtn.disabled = false;
    lookupActivityBtn.disabled = false;
  }
}

async function trackLookedUpJob() {
  const url = lookupInput.value.trim();
  const jobId = UpworkApi.parseJobId(url);
  if (!jobId) return;

  const jobs = await loadTrackedJobs();
  if (jobs.some((job) => job.id === jobId)) {
    setLookupStatus("Already tracked.");
    lookupTrackBtn.classList.add("hidden");
    return;
  }

  lookupTrackBtn.disabled = true;
  try {
    jobs.unshift({
      id: jobId,
      url,
      name: await resolveJobName(url, jobId),
      addedAt: new Date().toISOString(),
      lastChecked: null,
      lastError: null,
      lastStats: null,
    });
    await saveTrackedJobs(jobs);
    setLookupStatus("Added to Jobs.");
    lookupTrackBtn.classList.add("hidden");
    await refreshJobs();
    void requestCheck();
  } finally {
    lookupTrackBtn.disabled = false;
  }
}

lookupBtn.addEventListener("click", () => void runLookup("details"));
lookupActivityBtn.addEventListener("click", () => void runLookup("activity"));
lookupTrackBtn.addEventListener("click", () => void trackLookedUpJob());
lookupInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") void runLookup("details");
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((el) => el.classList.remove("active"));
    document.querySelectorAll(".pane").forEach((el) => el.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`pane-${tab.dataset.tab}`).classList.add("active");

    /* Reaching for the Jobs tab means wanting the list, whichever slide the
       pane was left on — and it is also how a notification click gets back. */
    if (tab.dataset.tab === "jobs") closeJobDetail();
  });
});

addJobBtn.addEventListener("click", () => {
  if (addForm.classList.contains("hidden")) openAddForm();
  else closeAddForm();
});
cancelBtn.addEventListener("click", closeAddForm);
saveJobBtn.addEventListener("click", () => void addJob());
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") void addJob();
});

checkNowBtn.addEventListener("click", () => void requestCheck());

openTabBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

/*
 * Side panel vs. full tab: a page hosted in the side panel has no owning tab,
 * so getCurrent() resolves to undefined there. Only then is "open in tab" of
 * any use, so the button stays hidden in the tab view.
 */
(async () => {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (!tab) openTabBtn.classList.remove("hidden");
  } catch {
    // No tabs access: leave the button hidden rather than guess.
  }
})();

clearLogBtn.addEventListener("click", async () => {
  const log = await loadActivityLog();
  if (!log.length) return;

  /* Irreversible, and the log is the only record of what changed and when —
     the one place a rebuilt history cannot come from anywhere else. */
  const ok = await askConfirm({
    title: "Clear activity log?",
    message:
      `<strong>${log.length}</strong> recorded event${log.length === 1 ? "" : "s"} ` +
      `will be deleted. Tracked jobs are not affected.`,
    okLabel: "Clear log",
  });
  if (!ok) return;

  await chrome.storage.local.set({ [ACTIVITY_LOG_KEY]: [] });
  await refreshLog();
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes[TRACKED_JOBS_KEY] || changes[JOB_GROUPS_KEY]) void refreshJobs();
  if (changes[ACTIVITY_LOG_KEY]) void refreshLog();
  /* Another dashboard — a side panel beside a tab — fetched details we can use. */
  if (changes[JOB_DETAILS_KEY]) void hydrateDetailsCache();
  /*
   * A notification click on an ALREADY-OPEN dashboard just focuses the existing
   * tab — init() never runs again — so without this the click did nothing
   * visible. The worker writes focusJobId, and this reacts to it.
   */
  if (changes.focusJobId?.newValue) void focusRequestedJob();
  if (changes[AUTH_ERROR_KEY]) void refreshAuthBanner();
});

/* Arrives via a clicked notification: bring that job into view and mark it. */
async function focusRequestedJob() {
  const { focusJobId } = await chrome.storage.local.get("focusJobId");
  if (!focusJobId) return;

  await chrome.storage.local.remove("focusJobId");

  document.querySelector('.tab[data-tab="jobs"]')?.click();
  const row = jobsBody.querySelector(`tr[data-job-id="${CSS.escape(focusJobId)}"]`);
  if (!row) return;

  row.scrollIntoView({ block: "center", behavior: "smooth" });
  row.classList.add("is-focused");
  setTimeout(() => row.classList.remove("is-focused"), 2400);
}

/* Populate on open: any job that has never been checked gets one immediately,
   so the table does not sit on em-dashes waiting for the next alarm. */
async function init() {
  /* Before the first render, so a hover in the first second finds a full card
     rather than triggering a fetch for something already on disk. */
  await hydrateDetailsCache();
  await refreshJobs();
  await refreshLog();
  await renderSettings();
  await refreshAuthBanner();
  await focusRequestedJob();

  const jobs = await loadTrackedJobs();
  if (jobs.some((job) => !job.lastChecked)) void requestCheck();
}

void init();

setInterval(tickRings, 1000);
