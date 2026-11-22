// The actions this site shares with other agent sites, through its action bridge.
// bridge/agent-manifest.json loads this module in the bridge frame, which has no pizza
// page. So it reads the menu and the clock, and fetches the page's HTML for its facts.
// The read has the name the page's own action has (site-actions.js), so the network's
// instructions fit both. The order is in order-window.js.
import { App } from "../script.js";
import { OrderWindow } from "./order-window.js";

/**
 * Shares one read with the partner sites that call this site's network: the menu, today's
 * date and time, and the page's facts, such as opening hours, delivery and the address.
 * It also shares a demo order with the guesthouse.
 *
 * A partner's agent calls them from the partner's page. The read runs here, in a hidden
 * frame on this site's origin. The order runs in a window on this site, where the visitor
 * confirms it. A partner has no cart, so the page's cart actions are left out.
 */
class BridgeActions {
  /**
   * The sites allowed to call this action: the guesthouse and the tour site, as exact
   * origins. This read shows only public facts, so "*" would also be allowed, but it
   * would share it with every site on the web.
   */
  static CALLERS = [
    "http://127.0.0.1:8080",
    "http://localhost:8081",
  ];

  /**
   * The site's page, next to this folder.
   */
  static PAGE = new URL("../index.html", import.meta.url).href;

  /**
   * Register the shared read and the order with the bridge's registry.
   *
   * :param actions: The runtime registry facade with a register(definition) method.
   */
  static registerActions(actions) {
    actions.register(BridgeActions.readStateAction());
    actions.register(OrderWindow.definition());
  }

  /**
   * Describe the shared read of the menu, the clock and the page's facts.
   *
   * :return: The action definition.
   */
  static readStateAction() {
    return {
      name: "get_restaurant_state",
      description: "Read the menu (ids, prices, ingredients, dietary labels, allergens), today's date and time, and the page's facts with links: size, fees, kitchen, delivery, order times, address, phone, opening hours and neighbors. Changes nothing. Call it before answering about any of these.",
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
   * Read the menu and the clock, and the facts from the page's HTML.
   *
   * :return: A promise of today, the menu and the page's facts.
   */
  static async readState() {
    const page = await BridgeActions.readPage(BridgeActions.PAGE);
    return {
      today: App.today(),
      menu: App.menuState(),
      pageFacts: App.factsIn(page),
    };
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
    // A parsed page resolves links against this frame's address. A base element makes
    // them resolve against the page's own address, as they do on the page.
    const base = page.createElement("base");
    base.href = url;
    page.head.prepend(base);
    return page;
  }
}

export const registerActions = BridgeActions.registerActions;
