// Conveyor Courier's dispatch desk page.
//
// One page object, App.page, owns the state and every operation. The page's own forms
// and buttons call the same methods the assistant calls, so both follow one set of rules.
// The desk's business rules live in courier-desk.js and courier-data.js, which the
// Worker imports too.
import { CourierData } from "./courier-data.js";
import { CourierDesk, MemoryStore } from "./courier-desk.js";
import { seedDemoJob } from "./demo-job.js";
import { DeskClient } from "./desk-client.js";

/**
 * The dispatch desk page.
 */
export class App {
  /**
   * Where the desk's intake runs. On this machine it is the local server; when hosted it
   * is the site's own Worker on the same origin.
   */
  static API = DeskClient.LOCAL_BASE;

  /**
   * The clock the page reads. Set App.fixedNow in tests to pin it.
   */
  static fixedNow = null;

  /**
   * Read the clock, in one place only.
   *
   * :return: The current Date.
   */
  static now() {
    return App.fixedNow ? new Date(App.fixedNow) : new Date();
  }

  /**
   * Build the page: its state, its local fallback store and its bindings.
   */
  constructor() {
    this.localStore = new MemoryStore();
    this.desk = new CourierDesk(this.localStore, App.now);
    // The documented demo job, for the page's own copy when the desk is unreachable.
    this.ready = seedDemoJob(this.localStore);
    this.jobs = [];
    this.lastQuote = null;
    this.lastJob = null;
    this.lastError = "";
    this.deskReachable = null;
    this.version = 0;
    this.bind();
    this.render();
  }

