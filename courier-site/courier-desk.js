// Conveyor Courier's desk: quotes and jobs, with the rules every caller shares.
//
// This module holds no DOM and no transport. It takes a store (the Worker's D1, or an
// in-memory store in the page and the tests) and a clock, so the same intake rules run
// in the browser, in the Worker and in the tests.
//
// The one rule that must never bend: a dispatch carries an idempotency key. Replaying
// the same key returns the first job, never a second one. A failed call whose outcome is
// unknown is resolved by reading the job, never by writing again.
import { CourierData } from "./courier-data.js";

/**
 * The desk's quote and job operations.
 */
export class CourierDesk {
  /**
   * :param store: The store with getQuote, putQuote, getJobByKey, getJob, putJob,
   *   listJobs and addEvent.
   * :param now: A function returning the current Date.
   * :param ids: A function returning a fresh unique id string.
   */
  constructor(store, now, ids) {
    this.store = store;
    this.now = now || (() => new Date());
    this.ids = ids || CourierDesk.randomId;
  }

  /**
   * Make an id from the runtime's random source.
   *
   * :return: A unique id string.
   */
  static randomId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /**
   * Quote a delivery, and keep the quote so a dispatch can be checked against it.
   *
   * :param request: The request with dropZone, parcelSize and itemCount.
   * :return: A promise of the quote, or {ok: false, reason, field}.
   */
  async quote(request) {
    const problem = CourierData.quoteProblem(request);
    if (problem) {
      return problem;
    }
    const priced = CourierData.priceOf(request);
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + CourierData.QUOTE_TTL_MINUTES * 60000);
    const quote = {
      quoteId: `Q-${this.ids()}`,
      dropZone: request.dropZone,
      parcelSize: request.parcelSize,
      itemCount: request.itemCount,
      feeCents: priced.feeCents,
      feeText: CourierData.money(priced.feeCents),
      etaMinutes: priced.etaMinutes,
      basis: priced.basis,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    await this.store.putQuote(quote);
    return { ok: true, ...quote };
  }

  /**
   * Check a dispatch against its quote and the desk's rules, changing nothing.
   *
   * :param args: The dispatch with quoteId, expectedFeeCents and the parcel facts.
   * :param details: The visitor's details, checked when given.
   * :return: A promise of {ok: true, quote} or {ok: false, reason, field, code}.
   */
  async checkDispatch(args, details) {
    const quote = await this.store.getQuote(args?.quoteId);
    if (!quote) {
      return { ok: false, reason: "That quote is not on the desk. Ask for a new quote.", field: "quoteId", code: "quote_missing" };
    }
    if (this.now().getTime() >= new Date(quote.expiresAt).getTime()) {
      return { ok: false, reason: "That quote has expired. Ask for a new quote.", field: "quoteId", code: "quote_expired" };
    }
    if (quote.dropZone !== args.dropZone || quote.parcelSize !== args.parcelSize || quote.itemCount !== args.itemCount) {
      return {
        ok: false,
        reason: "The parcel does not match the quote. Ask for a new quote for this parcel.",
        field: "quoteId",
        code: "quote_mismatch",
      };
    }
    if (!Number.isInteger(args.expectedFeeCents) || args.expectedFeeCents !== quote.feeCents) {
      return {
        ok: false,
        reason: `The fee for this delivery is ${quote.feeText}, not the amount given. Ask for a new quote.`,
        field: "expectedFeeCents",
        code: "quote_changed",
        currentFeeCents: quote.feeCents,
      };
    }
    if (details) {
      const errors = CourierData.detailErrors(details);
      const first = Object.keys(errors)[0];
      if (first) {
        return { ok: false, reason: errors[first], field: first, errors };
      }
    }
    return { ok: true, quote };
  }

