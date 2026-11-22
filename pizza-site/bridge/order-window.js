// The order this site shares with the guesthouse's assistant, through its action bridge.
// bridge-actions.js registers it.
//
// An order is a write, so the runtime runs it in a window on this site that the visitor
// sees. This module shows the pizzas and a details form there, with the site's own
// stylesheet. The visitor types their name and address here, and the calling assistant
// gets back only the order number, the pizzas, the total and when.
import { App } from "../script.js";

/**
 * Shares a demo order of pizzas, in one call, with the checks the page's own checkout uses.
 *
 * The window starts a fresh cart with the pizzas the assistant asked for, so the order
 * lives only in that window. Nothing is paid, sent or cooked. A real site would send it
 * to its own server here.
 */
export class OrderWindow {
  /**
   * The site allowed to order through this window: the guesthouse, as an exact origin.
   */
  static CALLERS = [
    "http://127.0.0.1:8080",
  ];

  /**
   * Layout for this small window, on top of the site's stylesheet.
   */
  static STYLE = `
.order-window header { padding: 12px 18px; }
.order-window main { max-width: 560px; padding-top: 4px; }
.order-window h1 { font-size: 1.8rem; margin: 4px 0 6px; }
.order-window .cart { margin-top: 16px; padding: 16px 18px; }
.order-window .cart-items li { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; }
.order-window .actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 16px; }
.order-window .secondary { background: white; color: #a63220; }
.order-window .field-error { color: #a63220; font-weight: 600; margin: 6px 0 0; }
.order-window .number { font-family: Georgia, serif; font-size: 1.6rem; font-weight: 700; margin: 0 0 8px; }
`;

