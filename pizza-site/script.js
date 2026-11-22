// Little Oven Pizza's page: the menu, the cart, the checkout form and the demo order.
// The page's own buttons and form, and the assistant (site-actions.js and site.js), call
// the same methods on App.page, so both follow one set of rules.

/**
 * Runs the Little Oven Pizza page and keeps its state in page memory.
 *
 * One instance, App.page, exists per page. Its operations check their whole input
 * first, refuse by returning {ok: false, reason, field} and change nothing then. Focus
 * moves and form resets stay in the page's own handlers, so the assistant never moves
 * focus or erases what the visitor typed.
 */
export class App {
  /**
   * The menu. Prices are integer cents. This is the data the assistant reads.
   */
  static MENU = [
    {
      id: "margherita",
      name: "Margherita",
      price: 1200,
      ingredients: "Tomato sauce, mozzarella, fresh basil, olive oil",
      dietary: "Vegetarian",
      allergens: "Wheat, milk",
    },
    {
      id: "pepperoni",
      name: "Pepperoni",
      price: 1400,
      ingredients: "Tomato sauce, mozzarella, pepperoni",
      dietary: "Contains meat",
      allergens: "Wheat, milk",
    },
    {
      id: "garden",
      name: "Garden Veggie",
      price: 1350,
      ingredients: "Gluten-free crust, tomato sauce, mozzarella, mushrooms, bell peppers, red onion",
      dietary: "Vegetarian · Gluten-free",
      allergens: "Milk",
    },
    {
      id: "vegan",
      name: "Roasted Veg",
      price: 1300,
      ingredients: "Tomato sauce, zucchini, bell peppers, mushrooms, olives, olive oil (no cheese)",
      dietary: "Vegan · Made without dairy",
      allergens: "Wheat",
    },
  ];

  /**
   * Facts that only the page's HTML holds, by topic, with the id of the element that
   * holds each one.
   */
  static FACTS = {
    demo: "demo-note",
    sizeAndFees: "menu-note",
    dietaryAndKitchen: "kitchen-note",
    delivery: "delivery-option",
    orderTimes: "order-time-note",
    addressAndPhone: "visit-note",
    openingHours: "opening-hours",
    neighbors: "around-note",
    courier: "courier-note",
  };

  /**
   * An order time today, as the page's time field gives it: HH:MM on a 24-hour clock.
   */
  static TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

  /**
   * The page object that the page, site-actions.js and site.js share. Set once below.
   */
  static page = null;

  /**
   * A fixed clock for tests, as a date-time string such as "2026-11-13T18:30:00", or
   * null for the real clock.
   */
  static fixedNow = null;

  /**
   * Find the page's elements and start with an empty cart.
   */
  constructor() {
    // Cart: menu id -> quantity, in the order the items were first added.
    this.cart = new Map();
    // Goes up on every cart change, so an order never uses a cart the visitor did not see.
    this.version = 0;
    this.latestOrder = null;
    this.form = document.querySelector("#checkout-form");
    this.nameField = document.querySelector("#customer-name");
    this.fulfillment = document.querySelector("#fulfillment");
    this.address = document.querySelector("#address");
    this.timeField = document.querySelector("#order-time");
    this.cartList = document.querySelector("#cart-items");
    this.confirmation = document.querySelector("#confirmation");
  }

  /**
   * Return the current time, or the fixed test clock when one is set.
   *
   * :return: The current date and time.
   */
  static now() {
    return App.fixedNow === null ? new Date() : new Date(App.fixedNow);
  }

