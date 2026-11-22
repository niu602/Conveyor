// The actions Conveyor Courier shares with other agent sites, through its action bridge.
// The build names this file in bridge/agent-manifest.json. When another site's assistant
// calls this site, the bridge loads it in a hidden frame on this site's origin, which has
// no page. Only the names in the manifest's "actions.agentTools" reach a partner's agents.
//
// It imports the desk's data, rules and intake client. It never imports script.js: that
// module belongs to the page, and this frame has none.
import { CourierData } from "../courier-data.js";
import { DeskClient } from "../desk-client.js";
import { DispatchWindow } from "./dispatch-window.js";

/**
 * Shares the desk's reads, and the dispatch write, with the sites that call this network.
 *
 * A partner's agent calls them from the partner's page. Each read runs here, in a hidden
 * frame on this site's origin. The dispatch runs in a window on this site, where the
 * visitor checks it and types their own details (dispatch-window.js).
 */
class BridgeActions {
  /**
   * The sites allowed to call these reads, as exact origins with the port.
   * Before hosting, put the pizza site's https origin here and in DispatchWindow.CALLERS.
   */
  static CALLERS = [
    "http://127.0.0.1:8084",
  ];

  /**
   * The site's page, for facts that only its HTML holds.
   */
  static PAGE = new URL("../index.html", import.meta.url).href;

  /**
   * Register the shared reads and the dispatch write.
   *
   * :param actions: The runtime registry facade with a register(definition) method.
   */
  static registerActions(actions) {
    actions.register(BridgeActions.readStateAction());
    actions.register(BridgeActions.quoteAction());
    actions.register(BridgeActions.lookupJobAction());
    actions.register(DispatchWindow.definition());
  }

  /**
   * Describe the shared read of the desk's table, rules and page facts.
   *
   * :return: The action definition.
   */
  static readStateAction() {
    return {
      // The page's own action has the same name, so the network's instructions fit both.
      name: "get_dispatch_state",
      description: "Read the delivery zones with their base fees and trip times, the parcel sizes with their item limits and extra fees, the per-item charge, how long a quote lasts, the desk's hours, today's date and time, and the page's facts with links: service area, cancellation rule and phone. Changes nothing and holds no quote. Call it before naming a zone, a parcel size or a fee, and again in each turn that needs them.",
      effect: "read",
      availability: "bridge",
      callerOrigins: BridgeActions.CALLERS,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: BridgeActions.readState,
    };
  }

  /**
   * Read the desk's table and rules, and the facts that only the page's HTML holds.
   *
   * It returns no jobs: those belong to the desk's own visitors.
   *
   * :return: A promise of the table, the rules and the page's facts.
   */
  static async readState() {
    const page = await BridgeActions.readPage(BridgeActions.PAGE);
    const now = new Date();
    const read = (selector) => page.querySelector(selector)?.textContent.trim() || "";
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
      facts: {
        cancellation: read("#cancel-rule"),
        service: read("#service-note"),
        contact: read("#contact-note"),
        phone: page.querySelector("#courier-contact")?.getAttribute("href") || "",
      },
    };
  }

  /**
   * Describe the shared read that prices a run.
   *
   * :return: The action definition.
   */
  static quoteAction() {
    return {
      name: "request_quote",
      description: "Price a delivery and hold the quote for 15 minutes. Takes the drop zone, the parcel size and how many items. Books nothing: it returns the quote id, the fee in cents and as text, the trip minutes and when the quote expires. The desk refuses a zone outside Marrow Point and a parcel too small for the item count, with its own reason. Call it before naming a fee, and again whenever the parcel changes. Pass its quoteId and feeCents to website_confirm_dispatch.",
      effect: "read",
      availability: "bridge",
      callerOrigins: BridgeActions.CALLERS,
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
      execute: BridgeActions.requestQuote,
    };
  }

  /**
   * Price a run on the desk itself, so the quote a dispatch is checked against is the one
   * the desk holds.
   *
   * :param args: The validated request.
   * :return: A promise of the quote, or a refusal.
   */
  static async requestQuote(args) {
    const problem = CourierData.quoteProblem(args);
    if (problem) {
      return problem;
    }
    try {
      return await new DeskClient().quote(args);
    } catch {
      return { ok: false, reason: "The desk's intake could not be reached, so no quote was made. Try again in a moment." };
    }
  }

  /**
   * Describe the shared read of one job.
   *
   * :return: The action definition.
   */
  static lookupJobAction() {
    return {
      name: "lookup_job",
      description: "Read one job by the number a dispatch returned: its status, zone, parcel, fee, trip minutes and event history. Returns no names, phone numbers or addresses. Call it to answer where a job is, and to settle a dispatch whose outcome was unknown: read the job instead of dispatching again. The desk answers ok false when no job has that number.",
      effect: "read",
      availability: "bridge",
      callerOrigins: BridgeActions.CALLERS,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["jobId"],
        properties: {
          jobId: {
            type: "string",
            maxLength: 60,
            description: "The job number website_confirm_dispatch returned.",
          },
        },
      },
      execute: BridgeActions.lookupJob,
    };
  }

  /**
   * Read one job from the desk.
   *
   * :param args: The validated arguments with jobId.
   * :return: A promise of the job's state, or a refusal.
   */
  static async lookupJob(args) {
    try {
      return await new DeskClient().job(String(args.jobId || "").trim());
    } catch {
      return { ok: false, reason: "The desk's intake could not be reached, so the job could not be read." };
    }
  }

  /**
   * Fetch one of the site's pages and parse it, so its facts can be read as on the page.
   *
   * :param url: The page's address.
   * :return: A promise of the parsed document, with links resolved against the page.
   * :raises Error: When there is no DOMParser, or the page cannot be read.
   */
  static async readPage(url) {
    // Check first: Node has fetch but no DOMParser, so a test never sends a real request.
    if (typeof DOMParser === "undefined") {
      throw new Error("Reading the site's page needs a browser.");
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`The site's page answered ${response.status}.`);
    }
    const page = new DOMParser().parseFromString(await response.text(), "text/html");
    const base = page.createElement("base");
    base.href = url;
    page.head.prepend(base);
    return page;
  }
}

// The bridge calls the module's registerActions export.
export const registerActions = BridgeActions.registerActions;
