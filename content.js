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

  function scan() {
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
    waitForTiles()
      .then(() => scan())
      .catch(() => {});
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
