// Registers Conveyor Courier's page operations with the agent runtime.
// agent-manifest.json loads this module through "actions.module". Only the names in
// "actions.agentTools" become model tools, called website_<name>.
//
// Each action wraps a method on App.page, so the assistant and the page's own forms
// share one set of rules. This module imports script.js by the same URL index.html
// loads it from, so both use the same page object.
import { App } from "./script.js";
import { CourierData } from "./courier-data.js";

/**
 * Describes the dispatch desk's operations as actions the agents can call.
 */
class SiteActions {
  /**
   * Register every page action with the runtime.
   *
   * :param actions: The runtime registry facade with a register(definition) method.
   */
  static registerActions(actions) {
    actions.register(SiteActions.readStateAction());
    actions.register(SiteActions.requestQuoteAction());
    actions.register(SiteActions.lookupJobAction());
    actions.register(SiteActions.cancelJobAction());
  }

  /**
   * Describe the read that returns the desk's data and the page's current state.
   *
   * :return: The action definition.
   */
  static readStateAction() {
    return {
      name: "get_dispatch_state",
      description: "Read the delivery zones with their base fees and trip times, the parcel sizes with their limits and extra fees, the per-item charge, how long a quote lasts, today's date and time and whether the desk is open, the page's facts with links (service area, cancellation rule, phone, the pizza partner), the current quote, the job list and the last job looked up. Call it before answering about any of these, and again in each turn that needs it: the visitor can also use the page.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: SiteActions.readState,
    };
  }

  /**
   * Return a fresh copy of the page state.
   *
   * :return: A promise of the state as plain JSON data.
   */
  static readState() {
    return App.page.getState();
  }

  /**
   * Describe the read that prices a run without booking anything.
   *
   * :return: The action definition.
   */
  static requestQuoteAction() {
    return {
      name: "request_quote",
      description: "Price a delivery and hold the quote for 15 minutes. Takes the drop zone, the parcel size and how many items. Changes nothing and books nothing: it returns the quote id, the fee, the trip minutes and when the quote expires. The desk refuses a zone outside Marrow Point and a parcel too small for the item count, with its own reason. Call it before telling the visitor a price, and again whenever the parcel changes.",
      effect: "read",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["dropZone", "parcelSize", "itemCount"],
        properties: {
          dropZone: {
            type: "string",
            enum: CourierData.zoneIds(),
            description: "The zone to deliver to, from website_get_dispatch_state.",
          },
          parcelSize: {
            type: "string",
            enum: CourierData.sizeIds(),
            description: "The parcel size, from website_get_dispatch_state.",
          },
          itemCount: {
            type: "integer",
            minimum: 1,
            maximum: 12,
            description: "How many items are in the parcel.",
          },
        },
      },
      execute: SiteActions.requestQuote,
    };
  }

  /**
   * Price a run through the page's own operation.
   *
   * :param args: The validated request.
   * :return: A promise of the quote, or a refusal.
   */
  static requestQuote(args) {
    return App.page.requestQuote(args);
  }

  /**
   * Describe the read that looks up one job.
   *
   * :return: The action definition.
   */
  static lookupJobAction() {
    return {
      name: "lookup_job",
      description: "Read one job by its number: its status, zone, parcel, fee, trip minutes, when it was accepted and its event history. Returns no names, phone numbers or addresses. Call it to answer where a job is, and to settle an earlier call whose outcome was unknown: read the job instead of dispatching again. The desk answers ok false when no job has that number.",
      effect: "read",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["jobId"],
        properties: {
          jobId: {
            type: "string",
            maxLength: 60,
            description: "The job number the visitor has, such as J-1234.",
          },
        },
      },
      execute: SiteActions.lookupJob,
    };
  }

  /**
   * Look up a job through the page's own operation.
   *
   * :param args: The validated arguments with jobId.
   * :return: A promise of the job's state, or a refusal.
   */
  static lookupJob(args) {
    return App.page.lookupJob(args.jobId);
  }

  /**
   * Describe the irreversible cancellation.
   *
   * :return: The action definition.
   */
  static cancelJobAction() {
    return {
      name: "cancel_job",
      description: "Cancel a job that has not been picked up. In the turn you call it, first call website_lookup_job and wait for its result: pass the status it gives as expectedStatus, because results from earlier turns are not kept. The desk cancels only while a job is assigned, and refuses a stale expectedStatus. The browser asks the visitor to confirm. Returns the cancelled job, or ok false with the desk's reason.",
      effect: "irreversible",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["jobId", "expectedStatus"],
        properties: {
          jobId: {
            type: "string",
            maxLength: 60,
            description: "The job number from website_lookup_job.",
          },
          expectedStatus: {
            type: "string",
            enum: CourierData.STATUSES,
            description: "The status website_lookup_job returned in this turn.",
          },
        },
      },
      execute: SiteActions.cancelJob,
    };
  }

  /**
   * Cancel a job through the page's own operation.
   *
   * :param args: The validated, visitor-confirmed arguments.
   * :return: A promise of the cancelled job, or a refusal.
   */
  static cancelJob(args) {
    return App.page.cancelJob(args.jobId, args.expectedStatus);
  }
}

// The runtime calls the module's registerActions export.
export const registerActions = SiteActions.registerActions;
