(function () {
  if (window.__upworkSimpleLoaded) return;
  window.__upworkSimpleLoaded = true;

  const MARK = "data-upwork-simple-activity";
  const processed = new WeakSet();

  function item(testId, label, value) {
    return (
      `<li data-test="${testId}" class="pr-6 pt-3">` +
      `<span class="font-weight-light mr-1">${label}:</span> ` +
      `<strong>${value}</strong></li>`
    );
  }

  function buildActivityHtml(summary) {
    const parts = [];

    if (summary.proposals !== null && summary.proposals !== undefined) {
      parts.push(item("proposals-tier", "Proposals", summary.proposals));
    }
    if (summary.interviewing !== null && summary.interviewing !== undefined) {
      parts.push(item("interviewing-tier", "Interviewing", summary.interviewing));
    }
    if (summary.lastViewed) {
      parts.push(item("lastviewd-tier", "Last viewed", summary.lastViewed));
    }
    if (summary.invitesSent) {
      parts.push(item("invites-tier", "Invites sent", summary.invitesSent));
      if (summary.unansweredInvites) {
        parts.push(
          item("unansweredinvites-tier", "Unanswered invites", summary.unansweredInvites)
        );
      }
    }
    if (summary.hires) {
      parts.push(item("hires-tier", "Hires", summary.hires));
    }

    if (!parts.length) return null;

    return (
      `<ul class="d-flex align-items-center flex-wrap text-light text-base-sm mt-3" ` +
      `data-test="JobInfoClientMore" ${MARK}="1">` +
      parts.join("") +
      `</ul>`
    );
  }

  function applyActivity(article, summary) {
    const jobDetails = article.querySelector("[data-test='JobTileDetails']");
    if (!jobDetails) return;

    const html = buildActivityHtml(summary);
    if (!html) return;

    const freelancersNeeded = jobDetails
      .querySelector('ul[data-test="JobInfoClientMore"] [data-test="freelancers-to-hire"]')
      ?.outerHTML;

    jobDetails.querySelectorAll('ul[data-test="JobInfoClientMore"]').forEach((el) => el.remove());

    let finalHtml = html;
    if (freelancersNeeded) {
      finalHtml = html.replace("</ul>", `${freelancersNeeded}</ul>`);
    }

    jobDetails.insertAdjacentHTML("beforeend", finalHtml);
  }

  async function enrichTile(article) {
    if (processed.has(article)) return;

    const uid = article.getAttribute("data-ev-job-uid");
    const jobDetails = article.querySelector("[data-test='JobTileDetails']");
    if (!uid || !jobDetails) return;

    processed.add(article);

    const jobId = uid.startsWith("~") ? uid : `~02${uid}`;

    try {
      const details = await UpworkApi.fetchJobDetails(jobId);
      const summary = UpworkApi.summarizeActivity(details);
      applyActivity(article, summary);
    } catch {
      processed.delete(article);
    }
  }

  /*
   * The full brief, as soon as Upwork paints the job panel. Search tiles only
   * carry a snippet (UpCLineClamp JobDescription); the complete text is the
   * Description block in the slider or on the job page. textContent, not
   * innerText — line-clamp hides lines from innerText while the words stay
   * in the DOM.
   */
  let descButton = null;
  let descWatch = { key: "", text: "", jobId: "" };
  let copyBusy = false;

  function fullDescriptionNode() {
    const slider = document.querySelector(
      ".air3-slider [data-test='Description'], [data-test='job-details'] [data-test='Description']"
    );
    if (slider) return slider;

    const nodes = [...document.querySelectorAll("[data-test='Description']")].filter(
      (node) => !node.closest("article")
    );
    if (!nodes.length) return null;
    return nodes.reduce((best, node) =>
      (node.textContent || "").length > (best.textContent || "").length ? node : best
    );
  }

  function jobIdFromPanel(node) {
    const fromUrl = UpworkApi.parseJobId(location.href);
    if (fromUrl) return fromUrl;
    const root = node?.closest(".air3-slider, [data-test='job-details']") || document;
    const link = root.querySelector("a[href*='~0']");
    return UpworkApi.parseJobId(link?.getAttribute("href") || "");
  }

  function nodeText(node) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll("button, script, style, [role='tooltip']").forEach((el) => el.remove());
    clone.querySelectorAll("br").forEach((el) => el.replaceWith("\n"));
    clone.querySelectorAll("p, li, h1, h2, h3, h4").forEach((el) => {
      el.appendChild(document.createTextNode("\n"));
    });
    return (clone.textContent || "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function plainDescription(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (!/<[a-z][\s\S]*>/i.test(raw)) return raw;
    const holder = document.createElement("div");
    holder.innerHTML = raw;
    return nodeText(holder);
  }

  function readLiveDescription() {
    const node = fullDescriptionNode();
    if (!node) return { node: null, text: "", jobId: "" };
    const jobId = jobIdFromPanel(node);
    const key = `${jobId || location.pathname}:${(node.textContent || "").length}`;
    if (descWatch.key === key) return { node, text: descWatch.text, jobId: descWatch.jobId };
    const text = nodeText(node);
    descWatch = { key, text, jobId };
    return { node, text, jobId };
  }

  function ensureDescButton() {
    if (descButton?.isConnected) return descButton;
    descButton = document.createElement("button");
    descButton.type = "button";
    descButton.className = "upwork-simple-copy-jd";
    descButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void copyDescription();
    });
    document.documentElement.appendChild(descButton);
    return descButton;
  }

  function updateDescriptionButton() {
    if (copyBusy) return;
    const live = readLiveDescription();
    if (!live.text || live.text.length < 20) {
      descButton?.remove();
      descButton = null;
      descWatch = { key: "", text: "", jobId: "" };
      return;
    }

    const btn = ensureDescButton();
    const jobKey = live.jobId || "open";
    if (btn.dataset.jobId !== jobKey) {
      btn.dataset.jobId = jobKey;
      btn.dataset.state = "";
    }
    if (btn.dataset.state === "copied" || copyBusy) return;
    btn.textContent = `Copy description (${live.text.length.toLocaleString()})`;
  }

  function descriptionLooksCut(node) {
    if (!node) return true;
    return [...node.querySelectorAll("button, [role='button']")].some((el) => {
      const label = `${el.getAttribute("aria-label") || ""} ${el.textContent || ""}`;
      return /more/i.test(label) && !/less/i.test(label);
    });
  }

  function expandDescription(node) {
    node.querySelectorAll("button, [role='button']").forEach((el) => {
      const label = `${el.getAttribute("aria-label") || ""} ${el.textContent || ""}`;
      if (/more/i.test(label) && !/less/i.test(label)) el.click();
    });
  }

  function writeClipboard(text) {
    const fallback = () => {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.left = "-9999px";
      document.body.appendChild(area);
      area.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      area.remove();
      return ok;
    };

    if (!navigator.clipboard?.writeText) return Promise.resolve(fallback());
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => fallback()
    );
  }

  async function descriptionFromApi(jobId) {
    if (!jobId || !chrome.runtime?.sendMessage) return "";
    try {
      const res = await chrome.runtime.sendMessage({
        type: "upwork-simple:details",
        jobId,
        url: location.href,
      });
      return plainDescription(res?.data?.description);
    } catch {
      return "";
    }
  }

  async function copyDescription() {
    if (copyBusy) return;
    const btn = ensureDescButton();
    copyBusy = true;
    btn.classList.add("is-busy");
    btn.textContent = "Getting the full description…";

    try {
      const node = fullDescriptionNode();
      if (node) expandDescription(node);
      await new Promise((resolve) => setTimeout(resolve, 450));

      descWatch.key = "";
      const live = readLiveDescription();
      let text = live.text;
      const stillCut = descriptionLooksCut(fullDescriptionNode());
      if (stillCut || text.length < 80) {
        const api = await descriptionFromApi(live.jobId);
        if (api.length > text.length) text = api;
      }

      if (!text) {
        btn.dataset.state = "";
        btn.textContent = "No description yet";
        return;
      }

      const ok = await writeClipboard(text);
      btn.dataset.jobId = live.jobId || btn.dataset.jobId || "open";
      btn.dataset.state = ok ? "copied" : "";
      btn.textContent = ok
        ? `Copied · ${text.length.toLocaleString()} characters`
        : "Could not copy";
    } finally {
      copyBusy = false;
      btn.classList.remove("is-busy");
    }
  }

  function scan() {
    updateDescriptionButton();
    if (!UpworkApi.getVisitorToken()) return;
    document.querySelectorAll("article[data-ev-job-uid]").forEach((tile) => {
      void enrichTile(tile);
    });
  }

  function waitForTiles(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (document.querySelector("article[data-ev-job-uid]")) {
          clearInterval(timer);
          resolve();
          return;
        }
        if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error("Job tiles not found"));
        }
      }, 200);
    });
  }

  function boot() {
    updateDescriptionButton();
    waitForTiles()
      .then(() => scan())
      .catch(() => updateDescriptionButton());
  }

  boot();

  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      boot();
      return;
    }
    scan();
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
