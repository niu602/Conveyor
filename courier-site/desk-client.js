// The desk's intake, as one client. The page, the bridge frame and the dispatch window
// all send their calls through here, so there is one place that knows the endpoints.
//
// It throws when the desk cannot be reached. The caller decides what that means: the page
// falls back to its own copy, the bridge reports that it could not reach the desk.

/**
 * Talks to the courier desk's intake over HTTP.
 */
export class DeskClient {
  /**
   * Where the intake runs on this machine. When hosted, this is the site's own Worker on
   * the same origin, so change it to that origin before deploying.
   */
  static LOCAL_BASE = "http://127.0.0.1:8086";

  /**
   * :param base: The intake's base URL, without a trailing slash.
   */
  constructor(base) {
    this.base = base || DeskClient.LOCAL_BASE;
  }

  /**
   * Send one call and read its JSON answer.
   *
   * :param path: The endpoint's path.
   * :param body: The JSON body, or null for a GET.
   * :return: A promise of the desk's answer.
   * :raises Error: When the desk cannot be reached or answers without JSON.
   */
  async send(path, body) {
    const response = await fetch(`${this.base}${path}`, {
      method: body === null ? "GET" : "POST",
      headers: body === null ? {} : { "Content-Type": "application/json" },
      body: body === null ? undefined : JSON.stringify(body),
      credentials: "omit",
    });
    return await response.json();
  }

  /**
   * Price a run.
   *
   * :param request: The request with dropZone, parcelSize and itemCount.
   * :return: A promise of the quote, or a refusal.
   */
  quote(request) {
    return this.send("/api/quote", request);
  }

  /**
   * Check a dispatch against its quote, without recording anything.
   *
   * :param args: The dispatch facts, with quoteId and expectedFeeCents.
   * :return: A promise of the quote's summary, or a refusal.
   */
  checkDispatch(args) {
    return this.send("/api/dispatch/check", args);
  }

  /**
   * Record a dispatch. The desk returns the first job for a key it has already seen.
   *
   * :param args: The dispatch, with its idempotencyKey.
   * :param details: The visitor's details, which stay on the desk.
   * :return: A promise of the job receipt, or a refusal.
   */
  dispatch(args, details) {
    return this.send("/api/dispatch", { ...args, ...details });
  }

  /**
   * Read one job.
   *
   * :param jobId: The job number.
   * :return: A promise of the job's state, or a refusal.
   */
  job(jobId) {
    return this.send(`/api/jobs/${encodeURIComponent(jobId)}`, null);
  }

  /**
   * Read the desk's job list.
   *
   * :param limit: How many to read.
   * :return: A promise of the list.
   */
  jobs(limit = 20) {
    return this.send(`/api/jobs?limit=${limit}`, null);
  }

  /**
   * Cancel a job.
   *
   * :param jobId: The job number.
   * :param expectedStatus: The status the visitor saw.
   * :return: A promise of the cancelled job, or a refusal.
   */
  cancel(jobId, expectedStatus) {
    return this.send(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { expectedStatus });
  }
}
