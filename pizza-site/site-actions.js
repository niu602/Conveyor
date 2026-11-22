// Registers Little Oven Pizza's operations with the agent runtime.
// agent-manifest.json loads this module through "actions.module". Only the names in
// "actions.agentTools" become model tools, called website_<name>.
//
// Each action wraps a method on App.page, the page object script.js exports, so the
// assistant and the page's own buttons share one set of rules. This module imports
// script.js by the same URL index.html loads it from, so both use the same page state.
import { App } from "./script.js";

/**
 * Describes the pizza page's operations as actions the agents can call.
 *
 * The runtime checks arguments against inputSchema before execute runs, and asks the
 * visitor to confirm "irreversible" actions first. Operations refuse bad input by
 * returning {ok: false, reason, field} and change nothing then.
 */
class SiteActions {
  /**
   * Register every site action with the runtime.
   *
   * :param actions: The runtime registry facade with a register(definition) method.
   */
  static registerActions(actions) {
    actions.register(SiteActions.readStateAction());
    actions.register(SiteActions.addToCartAction());
    actions.register(SiteActions.setCartQuantitiesAction());
    actions.register(SiteActions.placeDemoOrderAction());
  }

  /**
   * Describe the read action that returns the page's data and current state.
   *
   * :return: The action definition.
   */
  static readStateAction() {
    return {
      name: "get_restaurant_state",
      description: "Read the menu (ids, prices, ingredients, dietary labels, allergens), the cart with its version, the latest demo order in this tab, today's date and time, and the page's facts with links: size, fees, kitchen, delivery, order times, address, phone, opening hours and neighbors. Call it before answering about any of these, and again in each turn that needs it: the visitor can also use the page.",
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
   * :return: The page state as plain JSON data.
   */
  static readState() {
    return App.page.getState();
  }

  /**
   * Describe the write that adds pizzas to the cart.
   *
   * :return: The action definition.
   */
  static addToCartAction() {
    return {
      name: "add_to_cart",
      description: "Call it only when the visitor asks, with an id from website_get_restaurant_state. Adds a quantity of one pizza to the visible cart, keeping the rest. Returns the cart with its new version, or ok false with a reason. Does not place an order.",
      effect: "write",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["id", "quantity"],
        properties: {
          id: {
            type: "string",
            enum: App.page.catalogIds(),
            description: "Menu id from website_get_restaurant_state.",
          },
          quantity: {
            type: "integer",
            minimum: 1,
            maximum: 99,
            description: "How many to add.",
          },
        },
      },
      execute: SiteActions.addToCart,
    };
  }

  /**
   * Add pizzas through the page's own cart operation.
   *
   * :param args: The validated arguments with id and quantity.
   * :return: The updated cart, or a refusal.
   */
  static addToCart(args) {
    return App.page.addItem(args.id, args.quantity);
  }

  /**
   * Describe the write that sets exact quantities, which also removes pizzas.
   *
   * :return: The action definition.
   */
  static setCartQuantitiesAction() {
    return {
      name: "set_cart_quantities",
      description: "Call it only when the visitor asks to change or remove pizzas. Sets the exact quantity of each listed pizza; 0 removes it, and pizzas not listed stay as they are. Checks every line before changing any. Returns the cart with its new version, or ok false with a reason.",
      effect: "write",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["items"],
        properties: {
          items: {
            type: "array",
            minItems: 1,
            maxItems: App.MENU.length,
            description: "One line per pizza to change.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "quantity"],
              properties: {
                id: {
                  type: "string",
                  enum: App.page.catalogIds(),
                  description: "Menu id from website_get_restaurant_state.",
                },
                quantity: {
                  type: "integer",
                  minimum: 0,
                  maximum: 99,
                  description: "The new quantity; 0 removes the pizza.",
                },
              },
            },
          },
        },
      },
      execute: SiteActions.setCartQuantities,
    };
  }

  /**
   * Set quantities through the page's own cart operation.
   *
   * :param args: The validated arguments with items.
   * :return: The updated cart, or a refusal.
   */
  static setCartQuantities(args) {
    return App.page.setQuantities(args.items);
  }

  /**
   * Describe the irreversible demo order that the visitor must confirm.
   *
   * :return: The action definition.
   */
  static placeDemoOrderAction() {
    return {
      name: "place_demo_order",
      description: "Place the demo order for the whole current cart. First ask for the visitor's name and pickup or delivery, and the address for delivery; ask for a time only if they want one. The site does not check opening hours: check the time, or now for as soon as possible, against today and the opening hours from website_get_restaurant_state, and if the kitchen is closed then, tell the visitor instead. In the turn you call it, first call website_get_restaurant_state and wait for its result: this needs its current version, and results from earlier turns are not kept. The browser asks the visitor to confirm. The site refuses a stale expectedVersion. Returns the order with its number. No payment is taken.",
      effect: "irreversible",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["customerName", "fulfillment", "expectedVersion"],
        properties: {
          customerName: {
            type: "string",
            maxLength: 80,
            description: "The name the visitor gave.",
          },
          fulfillment: {
            type: "string",
            enum: ["pickup", "delivery"],
            description: "Pickup or delivery, as the visitor chose.",
          },
          address: {
            type: "string",
            maxLength: 300,
            description: "The delivery address the visitor gave. Only for delivery.",
          },
          orderTime: {
            type: "string",
            maxLength: 20,
            description: "A time today as HH:MM on a 24-hour clock, such as 18:30. Leave it out for as soon as possible.",
          },
          expectedVersion: {
            type: "integer",
            minimum: 0,
            description: "The latest cart version in this turn: from website_get_restaurant_state, or from a cart change made after that read.",
          },
        },
      },
      execute: SiteActions.placeDemoOrder,
    };
  }

  /**
   * Place the order through the same operation the page's own form uses.
   *
   * :param args: The validated, visitor-confirmed arguments.
   * :return: The order receipt, or {ok: false, reason} when the site refuses the order.
   * :raises Error: Only on an unexpected failure; the runtime then reports "unknown".
   */
  static placeDemoOrder(args) {
    return App.page.placeOrder(args);
  }
}

// The runtime calls the module's registerActions export.
export const registerActions = SiteActions.registerActions;
