// The D1 store the Worker uses. It has the same shape as MemoryStore in
// ../courier-desk.js, so the desk's rules run unchanged on either.
//
// The unique index on jobs.idempotency_key is what makes a replay safe: putJob inserts
// and, when the key is already taken, reads the first job back instead of writing again.

/**
 * A store backed by Cloudflare D1.
 */
export class D1Store {
  /**
   * :param db: The D1 binding.
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * Keep a quote.
   *
   * :param quote: The quote from the desk.
   * :return: A promise of the quote.
   */
  async putQuote(quote) {
    await this.db
      .prepare(
        `INSERT INTO quotes (id, drop_zone, parcel_size, item_count, fee_cents, eta_minutes, basis, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      .bind(
        quote.quoteId,
        quote.dropZone,
        quote.parcelSize,
        quote.itemCount,
        quote.feeCents,
        quote.etaMinutes,
        JSON.stringify(quote.basis),
        quote.createdAt,
        quote.expiresAt,
      )
      .run();
    return quote;
  }

  /**
   * Read a quote.
   *
   * :param id: The quote id.
   * :return: A promise of the quote, or null.
   */
  async getQuote(id) {
    const row = await this.db.prepare("SELECT * FROM quotes WHERE id = ?1").bind(id).first();
    if (!row) {
      return null;
    }
    return {
      quoteId: row.id,
      dropZone: row.drop_zone,
      parcelSize: row.parcel_size,
      itemCount: row.item_count,
      feeCents: row.fee_cents,
      etaMinutes: row.eta_minutes,
      basis: JSON.parse(row.basis),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  /**
   * Keep a job, unless its idempotency key already has one.
   *
   * :param job: The job from the desk.
   * :return: A promise of the stored job: this one, or the first with the same key.
   */
  async putJob(job) {
    const result = await this.db
      .prepare(
        `INSERT INTO jobs (id, quote_id, idempotency_key, pizza_order_ref, item_summary, drop_zone,
           parcel_size, item_count, customer_name, phone, address, note, fee_cents, eta_minutes,
           status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
         ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .bind(
        job.jobId,
        job.quoteId,
        job.idempotencyKey,
        job.pizzaOrderRef,
        job.itemSummary,
        job.dropZone,
        job.parcelSize,
        job.itemCount,
        job.customerName,
        job.phone,
        job.address,
        job.note,
        job.feeCents,
        job.etaMinutes,
        job.status,
        job.createdAt,
        job.updatedAt,
      )
      .run();
    // Whether or not this insert landed, the key now names exactly one job.
    return await this.getJobByKey(job.idempotencyKey);
  }

  /**
   * Read a job by its idempotency key.
   *
   * :param key: The key.
   * :return: A promise of the job, or null.
   */
  async getJobByKey(key) {
    const row = await this.db.prepare("SELECT * FROM jobs WHERE idempotency_key = ?1").bind(key).first();
    return row ? D1Store.jobOf(row) : null;
  }

  /**
   * Read a job.
   *
   * :param id: The job id.
   * :return: A promise of the job, or null.
   */
  async getJob(id) {
    const row = await this.db.prepare("SELECT * FROM jobs WHERE id = ?1").bind(id).first();
    return row ? D1Store.jobOf(row) : null;
  }

  /**
   * Change fields of a job.
   *
   * :param id: The job id.
   * :param fields: The fields to change, as status and updatedAt.
   * :return: A promise of the changed job.
   */
  async updateJob(id, fields) {
    await this.db
      .prepare("UPDATE jobs SET status = ?2, updated_at = ?3 WHERE id = ?1")
      .bind(id, fields.status, fields.updatedAt)
      .run();
    return await this.getJob(id);
  }

  /**
   * List the jobs, newest first.
   *
   * :param limit: How many to return.
   * :return: A promise of the jobs.
   */
  async listJobs(limit = 20) {
    const rows = await this.db
      .prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?1")
      .bind(limit)
      .all();
    return (rows.results || []).map(D1Store.jobOf);
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
    await this.db
      .prepare("INSERT INTO job_events (job_id, type, at, detail) VALUES (?1, ?2, ?3, ?4)")
      .bind(jobId, type, at, detail || "")
      .run();
  }

  /**
   * Read a job's events, oldest first.
   *
   * :param jobId: The job id.
   * :return: A promise of the events.
   */
  async listEvents(jobId) {
    const rows = await this.db
      .prepare("SELECT type, at, detail FROM job_events WHERE job_id = ?1 ORDER BY id ASC")
      .bind(jobId)
      .all();
    return (rows.results || []).map((row) => ({ type: row.type, at: row.at, detail: row.detail }));
  }

  /**
   * Turn a row into the job the desk works with.
   *
   * :param row: The row.
   * :return: The job.
   */
  static jobOf(row) {
    return {
      jobId: row.id,
      quoteId: row.quote_id,
      idempotencyKey: row.idempotency_key,
      pizzaOrderRef: row.pizza_order_ref,
      itemSummary: row.item_summary,
      dropZone: row.drop_zone,
      parcelSize: row.parcel_size,
      itemCount: row.item_count,
      customerName: row.customer_name,
      phone: row.phone,
      address: row.address,
      note: row.note,
      feeCents: row.fee_cents,
      etaMinutes: row.eta_minutes,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
