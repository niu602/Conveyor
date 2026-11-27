// A desk store that survives a restart, for local work only.
//
// The Worker uses D1 and is untouched by this file. local-server.mjs uses this instead of
// a bare MemoryStore so a demo job is still on the desk after the process is stopped —
// including after a hard kill, which is what the restart test does.
//
// Every write is flushed to one JSON file, written to a temporary name and renamed, so a
// kill mid-write leaves the previous good file rather than a truncated one.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { MemoryStore } from "../courier-desk.js";

/**
 * An in-memory desk store mirrored to a file after every change.
 */
export class FileStore extends MemoryStore {
  /**
   * :param file: Where the desk's data is kept.
   */
  constructor(file) {
    super();
    this.file = file;
  }

  /**
   * Open a desk, reading back whatever the last process left.
   *
   * :param file: Where the desk's data is kept.
   * :return: A promise of the store, filled from the file when there is one.
   */
  static async open(file) {
    const store = new FileStore(file);
    let saved;
    try {
      saved = JSON.parse(await readFile(file, "utf8"));
    } catch {
      // No file yet, or one that cannot be read: start empty rather than refuse to run.
      return store;
    }
    for (const quote of saved.quotes || []) {
      store.quotes.set(quote.quoteId, quote);
    }
    for (const job of saved.jobs || []) {
      store.jobs.set(job.jobId, job);
      store.byKey.set(job.idempotencyKey, job.jobId);
    }
    store.events = saved.events || [];
    return store;
  }

  /**
   * Write the whole desk to its file, atomically.
   *
   * :return: A promise of nothing.
   */
  async flush() {
    const text = JSON.stringify({
      quotes: [...this.quotes.values()],
      jobs: [...this.jobs.values()],
      events: this.events,
    });
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, text, "utf8");
    await rename(temporary, this.file);
  }

  /**
   * Keep a quote, then flush.
   *
   * :param quote: The quote.
   * :return: A promise of the quote.
   */
  async putQuote(quote) {
    const kept = await super.putQuote(quote);
    await this.flush();
    return kept;
  }

  /**
   * Keep a job, then flush.
   *
   * :param job: The job.
   * :return: A promise of the stored job.
   */
  async putJob(job) {
    const kept = await super.putJob(job);
    await this.flush();
    return kept;
  }

  /**
   * Change a job, then flush.
   *
   * :param id: The job id.
   * :param fields: The fields to change.
   * :return: A promise of the changed job.
   */
  async updateJob(id, fields) {
    const kept = await super.updateJob(id, fields);
    await this.flush();
    return kept;
  }

  /**
   * Record an event, then flush.
   *
   * :param jobId: The job id.
   * :param type: The event type.
   * :param at: When it happened.
   * :param detail: A short note.
   * :return: A promise of nothing.
   */
  async addEvent(jobId, type, at, detail) {
    await super.addEvent(jobId, type, at, detail);
    await this.flush();
  }
}