  /**
   * Format integer cents as the page shows them, such as "$12.00".
   *
   * :param cents: The amount in cents.
   * :return: The amount in US dollars.
   */
  static money(cents) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(cents / 100);
  }

  /**
   * Find a menu item by id.
   *
   * :param id: The menu id.
   * :return: The menu item, or null when no item has that id.
   */
  static findItem(id) {
    for (const item of App.MENU) {
      if (item.id === id) {
        return item;
      }
    }
    return null;
  }

  /**
   * Build a refusal: nothing changed, and the reason says what to fix.
   *
   * :param reason: The message for the visitor.
   * :param field: The input the message is about.
   * :return: The refusal.
   */
  static refusal(reason, field) {
    return {
      ok: false,
      reason: reason,
      field: field,
    };
  }

  /**
   * Collapse the white space in page text, as a reader sees it.
   *
   * :param text: The text.
   * :return: The text on one line, trimmed.
   */
  static plain(text) {
    return String(text).replace(/\s+/g, " ").trim();
  }

  /**
   * Create an element with optional text and class. textContent keeps visitor input as data.
   *
   * :param tag: The tag name.
   * :param text: The text, or undefined for none.
   * :param className: The class, or undefined for none.
   * :return: The new element.
   */
  static element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) {
      node.textContent = text;
    }
    if (className) {
      node.className = className;
    }
    return node;
  }

  /**
   * Create a button with an accessible label.
   *
   * :param text: The visible text.
   * :param label: The aria-label.
   * :param handler: The click handler.
   * :return: The new button.
   */
  static button(text, label, handler) {
    const node = App.element("button", text);
    node.type = "button";
    node.setAttribute("aria-label", label);
    node.addEventListener("click", handler);
    return node;
  }

  /**
   * Connect the form and render the menu and the empty cart.
   */
  start() {
    this.form.addEventListener("input", this.clearMessage.bind(this));
    this.fulfillment.addEventListener("change", this.updateFulfillment.bind(this));
    this.form.addEventListener("submit", this.onSubmit.bind(this));
    this.renderMenu();
    this.renderCart();
    this.updateFulfillment();
  }

  /**
   * List the menu ids, for the assistant's action schemas.
   *
   * :return: The ids in menu order.
   */
  catalogIds() {
    const ids = [];
    for (const item of App.MENU) {
      ids.push(item.id);
    }
    return ids;
  }

  /**
   * Render one article per menu item, each with its own Add to cart button.
   */
  renderMenu() {
    const list = document.querySelector("#menu-items");
    for (const item of App.MENU) {
      const article = App.element("article", undefined, "menu-item");
      const heading = App.element("div", undefined, "item-heading");
      heading.append(App.element("h3", item.name), App.element("strong", App.money(item.price)));
      const actions = App.element("div", undefined, "item-actions");
      actions.append(App.element("span", item.dietary, "dietary"),
        App.button("Add to cart", `Add ${item.name} to cart`, this.stepFromButton.bind(this, item.id, 1)));
      article.append(heading, App.element("p", item.ingredients),
        App.element("p", `Allergens: ${item.allergens}.`, "demo-note"), actions);
      list.append(article);
    }
  }

  /**
   * Add up the cart.
   *
   * :return: The total in cents.
   */
  cartTotal() {
    let total = 0;
    for (const [id, quantity] of this.cart) {
      total += App.findItem(id).price * quantity;
    }
    return total;
  }

  /**
   * Read the page's data and state for the assistant: today's date and time, the menu,
   * the page-only facts, the cart with its version and the latest demo order in this tab.
   *
   * :return: The state as plain JSON, with copies rather than live objects.
   */
  getState() {
    return {
      today: App.today(),
      menu: App.menuState(),
      pageFacts: this.pageFacts(),
      cart: this.cartState(),
      latestOrder: this.latestOrder === null ? null : JSON.parse(JSON.stringify(this.latestOrder)),
    };
  }

  /**
   * Describe today, worked out from the clock each time, since the page may stay open
   * past midnight.
   *
   * :return: The date as YYYY-MM-DD, the same day with its weekday, and the time as HH:MM.
   */
  static today() {
    const now = App.now();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    return {
      date: `${now.getFullYear()}-${month}-${day}`,
      day: new Intl.DateTimeFormat("en-US", {
        weekday: "long",
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(now),
      time: `${hours}:${minutes}`,
    };
  }

  /**
   * Describe the menu with prices as the page shows them.
   *
   * :return: One entry per menu item.
   */
  static menuState() {
    const menu = [];
    for (const item of App.MENU) {
      menu.push({
        id: item.id,
        name: item.name,
        price: App.money(item.price),
        ingredients: item.ingredients,
        dietary: item.dietary,
        allergens: item.allergens,
      });
    }
    return menu;
  }

  /**
   * Read the facts that only the page's HTML holds, with each link's address.
   *
   * :return: The facts by topic, each with its text and links.
   */
  pageFacts() {
    return App.factsIn(document);
  }

  /**
   * Read the page's facts from a document of the page: the page itself, or the copy the
   * action bridge fetches (bridge/bridge-actions.js).
   *
   * :param doc: The page's document.
   * :return: The facts by topic, each with its text and links.
   */
  static factsIn(doc) {
    const facts = {};
    for (const [topic, id] of Object.entries(App.FACTS)) {
      facts[topic] = App.fact(doc.querySelector(`#${id}`));
    }
    return facts;
  }

  /**
   * Read one page element's text and the address of each link in it.
   *
   * :param element: The element.
   * :return: The text and the links.
   */
  static fact(element) {
    const links = [];
    // textContent leaves out a link's address, so read each href too.
    for (const link of element.querySelectorAll("a")) {
      links.push({
        text: App.plain(link.textContent),
        href: link.href,
      });
    }
    return {
      text: App.plain(element.textContent),
      links: links,
    };
  }

  /**
   * Describe the cart: its version, each line and the total, as the page shows them.
   *
   * :return: The cart as plain JSON.
   */
  cartState() {
    return {
      version: this.version,
      items: this.cartLines(),
      total: App.money(this.cartTotal()),
    };
  }

  /**
   * List the cart's lines in the order the items were first added.
   *
   * :return: One entry per line, with id, name, quantity and line total.
   */
  cartLines() {
    const lines = [];
    for (const [id, quantity] of this.cart) {
      const item = App.findItem(id);
      lines.push({
        id: id,
        name: item.name,
        quantity: quantity,
        lineTotal: App.money(item.price * quantity),
      });
    }
    return lines;
  }

  /**
   * Check cart lines without changing anything.
   *
   * :param lines: A list of {id, quantity}.
   * :return: A refusal, or null when every line is valid.
   */
  static checkLines(lines) {
    if (!Array.isArray(lines) || lines.length === 0) {
      return App.refusal("Name at least one pizza.", "items");
    }
    const seen = new Set();
    for (const line of lines) {
      if (App.findItem(line.id) === null) {
        return App.refusal(`The menu has no pizza with the id "${line.id}".`, "id");
      }
      if (seen.has(line.id)) {
        return App.refusal("List each pizza only once.", "id");
      }
      seen.add(line.id);
      if (!Number.isInteger(line.quantity) || line.quantity < 0) {
        return App.refusal("Give each quantity as a whole number, 0 or more.", "quantity");
      }
    }
    return null;
  }

  /**
   * Set the exact quantity of each listed pizza. 0 removes it, and pizzas not listed
   * stay as they are. Every line is checked before any changes.
   *
   * :param lines: A list of {id, quantity}.
   * :return: {ok: true, cart} with the new version, or a refusal.
   */
  setQuantities(lines) {
    const refused = App.checkLines(lines);
    if (refused !== null) {
      return refused;
    }
    const messages = [];
    for (const line of lines) {
      if (line.quantity) {
        this.cart.set(line.id, line.quantity);
      } else {
        this.cart.delete(line.id);
      }
      messages.push(`${App.findItem(line.id).name}: ${line.quantity} in cart.`);
    }
    this.version += 1;
    this.renderCart();
    document.querySelector("#cart-status").textContent =
      `${messages.join(" ")} Total ${App.money(this.cartTotal())}.`;
    return {
      ok: true,
      cart: this.cartState(),
    };
  }

  /**
   * Add a quantity of one pizza to the cart, keeping the rest.
   *
   * :param id: The menu id.
   * :param quantity: How many to add, 1 or more.
   * :return: {ok: true, cart} with the new version, or a refusal.
   */
  addItem(id, quantity) {
    if (App.findItem(id) === null) {
      return App.refusal(`The menu has no pizza with the id "${id}".`, "id");
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      return App.refusal("Add at least one pizza, as a whole number.", "quantity");
    }
    return this.setQuantities([
      {
        id: id,
        quantity: (this.cart.get(id) || 0) + quantity,
      },
    ]);
  }

  /**
   * Change one pizza's quantity by a step, never below 0. The page's buttons use this.
   *
   * :param id: The menu id.
   * :param change: The step, such as 1 or -1.
   * :return: {ok: true, cart}, or a refusal.
   */
  changeQuantity(id, change) {
    return this.setQuantities([
      {
        id: id,
        quantity: Math.max(0, (this.cart.get(id) || 0) + change),
      },
    ]);
  }

  /**
   * Handle a menu or cart button that steps a quantity, keeping keyboard focus in the cart.
   *
   * :param id: The menu id.
   * :param change: The step, such as 1 or -1.
   */
  stepFromButton(id, change) {
    const label = this.focusedCartLabel();
    this.changeQuantity(id, change);
    this.restoreCartFocus(label);
  }

  /**
   * Handle a cart line's Remove button, keeping keyboard focus in the cart.
   *
   * :param id: The menu id.
   */
  removeFromButton(id) {
    const label = this.focusedCartLabel();
    this.setQuantities([
      {
        id: id,
        quantity: 0,
      },
    ]);
    this.restoreCartFocus(label);
  }

  /**
   * Read the label of the cart button that has focus, before the cart is rebuilt.
   *
   * :return: The button's aria-label, or null when focus is not in the cart.
   */
  focusedCartLabel() {
    const active = document.activeElement;
    if (active && this.cartList.contains(active)) {
      return active.getAttribute("aria-label");
    }
    return null;
  }

  /**
   * Put focus back on the rebuilt button with the same label, or on the name field when
   * that line is gone.
   *
   * :param label: The label from focusedCartLabel(), or null to do nothing.
   */
  restoreCartFocus(label) {
    if (!label) {
      return;
    }
    let next = null;
    for (const node of this.cartList.querySelectorAll("button")) {
      if (next === null && node.getAttribute("aria-label") === label) {
        next = node;
      }
    }
    (next || this.nameField).focus();
  }

  /**
   * Rebuild the cart list, its total and the order button. It moves no focus.
   */
  renderCart() {
    this.cartList.replaceChildren();
    for (const [id, quantity] of this.cart) {
      const item = App.findItem(id);
      const row = App.element("li");
      const line = App.element("div", undefined, "cart-line");
      line.append(App.element("strong", item.name), App.element("span", App.money(item.price * quantity)));
      const controls = App.element("div", undefined, "quantity-controls");
      const remove = App.button("Remove", `Remove ${item.name}`, this.removeFromButton.bind(this, id));
      remove.className = "remove";
      controls.append(App.button("−", `Decrease ${item.name} quantity`, this.stepFromButton.bind(this, id, -1)),
        App.element("span", String(quantity)),
        App.button("+", `Increase ${item.name} quantity`, this.stepFromButton.bind(this, id, 1)), remove);
      row.append(line, controls);
      this.cartList.append(row);
    }
    document.querySelector("#empty-cart").hidden = this.cart.size > 0;
    document.querySelector("#cart-total").textContent = App.money(this.cartTotal());
    document.querySelector("#place-order").disabled = this.cart.size === 0;
  }

  /**
   * Show the address field only for delivery, and require it then.
   */
  updateFulfillment() {
    const delivery = this.fulfillment.value === "delivery";
    document.querySelector("#delivery-fields").hidden = !delivery;
    this.address.disabled = !delivery;
    this.address.required = delivery;
  }

  /**
   * Check a demo order against the current cart without placing it. The confirmation
   * dialog calls this too, so it shows exactly what would be ordered.
   *
   * :param details: customerName, fulfillment ("pickup" or "delivery"), address,
   *   orderTime (HH:MM or empty for as soon as possible) and expectedVersion.
   * :return: A refusal, or {ok: true} with the name, destination, time, items and total.
   */
  checkOrder(details) {
    if (!this.cart.size) {
      return App.refusal("Your cart is empty. Add a pizza to get started.", "cart");
    }
    if (details.expectedVersion !== this.version) {
      return App.refusal("The cart has changed since it was read. Read it again and check it with the visitor before ordering.", "expectedVersion");
    }
    const name = String(details.customerName || "").trim();
    if (!name) {
      return App.refusal("Please enter your name.", "customerName");
    }
    if (details.fulfillment !== "pickup" && details.fulfillment !== "delivery") {
      return App.refusal("Please choose pickup or delivery.", "fulfillment");
    }
    const delivery = details.fulfillment === "delivery";
    // The page's address field is disabled for pickup, so an address is used only for delivery.
    const address = delivery ? String(details.address || "").trim() : "";
    if (delivery && !address) {
      return App.refusal("Please enter a delivery address.", "address");
    }
    const time = String(details.orderTime || "").trim();
    // The page's time field always gives HH:MM; the assistant's text may not.
    if (time && !App.TIME.test(time)) {
      return App.refusal("Please give the time as HH:MM on a 24-hour clock, such as 18:30.", "orderTime");
    }
    return {
      ok: true,
      name: name,
      fulfillment: details.fulfillment,
      address: address,
      destination: delivery ? `Delivery to ${address}` : "Pickup at Little Oven Pizza",
      when: time || "as soon as possible",
      items: this.cartLines(),
      total: App.money(this.cartTotal()),
    };
  }

  /**
   * Make the order from a check that passed, with a new order number. The page and the
   * bridge's order window both use it.
   *
   * :param check: The result of checkOrder() when it passed.
   * :return: The order: its number, name, pickup or delivery, address, time, items and total.
   */
  static orderFrom(check) {
    return {
      orderId: `DEMO-${App.now().getTime()}`,
      name: check.name,
      fulfillment: check.fulfillment,
      address: check.address,
      destination: check.destination,
      when: check.when,
      items: check.items,
      total: check.total,
    };
  }

  /**
   * Place the demo order for the whole cart, show its confirmation and empty the cart.
   * Nothing is paid, sent or cooked. It leaves the page's form and focus alone.
   *
   * :param details: The same details as checkOrder().
   * :return: {ok: true, order, cart}, or a refusal from checkOrder().
   */
  placeOrder(details) {
    const check = this.checkOrder(details);
    if (!check.ok) {
      return check;
    }
    const order = App.orderFrom(check);
    document.querySelector("#order-summary").textContent =
      `${order.name}, your order ${order.orderId} is received. ${order.destination}, ${order.when}.`;
    const rows = [];
    for (const line of order.items) {
      rows.push(App.element("li", `${line.quantity} × ${line.name} — ${line.lineTotal}`));
    }
    document.querySelector("#order-items").replaceChildren(...rows);
    document.querySelector("#order-total").textContent = `Total: ${order.total}`;
    this.latestOrder = order;
    this.cart.clear();
    this.version += 1;
    this.renderCart();
    // An old refusal on the page's form must not sit next to the new confirmation.
    this.nameField.setCustomValidity("");
    this.address.setCustomValidity("");
    this.timeField.setCustomValidity("");
    this.confirmation.hidden = false;
    return {
      ok: true,
      order: JSON.parse(JSON.stringify(order)),
      cart: this.cartState(),
    };
  }

  /**
   * Find the form field a refusal is about.
   *
   * :param field: The refusal's field name.
   * :return: The form field, or null when the refusal is not about one.
   */
  formField(field) {
    if (field === "customerName") {
      return this.nameField;
    }
    if (field === "address") {
      return this.address;
    }
    if (field === "orderTime") {
      return this.timeField;
    }
    return null;
  }

  /**
   * Handle the checkout form: place the order with the cart the visitor sees, or show
   * the site's message on the field it is about. Then reset the form and focus the
   * confirmation.
   *
   * :param event: The submit event.
   */
  onSubmit(event) {
    event.preventDefault();
    if (!this.cart.size) {
      return;
    }
    const result = this.placeOrder({
      customerName: this.nameField.value,
      fulfillment: this.fulfillment.value,
      address: this.address.value,
      orderTime: this.timeField.value,
      expectedVersion: this.version,
    });
    if (!result.ok) {
      const field = this.formField(result.field);
      if (field !== null) {
        field.setCustomValidity(result.reason);
        this.form.reportValidity();
      } else {
        // The form cannot cause these, but say why nothing happened anyway.
        document.querySelector("#cart-status").textContent = result.reason;
      }
      return;
    }
    this.form.reset();
    this.updateFulfillment();
    this.confirmation.focus();
  }

  /**
   * Clear a field's message as soon as the visitor edits it.
   *
   * :param event: The input event.
   */
  clearMessage(event) {
    event.target.setCustomValidity("");
  }
}

// Start only on the site's page. The action bridge (bridge/bridge-actions.js) imports this
// file for the menu and its helpers, in a frame that has none of the page's elements.
if (typeof document !== "undefined" && document.querySelector("#menu-items")) {
  App.page = new App();
  App.page.start();
}
