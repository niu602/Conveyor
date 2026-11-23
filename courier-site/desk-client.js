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
   * A 4xx answer is the desk's own refusal and comes back as its body. Anything else that
   * goes wrong — the desk unreachable, a 5xx, or an answer that is not JSON — throws an
   * error marked `unknown`, because the caller cannot tell whether the call landed. A
   * write's caller must then read the outcome, never send the write again.
   *
   * :param path: The endpoint's path.
   * :param body: The JSON body, or null for a GET.
   * :return: A promise of the desk's answer.
   * :raises Error: With `unknown` set when the outcome cannot be told.
   */
  async send(path, body) {
    let response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method: body === null ? "GET" : "POST",
        headers: body === null ? {} : { "Content-Type": "application/json" },
        body: body === null ? undefined : JSON.stringify(body),
        credentials: "omit",
      });
    } catch (error) {
      throw DeskClient.unknown(`The desk's intake could not be reached: ${error && error.message}`, error);
    }
    if (response.status >= 500) {
      throw DeskClient.unknown(`The desk's intake failed with ${response.status}, so the outcome is not known.`);
    }
    try {
      return await response.json();
    } catch (error) {
      throw DeskClient.unknown("The desk's intake answered without JSON, so the outcome is not known.", error);
    }
  }

  /**
   * Mark an error as an outcome nobody can tell, so a caller never mistakes it for a
   * refusal it may safely repeat.
   *
   * :param message: What went wrong.
   * :param cause: The underlying error, if any.
   * :return: The error to throw.
   */
  static unknown(message, cause) {
    const error = new Error(message);
    error.unknown = true;
    if (cause) {
      error.cause = cause;
    }
    return error;
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
   * Settle a dispatch whose answer was lost, by its idempotency key. Reads only.
   *
   * :param key: The idempotency key the dispatch was sent with.
   * :return: A promise of {ok, recorded} and, when recorded, the job receipt.
   */
  outcome(key) {
    return this.send(`/api/dispatch/outcome?key=${encodeURIComponent(key)}`, null);
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