  /**
   * Record a dispatch, once per idempotency key.
   *
   * :param args: The dispatch, with quoteId, expectedFeeCents, idempotencyKey, the parcel
   *   facts and the optional pizzaOrderRef and itemSummary.
   * :param details: The visitor's details, which never leave the desk.
   * :return: A promise of the job receipt, or {ok: false, reason, field, code}.
   */
  async dispatch(args, details) {
    const key = String(args?.idempotencyKey || "").trim();
    if (!key) {
      return { ok: false, reason: "A dispatch needs an idempotency key.", field: "idempotencyKey" };
    }
    // Read first: a replay of a key that already landed returns that job, unchanged.
    const existing = await this.store.getJobByKey(key);
    if (existing) {
      return { ok: true, replayed: true, ...CourierDesk.receipt(existing) };
    }
    const check = await this.checkDispatch(args, details);
    if (!check.ok) {
      return check;
    }
    const at = this.now().toISOString();
    const job = {
      jobId: `J-${this.ids()}`,
      quoteId: check.quote.quoteId,
      idempotencyKey: key,
      pizzaOrderRef: String(args.pizzaOrderRef || ""),
      itemSummary: String(args.itemSummary || ""),
      dropZone: args.dropZone,
      parcelSize: args.parcelSize,
      itemCount: args.itemCount,
      customerName: String(details.customerName).trim(),
      phone: String(details.phone).trim(),
      address: String(details.address).trim(),
      note: String(details.note || "").trim(),
      feeCents: check.quote.feeCents,
      etaMinutes: check.quote.etaMinutes,
      status: "assigned",
      createdAt: at,
      updatedAt: at,
    };
    // The store enforces the key. A second writer that raced us gets the first job back.
    const stored = await this.store.putJob(job);
    await this.store.addEvent(stored.jobId, "assigned", at, `${stored.dropZone}, ${stored.itemCount} items`);
    return { ok: true, replayed: stored.jobId !== job.jobId, ...CourierDesk.receipt(stored) };
  }

  /**
   * Read one job, without its visitor details.
   *
   * :param jobId: The job's id.
   * :return: A promise of the job's public state, or {ok: false, reason}.
   */
  async jobStatus(jobId) {
    const job = await this.store.getJob(String(jobId || "").trim());
    if (!job) {
      return { ok: false, reason: "No job with that number is on the desk.", field: "jobId" };
    }
    const events = await this.store.listEvents(job.jobId);
    return { ok: true, ...CourierDesk.receipt(job), events };
  }

  /**
   * Cancel a job while the courier has not picked it up.
   *
   * :param jobId: The job's id.
   * :param expectedStatus: The status the visitor saw.
   * :return: A promise of the cancelled job, or {ok: false, reason, field}.
   */
  async cancel(jobId, expectedStatus) {
    const job = await this.store.getJob(String(jobId || "").trim());
    if (!job) {
      return { ok: false, reason: "No job with that number is on the desk.", field: "jobId" };
    }
    if (expectedStatus && job.status !== expectedStatus) {
      return {
        ok: false,
        reason: `That job is now ${job.status}, not ${expectedStatus}. Read it again before cancelling.`,
        field: "expectedStatus",
      };
    }
    if (!CourierData.cancellable(job.status)) {
      return {
        ok: false,
        reason: CourierData.cancelProblem(job.status),
        field: "jobId",
      };
    }
    const at = this.now().toISOString();
    const updated = await this.store.updateJob(job.jobId, { status: "cancelled", updatedAt: at });
    await this.store.addEvent(job.jobId, "cancelled", at, "");
    return { ok: true, ...CourierDesk.receipt(updated) };
  }

  /**
   * Move a job to its next status, as the desk's own controls do.
   *
   * :param jobId: The job's id.
   * :param status: The new status.
   * :return: A promise of the job, or {ok: false, reason, field}.
   */
  async advance(jobId, status) {
    const job = await this.store.getJob(String(jobId || "").trim());
    if (!job) {
      return { ok: false, reason: "No job with that number is on the desk.", field: "jobId" };
    }
    const order = CourierData.STATUSES;
    if (!order.includes(status) || status === "cancelled") {
      return { ok: false, reason: "A job moves to picked_up or delivered.", field: "status" };
    }
    if (order.indexOf(status) !== order.indexOf(job.status) + 1) {
      return { ok: false, reason: `A job that is ${job.status} cannot go to ${status}.`, field: "status" };
    }
    const at = this.now().toISOString();
    const updated = await this.store.updateJob(job.jobId, { status, updatedAt: at });
    await this.store.addEvent(job.jobId, status, at, "");
    return { ok: true, ...CourierDesk.receipt(updated) };
  }