  /**
   * Describe the shared order.
   *
   * :return: The action definition.
   */
  static definition() {
    return {
      name: "place_order",
      description: "Place a demo order of pizzas for pickup or delivery, in one call. Use the menu ids from get_restaurant_state, and check that the kitchen is open at the time asked for. A window opens on this site, where the visitor checks the order and types their own name and, for delivery, the address, so never ask for them. It returns only once the visitor has ordered or cancelled there: with ok true, the order is placed and the window has closed. Returns the order number, the pizzas, the total, pickup or delivery and when, or ok false with the site's reason, such as the visitor cancelling. No payment is taken.",
      effect: "irreversible",
      availability: "bridge",
      callerOrigins: OrderWindow.CALLERS,
      // The form below shows the order and asks the visitor to order or cancel, so the
      // runtime's generic dialog is not needed.
      confirmsInWindow: true,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["items"],
        properties: {
          items: {
            type: "array",
            minItems: 1,
            maxItems: App.MENU.length,
            description: "One line per pizza.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "quantity"],
              properties: {
                id: {
                  type: "string",
                  enum: OrderWindow.menuIds(),
                  description: "Menu id from get_restaurant_state.",
                },
                quantity: {
                  type: "integer",
                  minimum: 1,
                  maximum: 20,
                  description: "How many of this pizza.",
                },
              },
            },
          },
          fulfillment: {
            type: "string",
            enum: ["pickup", "delivery"],
            description: "Pickup or delivery, if the visitor said. They can change it in the window.",
          },
          orderTime: {
            type: "string",
            maxLength: 5,
            description: "A time today as HH:MM on a 24-hour clock, if the visitor gave one. Leave it out for as soon as possible.",
          },
        },
      },
      execute: OrderWindow.order,
    };
  }

  /**
   * List every menu id.
   *
   * :return: The ids.
   */
  static menuIds() {
    const ids = [];
    for (const item of App.MENU) {
      ids.push(item.id);
    }
    return ids;
  }

  /**
   * Check the pizzas, then ask the visitor for their details in this window.
   *
   * :param args: The validated pizzas, and the pickup or delivery and time, if given.
   * :param context: The bridge's call details, with the calling site's origin.
   * :return: A refusal now, or a promise of the order or the visitor's cancel.
   */
  static order(args, context) {
    const refused = App.checkLines(args.items);
    if (refused !== null) {
      return refused;
    }
    const state = {
      page: OrderWindow.pageWithCart(args.items),
      fulfillment: args.fulfillment || "pickup",
      orderTime: args.orderTime || "",
      caller: OrderWindow.hostOf(context?.callerOrigin),
      done: false,
    };
    return new Promise(OrderWindow.showForm.bind(null, state));
  }

  /**
   * Make a page object with a fresh cart of the given pizzas but no document. checkOrder
   * uses only the cart and its version, so it works on it.
   *
   * :param items: The pizzas, each with id and quantity.
   * :return: The page object.
   */
  static pageWithCart(items) {
    const page = Object.create(App.prototype);
    page.cart = new Map();
    for (const line of items) {
      page.cart.set(line.id, line.quantity);
    }
    page.version = 0;
    return page;
  }

  /**
   * Show the pizzas and the details form, and wait for the visitor.
   *
   * :param state: The cart, the pickup or delivery, the time, the caller and whether the
   *   form is done.
   * :param resolve: Resolves the action with its result.
   */
  static showForm(state, resolve) {
    state.resolve = resolve;
    document.title = "Order from Little Oven Pizza";
    OrderWindow.addStyles();
    document.body.classList.add("order-window");
    const box = OrderWindow.element("main", "");
    box.append(
      OrderWindow.intro(state),
      OrderWindow.orderCard(state),
      OrderWindow.form(state, box),
    );
    document.body.append(OrderWindow.header(), box);
    state.form.elements.customerName.focus();
  }

  /**
   * Add the site's stylesheet and this window's layout to the page head.
   */
  static addStyles() {
    // Resolved from this module, so the bridge page's own location does not matter.
    const sheet = document.createElement("link");
    sheet.rel = "stylesheet";
    sheet.href = new URL("../styles.css", import.meta.url).href;
    document.head.append(sheet, OrderWindow.element("style", OrderWindow.STYLE));
  }

  /**
   * Make the site's header, with its name, so the visitor sees whose window this is.
   *
   * :return: The header element.
   */
  static header() {
    const header = document.createElement("header");
    const brand = OrderWindow.element("span", "Little Oven ", "brand");
    brand.append(OrderWindow.element("span", "Pizza"));
    header.append(brand, OrderWindow.element("small", "Order window"));
    return header;
  }

  /**
   * Say which site asked for this order, and where the visitor's details go.
   *
   * :param state: The order state, with the caller's host.
   * :return: The intro section.
   */
  static intro(state) {
    const intro = OrderWindow.element("section", "");
    intro.append(
      OrderWindow.element("p", "Ordering from another site's chat", "eyebrow"),
      OrderWindow.element("h1", "Your pizza order"),
      OrderWindow.element("p", `The assistant on ${state.caller} asked us to take this order for you. Type your details here, not in the chat. When you order, its chat gets the order number and the pizzas, not your details.`, "demo-note"),
      OrderWindow.element("p", "Developer demo: orders are simulated, with no payment or real fulfillment.", "demo-note"),
    );
    return intro;
  }

  /**
   * Show the pizzas and the total, as the page's cart does.
   *
   * :param state: The order state, with the cart.
   * :return: The order card.
   */
  static orderCard(state) {
    const card = OrderWindow.element("section", "", "cart");
    card.setAttribute("aria-label", "Your pizzas");
    const list = OrderWindow.element("ul", "", "cart-items");
    for (const line of state.page.cartLines()) {
      const item = document.createElement("li");
      item.append(
        OrderWindow.element("span", `${line.quantity} × ${line.name}`),
        OrderWindow.element("span", line.lineTotal),
      );
      list.append(item);
    }
    const total = OrderWindow.element("p", "Total ", "total");
    total.append(OrderWindow.element("strong", App.money(state.page.cartTotal())));
    card.append(OrderWindow.element("h2", "Pizzas"), list, total);
    return card;
  }

  /**
   * Make the details form, with Order and Cancel.
   *
   * :param state: The order state. The form and its error line are stored on it.
   * :param box: The window's content, replaced once the visitor orders or cancels.
   * :return: The form.
   */
  static form(state, box) {
    const form = OrderWindow.element("form", "", "cart");
    form.noValidate = true;
    state.form = form;
    state.error = OrderWindow.element("p", "", "field-error");
    state.error.id = "order-error";
    state.error.setAttribute("role", "alert");
    state.error.hidden = true;
    const name = OrderWindow.input("customerName", "text", "name", 80);
    const fulfillment = document.createElement("select");
    fulfillment.id = "order-fulfillment";
    fulfillment.name = "fulfillment";
    fulfillment.append(OrderWindow.option("pickup", "Pickup"), OrderWindow.option("delivery", "Delivery (free in this demo)"));
    fulfillment.value = state.fulfillment;
    const address = document.createElement("textarea");
    address.id = "order-address";
    address.name = "address";
    address.autocomplete = "street-address";
    address.rows = 3;
    address.maxLength = 300;
    const delivery = document.createElement("div");
    delivery.append(OrderWindow.label("order-address", "Delivery address"), address);
    const time = OrderWindow.input("orderTime", "time", "off", 5);
    time.value = state.orderTime;
    const orderButton = OrderWindow.element("button", "Place demo order");
    orderButton.type = "submit";
    const cancelButton = OrderWindow.element("button", "Cancel", "secondary");
    cancelButton.type = "button";
    const actions = OrderWindow.element("div", "", "actions");
    actions.append(orderButton, cancelButton);
    form.append(
      OrderWindow.label("order-customerName", "Your name"),
      name,
      OrderWindow.label("order-fulfillment", "Pickup or delivery"),
      fulfillment,
      delivery,
      OrderWindow.label("order-orderTime", "When would you like it?"),
      time,
      OrderWindow.element("small", "Leave blank for as soon as possible. Times are for today."),
      state.error,
      actions,
    );
    state.delivery = delivery;
    OrderWindow.showDelivery(state);
    fulfillment.addEventListener("change", OrderWindow.showDelivery.bind(null, state));
    form.addEventListener("submit", OrderWindow.submit.bind(null, state, box));
    cancelButton.addEventListener("click", OrderWindow.cancel.bind(null, state, box));
    return form;
  }

  /**
   * Show the address field only for delivery, as the page's checkout does.
   *
   * :param state: The order state, with the form and the address block.
   */
  static showDelivery(state) {
    state.delivery.hidden = state.form.elements.fulfillment.value !== "delivery";
  }

  /**
   * Make one input with the window's id for it.
   *
   * :param name: The field's name, as checkOrder() takes it.
   * :param type: The input type.
   * :param autocomplete: The autocomplete hint.
   * :param maxLength: The longest value.
   * :return: The input.
   */
  static input(name, type, autocomplete, maxLength) {
    const input = document.createElement("input");
    input.id = `order-${name}`;
    input.name = name;
    input.type = type;
    input.autocomplete = autocomplete;
    input.maxLength = maxLength;
    input.setAttribute("aria-describedby", "order-error");
    return input;
  }

  /**
   * Make a label for one field.
   *
   * :param id: The field's id.
   * :param text: The label text.
   * :return: The label.
   */
  static label(id, text) {
    const label = OrderWindow.element("label", text);
    label.htmlFor = id;
    return label;
  }

  /**
   * Make one option of a select.
   *
   * :param value: The option's value.
   * :param text: The option's text.
   * :return: The option.
   */
  static option(value, text) {
    const option = OrderWindow.element("option", text);
    option.value = value;
    return option;
  }

  /**
   * Check the details with the page's own checkout rules, and order when they pass.
   *
   * :param state: The order state, with the form, the cart and the resolver.
   * :param box: The window's content, replaced once the order is placed.
   * :param event: The submit event.
   */
  static submit(state, box, event) {
    event.preventDefault();
    if (state.done) {
      return;
    }
    const elements = state.form.elements;
    const check = state.page.checkOrder({
      customerName: elements.customerName.value,
      fulfillment: elements.fulfillment.value,
      address: elements.address.value,
      orderTime: elements.orderTime.value,
      expectedVersion: state.page.version,
    });
    if (!check.ok) {
      OrderWindow.showError(state, check);
      return;
    }
    const order = App.orderFrom(check);
    state.done = true;
    box.replaceChildren(OrderWindow.confirmation(state, order));
    state.resolve(OrderWindow.describe(order));
  }

  /**
   * Show the site's reason above the buttons, and focus the field it is about.
   *
   * :param state: The order state, with the form and its error line.
   * :param refusal: The refusal from checkOrder(), with its reason and field.
   */
  static showError(state, refusal) {
    state.error.textContent = refusal.reason;
    state.error.hidden = false;
    for (const element of state.form.elements) {
      if (element.name) {
        element.setAttribute("aria-invalid", element.name === refusal.field ? "true" : "false");
      }
    }
    const field = state.form.elements[refusal.field];
    if (field && typeof field.focus === "function") {
      field.focus();
    }
  }

  /**
   * Show the order in this window, as the page's own confirmation does, with the
   * details the visitor typed so they can check them here.
   *
   * :param state: The order state, with the caller's host.
   * :param order: The new order.
   * :return: The confirmation section.
   */
  static confirmation(state, order) {
    const box = OrderWindow.element("section", "", "confirmation");
    const list = document.createElement("ul");
    for (const line of order.items) {
      list.append(OrderWindow.element("li", `${line.quantity} × ${line.name} — ${line.lineTotal}`));
    }
    box.append(
      OrderWindow.element("h2", "Demo order received!"),
      OrderWindow.element("p", "Your order number is"),
      OrderWindow.element("p", order.orderId, "number"),
      OrderWindow.element("p", `${order.name}: ${order.destination}, ${order.when}.`),
      list,
      OrderWindow.element("p", `Total: ${order.total}`),
      OrderWindow.element("p", `This window closes now. The chat on ${state.caller} shows the order number too.`, "demo-note"),
    );
    return box;
  }

  /**
   * End the action without ordering, after the visitor clicks Cancel.
   *
   * :param state: The resolver, the caller's host and whether the form is done.
   * :param box: The window's content.
   */
  static cancel(state, box) {
    if (state.done) {
      return;
    }
    state.done = true;
    const notice = OrderWindow.element("section", "", "cart");
    notice.append(
      OrderWindow.element("h2", "Cancelled"),
      OrderWindow.element("p", `Nothing was ordered. This window closes now, and the chat on ${state.caller} carries on.`),
    );
    box.replaceChildren(notice);
    state.resolve({
      ok: false,
      reason: "The visitor cancelled in the order window. Nothing was ordered.",
    });
  }

  /**
   * Describe an order for the calling assistant. It leaves out the visitor's name and
   * address: they stay in this site's window.
   *
   * :param order: The new order.
   * :return: The order number, pizzas, total, pickup or delivery and when.
   */
  static describe(order) {
    return {
      ok: true,
      orderId: order.orderId,
      items: order.items,
      total: order.total,
      fulfillment: order.fulfillment,
      when: order.when,
      note: "Placed. The visitor checked the order and typed their details in this site's window, which has now closed. A demo order: nothing is paid, sent or cooked.",
    };
  }

  /**
   * Give the host of the calling site, for the window's text.
   *
   * :param origin: The caller's origin from the bridge, if any.
   * :return: The host, or "another site" when the origin is missing or not a URL.
   */
  static hostOf(origin) {
    try {
      return new URL(origin).host;
    } catch {
      return "another site";
    }
  }

  /**
   * Make an element with text and an optional class.
   *
   * :param tag: The tag name.
   * :param text: The text.
   * :param className: The class, or "" for none.
   * :return: The element.
   */
  static element(tag, text, className = "") {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) {
      element.className = className;
    }
    return element;
  }
}