  /**
   * Wire the page's own forms and buttons to the same operations the assistant calls.
   */
  bind() {
    const quoteForm = document.querySelector("#quote-form");
    if (quoteForm) {
      quoteForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const elements = quoteForm.elements;
        this.requestQuote({
          dropZone: elements.dropZone.value,
          parcelSize: elements.parcelSize.value,
          itemCount: Number(elements.itemCount.value),
        }).then(() => this.render());
      });
    }
    const lookupForm = document.querySelector("#lookup-form");
    if (lookupForm) {
      lookupForm.addEventListener("submit", (event) => {
        event.preventDefault();
        this.lookupJob(lookupForm.elements.jobId.value).then(() => this.render());
      });
    }
    const refresh = document.querySelector("#refresh-jobs");
    if (refresh) {
      refresh.addEventListener("click", () => this.refreshJobs());
    }
    const cancelForm = document.querySelector("#cancel-form");
    if (cancelForm) {
      cancelForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const elements = cancelForm.elements;
        this.cancelJob(elements.jobId.value, elements.expectedStatus.value);
      });
    }
  }

  /**
   * Ask the desk for a quote. Books nothing and draws nothing: the page's own handler
   * draws the result, so the assistant's call never replaces what the visitor is looking
   * at while they type.
   *
   * :param request: The request with dropZone, parcelSize and itemCount.
   * :return: A promise of the quote, or {ok: false, reason, field}.
   */
  async requestQuote(request) {
    const problem = CourierData.quoteProblem(request);
    if (problem) {
      this.lastError = problem.reason;
      return problem;
    }
    this.lastError = "";
    const quote = await this.callDesk("/api/quote", request, () => this.desk.quote(request));
    if (quote.ok) {
      this.lastQuote = quote;
      this.version += 1;
    } else {
      this.lastError = quote.reason;
    }
    return quote;
  }

  /**
   * Read the desk's jobs. The visitor's own details are not part of this list.
   *
   * :return: A promise of the job list.
   */
  async refreshJobs() {
    const result = await this.callDesk("/api/jobs?limit=20", null, async () => ({
      ok: true,
      jobs: (await this.localStore.listJobs(20)).map(CourierDesk.receipt),
    }));
    if (result.ok) {
      this.jobs = result.jobs;
      this.lastError = "";
    } else {
      this.lastError = result.reason;
    }
    this.render();
    return result;
  }

  /**
   * Read one job by its number. Draws nothing: the page's own handler draws the result.
   *
   * :param jobId: The job number the visitor has.
   * :return: A promise of the job's state, or {ok: false, reason, field}.
   */
  async lookupJob(jobId) {
    const id = String(jobId || "").trim();
    if (!id) {
      const refusal = { ok: false, reason: "Give the job number, such as J-1234.", field: "jobId" };
      this.lastError = refusal.reason;
      return refusal;
    }
    this.lastError = "";
    const result = await this.callDesk(`/api/jobs/${encodeURIComponent(id)}`, null, () => this.desk.jobStatus(id));
    if (result.ok) {
      this.lastJob = result;
    } else {
      this.lastError = result.reason;
    }
    return result;
  }

  /**
   * Cancel a job before the courier picks it up.
   *
   * :param jobId: The job number.
   * :param expectedStatus: The status the visitor saw.
   * :return: A promise of the cancelled job, or {ok: false, reason, field}.
   */
  async cancelJob(jobId, expectedStatus) {
    const id = String(jobId || "").trim();
    if (!id) {
      const refusal = { ok: false, reason: "Give the job number to cancel.", field: "jobId" };
      this.lastError = refusal.reason;
      this.render();
      return refusal;
    }
    this.lastError = "";
    const body = { expectedStatus: String(expectedStatus || "").trim() };
    const result = await this.callDesk(
      `/api/jobs/${encodeURIComponent(id)}/cancel`,
      body,
      () => this.desk.cancel(id, body.expectedStatus),
    );
    if (result.ok) {
      this.lastJob = result;
      await this.refreshJobs();
    } else {
      this.lastError = result.reason;
      this.render();
    }
    return result;
  }

  /**
   * Read what cancelling a job would do, without changing anything.
   *
   * The confirmation dialog calls this, so its words come from the desk's own rule rather
   * than a copy of it here.
   *
   * :param jobId: The job number.
   * :param expectedStatus: The status the visitor saw.
   * :return: A promise of the details by label, or {refusal: reason}.
   */
  async checkCancel(jobId, expectedStatus) {
    const id = String(jobId || "").trim();
    const result = await this.callDesk(
      `/api/jobs/${encodeURIComponent(id)}`,
      null,
      () => this.desk.jobStatus(id),
    );
    if (!result.ok) {
      return { refusal: result.reason };
    }
    if (String(expectedStatus || "").trim() !== result.status) {
      return { refusal: `The job is now ${result.status}, not ${expectedStatus}. Read it again before cancelling.` };
    }
    if (!CourierData.cancellable(result.status)) {
      return { refusal: CourierData.cancelProblem(result.status) };
    }
    return {
      "Job": result.jobId,
      "Status": result.status,
      "Delivery zone": result.dropZone,
      "Fee": result.feeText,
      "Undoing it": "A cancelled job stays cancelled. A new run needs a new dispatch.",
    };
  }

  /**
   * Call the desk's intake, falling back to this page's own store when it is unreachable.
   *
   * A failed write is never retried here: the caller gets ok false with a reason saying
   * the outcome is unknown, and reads the job instead.
   *
   * :param path: The endpoint's path.
   * :param body: The JSON body, or null for a GET.
   * :param local: A function doing the same thing on this page's store.
   * :return: A promise of the desk's answer.
   */
  async callDesk(path, body, local) {
    try {
      this.deskReachable = true;
      return await new DeskClient(App.API).send(path, body);
    } catch {
      this.deskReachable = false;
      await this.ready;
      return await local();
    }
  }

  /**
   * Read the page's state as plain data, for the assistant and for the tests.
   *
   * :return: The state, with today, the fee table, the page's facts and the current results.
   */
  getState() {
    const now = App.now();
    return {
      today: now.toISOString().slice(0, 10),
      todayLabel: now.toLocaleDateString("en-US", { weekday: "short", year: "numeric", month: "short", day: "numeric" }),
      now: now.toISOString(),
      deskOpen: CourierData.openAt(`${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`),
      hours: { ...CourierData.HOURS },
      zones: CourierData.ZONES.map((zone) => ({
        id: zone.id,
        name: zone.name,
        baseFee: CourierData.money(zone.baseCents),
        baseFeeCents: zone.baseCents,
        minutes: zone.etaMinutes,
        served: zone.id !== "outside",
      })),
      parcelSizes: CourierData.SIZES.map((size) => ({
        id: size.id,
        name: size.name,
        extraFee: CourierData.money(size.extraCents),
        extraFeeCents: size.extraCents,
        maxItems: size.maxItems,
        extraMinutes: size.extraMinutes,
      })),
      perExtraItem: CourierData.money(CourierData.PER_EXTRA_ITEM_CENTS),
      perExtraItemCents: CourierData.PER_EXTRA_ITEM_CENTS,
      quoteValidMinutes: CourierData.QUOTE_TTL_MINUTES,
      facts: App.pageFacts(),
      version: this.version,
      lastQuote: this.lastQuote ? { ...this.lastQuote } : null,
      jobs: this.jobs.map((job) => ({ ...job })),
      lastJob: this.lastJob ? { ...this.lastJob } : null,
      deskReachable: this.deskReachable,
      lastError: this.lastError,
    };
  }

  /**
   * Read the facts that only the page's HTML holds, with their links.
   *
   * :return: The facts, each with its text.
   */
  static pageFacts() {
    const read = (selector) => document.querySelector(selector)?.textContent.trim() || "";
    const link = document.querySelector("#courier-contact");
    return {
      cancellation: read("#cancel-rule"),
      service: read("#service-note"),
      contact: read("#contact-note"),
      phone: link?.getAttribute("href") || "",
      pizzaPartner: document.querySelector("#pizza-link")?.getAttribute("href") || "",
      pizzaPartnerName: read("#pizza-link"),
    };
  }

  /**
   * Draw the page from its state.
   */
  render() {
    const quoteBox = document.querySelector("#quote-result");
    if (quoteBox) {
      quoteBox.textContent = this.lastQuote
        ? `${this.lastQuote.feeText} · about ${this.lastQuote.etaMinutes} min · quote ${this.lastQuote.quoteId} · valid until ${this.lastQuote.expiresAt}`
        : "No quote yet.";
    }
    const jobsList = document.querySelector("#jobs-list");
    if (jobsList) {
      jobsList.replaceChildren();
      for (const job of this.jobs) {
        const item = document.createElement("li");
        item.textContent = `${job.jobId} · ${job.status} · ${job.dropZone} · ${job.feeText}`;
        jobsList.append(item);
      }
      if (!this.jobs.length) {
        const item = document.createElement("li");
        item.textContent = "No jobs yet.";
        jobsList.append(item);
      }
    }
    const jobBox = document.querySelector("#job-result");
    if (jobBox) {
      jobBox.textContent = this.lastJob
        ? `${this.lastJob.jobId} · ${this.lastJob.status} · ${this.lastJob.feeText} · updated ${this.lastJob.updatedAt}`
        : "No job looked up yet.";
    }
    const errorBox = document.querySelector("#desk-error");
    if (errorBox) {
      errorBox.textContent = this.lastError;
      errorBox.hidden = !this.lastError;
    }
    const reach = document.querySelector("#desk-status");
    if (reach) {
      reach.textContent = this.deskReachable === false
        ? "The desk's intake is not reachable. This page is showing its own local copy."
        : "";
    }
  }
}

// The page object, made once. The actions module imports this same module by the same
// URL, so the assistant and the page share this one object.
if (typeof document !== "undefined" && document.querySelector("#quote-form")) {
  App.page = new App();
}