  /**
   * Describe a job for anyone outside the desk: never the visitor's details.
   *
   * :param job: The stored job.
   * :return: The job's number, status, fee and times.
   */
  static receipt(job) {
    return {
      jobId: job.jobId,
      status: job.status,
      dropZone: job.dropZone,
      parcelSize: job.parcelSize,
      itemCount: job.itemCount,
      itemSummary: job.itemSummary,
      pizzaOrderRef: job.pizzaOrderRef,
      feeCents: job.feeCents,
      feeText: CourierData.money(job.feeCents),
      etaMinutes: job.etaMinutes,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }
}

/**
 * An in-memory store with the same shape as the Worker's D1 store.
 *
 * Used by the page before the desk is reachable, and by the tests. It enforces the
 * idempotency key exactly as the database does.
 */
export class MemoryStore {
  /**
   * Make an empty store.
   */
  constructor() {
    this.quotes = new Map();
    this.jobs = new Map();
    this.byKey = new Map();
    this.events = [];
  }

  /**
   * Keep a quote.
   *
   * :param quote: The quote.
   * :return: A promise of the quote.
   */
  async putQuote(quote) {
    this.quotes.set(quote.quoteId, { ...quote });
    return quote;
  }

  /**
   * Read a quote.
   *
   * :param id: The quote id.
   * :return: A promise of a copy of the quote, or null.
   */
  async getQuote(id) {
    const quote = this.quotes.get(id);
    return quote ? { ...quote } : null;
  }

  /**
   * Keep a job, unless its idempotency key already has one.
   *
   * :param job: The job.
   * :return: A promise of the stored job: this one, or the first with the same key.
   */
  async putJob(job) {
    const first = this.byKey.get(job.idempotencyKey);
    if (first) {
      return { ...this.jobs.get(first) };
    }
    this.jobs.set(job.jobId, { ...job });
    this.byKey.set(job.idempotencyKey, job.jobId);
    return { ...job };
  }

  /**
   * Read a job by its idempotency key.
   *
   * :param key: The key.
   * :return: A promise of a copy of the job, or null.
   */
  async getJobByKey(key) {
    const id = this.byKey.get(key);
    return id ? { ...this.jobs.get(id) } : null;
  }

  /**
   * Read a job.
   *
   * :param id: The job id.
   * :return: A promise of a copy of the job, or null.
   */
  async getJob(id) {
    const job = this.jobs.get(id);
    return job ? { ...job } : null;
  }

  /**
   * Change fields of a job.
   *
   * :param id: The job id.
   * :param fields: The fields to change.
   * :return: A promise of the changed job.
   */
  async updateJob(id, fields) {
    const job = { ...this.jobs.get(id), ...fields };
    this.jobs.set(id, job);
    return { ...job };
  }

  /**
   * List the jobs, newest first.
   *
   * :param limit: How many to return.
   * :return: A promise of copies of the jobs.
   */
  async listJobs(limit = 20) {
    return [...this.jobs.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit)
      .map((job) => ({ ...job }));
  }

  /**
   * Record one event of a job.
   *
   * :param jobId: The job id.
   * :param type: The event type.
   * :param at: When it happened.
   * :param detail: A short note.
   * :return: A promise of nothing.
   */
  async addEvent(jobId, type, at, detail) {
    this.events.push({ jobId, type, at, detail });
  }

  /**
   * Read a job's events, oldest first.
   *
   * :param jobId: The job id.
   * :return: A promise of the events.
   */
  async listEvents(jobId) {
    return this.events.filter((event) => event.jobId === jobId).map((event) => ({ ...event }));
  }
}
