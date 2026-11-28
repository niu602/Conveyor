// The dispatch this site shares with other agent sites: a partner's visitor accepts a
// parcel run here, in a window on Conveyor Courier, not in the partner's chat.
//
// The calling assistant sends only what it knows: the quote, the fee it quoted and the
// parcel. The visitor types their name, phone and address in this window, and they go
// straight to the desk's intake. The chat gets back a job number and a fee, never those
// details.
import { CourierData } from "../courier-data.js";
import { DeskClient } from "../desk-client.js";

/**
 * Shares one dispatch, made in one call, with the rules the desk's own intake uses.
 *
 * The window holds no store of its own: it reads the quote from the desk and sends the
 * accepted job there, so the job is on the desk and not only in this window.
 */
export class DispatchWindow {
  /**
   * The sites allowed to make this write, as exact origins with the port. Never "*".
   * Before hosting, put the pizza site's https origin here.
   */
  static CALLERS = [
    "http://127.0.0.1:8084",
  ];

  /**
   * The visitor's own details, which no agent ever sees. These are the fields the desk's
   * own intake checks.
   */
  static FIELDS = [
    { name: "customerName", label: "Who receives the parcel", type: "text", autocomplete: "name", maxLength: 80 },
    { name: "phone", label: "Phone the courier can call", type: "tel", autocomplete: "tel", maxLength: 30 },
    { name: "address", label: "Street address in the delivery zone", type: "text", autocomplete: "street-address", maxLength: 300 },
    { name: "note", label: "Note for the courier (optional)", type: "text", autocomplete: "off", maxLength: 200, required: false },
  ];

  /**
   * The site's name, for the window's header and title.
   */
  static SITE_NAME = "Conveyor Courier";

  /**
   * The confirm button's label, which says what it does.
   */
  static CONFIRM_LABEL = "Send this parcel";

  /**
   * Describe the shared write.
   *
   * :return: The action definition.
   */
  static definition() {
    return {
      name: "confirm_dispatch",
      description: "Accept a parcel run for the visitor, in one call. Call website_request_quote first in this turn and pass its quoteId and feeCents, with the same zone, parcel size and item count. A window opens on the courier's own site, where the visitor checks the fee and types their name, phone and address, so never ask for those and never send them. It returns only once the visitor has confirmed or cancelled there: with ok true the run is on the desk. Returns the job number, status, fee and trip minutes, or ok false with the desk's reason, such as an expired quote, a changed fee or the visitor cancelling. Never call it twice for one order and quote: if the outcome is unknown, read the job with website_lookup_job. When the desk's answer is lost the window keeps checking by the same idempotency key for up to 45 seconds and returns settledBy \"read\": ok true means the run was already on the desk, ok false without unknown means the desk confirmed nothing was recorded, and unknown true means it still could not be settled. The same key sent with a different amount is refused with code idempotency_conflict.",
      effect: "irreversible",
      availability: "bridge",
      callerOrigins: DispatchWindow.CALLERS,
      // The form below shows the run and asks the visitor to confirm or cancel.
      confirmsInWindow: true,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["quoteId", "expectedFeeCents", "dropZone", "parcelSize", "itemCount"],
        properties: {
          quoteId: {
            type: "string",
            maxLength: 80,
            description: "The quoteId website_request_quote returned in this turn.",
          },
          expectedFeeCents: {
            type: "integer",
            minimum: 0,
            maximum: 100000,
            description: "The feeCents website_request_quote returned, so a changed fee is refused.",
          },
          dropZone: {
            type: "string",
            enum: CourierData.zoneIds(),
            description: "The zone quoted.",
          },
          parcelSize: {
            type: "string",
            enum: CourierData.sizeIds(),
            description: "The parcel size quoted.",
          },
          itemCount: {
            type: "integer",
            minimum: 1,
            maximum: 12,
            description: "How many items are in the parcel.",
          },
          itemSummary: {
            type: "string",
            maxLength: 200,
            description: "A short list of what is in the parcel, such as \"2x Margherita\". No names, phone numbers or addresses.",
          },
          pizzaOrderRef: {
            type: "string",
            maxLength: 60,
            description: "Your own site's order number for this parcel, if you have one. Not a person's name or phone.",
          },
        },
      },
      execute: DispatchWindow.start,
    };
  }

  /**
   * The key that makes one order's run on one quote land as one job.
   *
   * Derived only from what both sites already know — the partner's own order number and
   * the quote id — so the calling site can work the key out again without having stored
   * it, and a retry after a lost answer names the same transaction. The amount is not in
   * the key: the desk holds what the transaction was and compares it on a replay.
   *
   * With no order number the quote alone names the run, which is the case for a parcel
   * that did not come from the pizza partner.
   *
   * :param quoteId: The quote's id.
   * :param pizzaOrderRef: The calling site's own order number, when it has one.
   * :return: The idempotency key.
   */
  static keyFor(quoteId, pizzaOrderRef) {
    const ref = String(pizzaOrderRef || "").trim();
    return ref ? `dispatch:${ref}:${quoteId}` : `dispatch:${quoteId}`;
  }

  /**
   * How long to wait before each read while an outcome is being confirmed, in order.
   *
   * With the first read made at once, these land at 5s, 15s, 30s and 45s: five reads over
   * 45 seconds, then the window stops and says it could not settle. The budget is kept
   * well under the runtime's 90-second limit for the whole partner call.
   */
  static POLL_DELAYS = [5000, 10000, 15000, 15000];

  /**
   * How many reads in a row must say "nothing recorded" before the window believes it.
   *
   * One read made straight after a lost answer can still race a write that is landing.
   * Two in a row, seconds apart, is what the window tells the visitor it checked.
   */
  static ABSENT_READS = 2;

  /**
   * Check the request with the desk's own rules, then ask the visitor in this window.
   *
   * :param args: The validated request.
   * :param context: The bridge's call details, with the calling site's origin.
   * :return: A promise of the result, the desk's refusal or the visitor's cancel.
   */
  static async start(args, context) {
    const problem = CourierData.quoteProblem(args);
    if (problem) {
      return problem;
    }
    const desk = new DeskClient();
    let check;
    try {
      check = await desk.checkDispatch(args);
    } catch {
      return { ok: false, reason: "The desk's intake could not be reached, so nothing was accepted. Ask for a new quote in a moment." };
    }
    if (!check.ok) {
      return check;
    }
    const state = {
      desk: desk,
      request: args,
      quote: check,
      caller: DispatchWindow.hostOf(context?.callerOrigin),
      done: false,
    };
    return await new Promise(DispatchWindow.showForm.bind(null, state));
  }

  /**
   * Show what will happen and the details form, and wait for the visitor.
   *
   * :param state: The desk, the request, the quote, the caller and whether it is done.
   * :param resolve: Resolves the action with its result.
   */
  static showForm(state, resolve) {
    state.resolve = resolve;
    document.title = DispatchWindow.SITE_NAME;
    DispatchWindow.addStyles();
    const box = DispatchWindow.element("main", "");
    box.append(
      DispatchWindow.intro(state),
      DispatchWindow.summaryCard(state),
      DispatchWindow.form(state, box),
    );
    document.body.append(DispatchWindow.header(), box);
    state.form.elements[DispatchWindow.FIELDS[0].name].focus();
  }

  /**
   * Add the site's stylesheet to the page head.
   */
  static addStyles() {
    const sheet = document.createElement("link");
    sheet.rel = "stylesheet";
    sheet.href = new URL("../styles.css", import.meta.url).href;
    document.head.append(sheet);
  }

  /**
   * Make the site's header, so the visitor sees whose window this is.
   *
   * :return: The header element.
   */
  static header() {
    const header = document.createElement("header");
    header.append(DispatchWindow.element("span", DispatchWindow.SITE_NAME, "brand"));
    return header;
  }

  /**
   * Say which site asked for this, and where the visitor's details go.
   *
   * :param state: The window's state, with the caller's host.
   * :return: The intro section.
   */
  static intro(state) {
    const intro = DispatchWindow.element("section", "", "intro");
    intro.append(
      DispatchWindow.element("h1", "Send this parcel"),
      DispatchWindow.element("p", `The assistant on ${state.caller} asked us to run this delivery for you. Type your details here, not in the chat. When you confirm, its chat gets the job number and the fee, not your details.`),
      DispatchWindow.element("p", "Developer demo — the job is recorded on a test desk. No parcel is really collected and no payment is taken.", "demo-note"),
    );
    return intro;
  }

  /**
   * Show what will happen and what it costs, from the desk's own quote.
   *
   * :param state: The window's state, with the quote and the request.
   * :return: The summary section.
   */
  static summaryCard(state) {
    const card = DispatchWindow.element("section", "", "panel");
    card.setAttribute("aria-label", "What you are confirming");
    const zone = CourierData.zone(state.quote.dropZone);
    const size = CourierData.size(state.quote.parcelSize);
    const lines = [
      `Delivery zone: ${zone ? zone.name : state.quote.dropZone}`,
      `Parcel: ${size ? size.name : state.quote.parcelSize}, ${state.quote.itemCount} item(s)`,
      `Fee: ${state.quote.feeText}`,
      `Trip time: about ${state.quote.etaMinutes} minutes after pickup`,
      `Quote held until: ${state.quote.expiresAt}`,
    ];
    if (state.request.itemSummary) {
      lines.push(`In the parcel: ${state.request.itemSummary}`);
    }
    if (state.request.pizzaOrderRef) {
      lines.push(`Their order number: ${state.request.pizzaOrderRef}`);
    }
    for (const line of lines) {
      card.append(DispatchWindow.element("p", line));
    }
    card.append(DispatchWindow.element("p", "You can cancel this job on our desk page while it is still assigned, before the courier picks the parcel up."));
    return card;
  }

  /**
   * Make the details form, with the confirm button and Cancel.
   *
   * :param state: The window's state. The form and its error lines are stored on it.
   * :param box: The window's content, replaced once the visitor confirms or cancels.
   * :return: The form.
   */
  static form(state, box) {
    const form = DispatchWindow.element("form", "", "panel");
    form.noValidate = true;
    state.form = form;
    state.messages = {};
    state.messages.request = DispatchWindow.message("request");
    state.messages.request.setAttribute("role", "alert");
    const fieldset = document.createElement("fieldset");
    fieldset.append(DispatchWindow.element("legend", "Your details"));
    for (const field of DispatchWindow.FIELDS) {
      fieldset.append(DispatchWindow.field(state, field));
    }
    const confirmButton = DispatchWindow.element("button", DispatchWindow.CONFIRM_LABEL);
    confirmButton.type = "submit";
    state.confirmButton = confirmButton;
    const cancelButton = DispatchWindow.element("button", "Keep it with them", "assistant-decline");
    cancelButton.type = "button";
    const actions = DispatchWindow.element("div", "", "actions");
    actions.append(confirmButton, cancelButton);
    form.append(state.messages.request, fieldset, actions);
    form.addEventListener("submit", DispatchWindow.submit.bind(null, state, box));
    cancelButton.addEventListener("click", DispatchWindow.cancel.bind(null, state, box));
    return form;
  }

  /**
   * Make one labelled input with its error line.
   *
   * :param state: The window's state. The field's error line is stored on it.
   * :param field: The field from FIELDS.
   * :return: The field's wrapper.
   */
  static field(state, field) {
    const id = `write-${field.name}`;
    const wrap = DispatchWindow.element("div", "", "field");
    const label = DispatchWindow.element("label", field.label);
    label.htmlFor = id;
    const input = document.createElement("input");
    input.id = id;
    input.name = field.name;
    input.type = field.type;
    input.autocomplete = field.autocomplete;
    input.maxLength = field.maxLength;
    input.required = field.required !== false;
    state.messages[field.name] = DispatchWindow.message(field.name);
    input.setAttribute("aria-describedby", state.messages[field.name].id);
    wrap.append(label, input, state.messages[field.name]);
    return wrap;
  }

  /**
   * Check the details with the desk's own rules, and send the job when they pass.
   *
   * :param state: The window's state, with the form, the desk and the resolver.
   * :param box: The window's content, replaced once the job is accepted.
   * :param event: The submit event.
   */
  static async submit(state, box, event) {
    event.preventDefault();
    if (state.done) {
      return;
    }
    const details = {};
    for (const field of DispatchWindow.FIELDS) {
      details[field.name] = state.form.elements[field.name].value;
    }
    // The same check the desk's intake runs, so the visitor gets the desk's own words.
    const errors = CourierData.detailErrors(details);
    DispatchWindow.showErrors(state, errors);
    if (Object.keys(errors).length > 0) {
      return;
    }
    state.done = true;
    DispatchWindow.showErrors(state, {});
    state.confirmButton.disabled = true;
    const key = DispatchWindow.keyFor(state.quote.quoteId, state.request.pizzaOrderRef);
    state.key = key;
    let done;
    try {
      done = await state.desk.dispatch({ ...state.request, idempotencyKey: key }, details);
    } catch {
      // The call may or may not have landed. Never send it again: read the outcome by the
      // same idempotency key, which names at most one job, and settle on what that says.
      await DispatchWindow.confirm(state, box, details, key);
      return;
    }
    if (!done.ok) {
      if (done.code === "idempotency_conflict") {
        // The reference already names a different run. Sending again would ask the same
        // wrong question, so this ends here and says which job the reference belongs to.
        DispatchWindow.finishConflict(state, box, done);
        return;
      }
      // A problem with one of the visitor's own fields goes under that field; anything
      // about the quote or the run goes at the top of the form.
      const own = DispatchWindow.FIELDS.some((field) => field.name === done.field);
      DispatchWindow.reopen(state, { [own ? done.field : "request"]: done.reason });
      return;
    }
    box.replaceChildren(DispatchWindow.confirmation(state, done, details));
    state.resolve(DispatchWindow.result(done));
  }

  /**
   * Settle a lost answer while the visitor watches, then show what was settled.
   *
   * The window says it is confirming, reads the desk by the same key on a widening
   * schedule, and only then decides. The submit button stays out of reach the whole time:
   * a second send is not offered while the outcome is still open.
   *
   * :param state: The window's state, with the desk and the resolver.
   * :param box: The window's content.
   * :param details: What the visitor typed.
   * :param key: The idempotency key the dispatch was sent with.
   * :return: A promise of nothing.
   */
  static async confirm(state, box, details, key) {
    const notice = DispatchWindow.element("section", "", "panel");
    const heading = DispatchWindow.element("h2", "Confirming with the desk");
    const line = DispatchWindow.element("p", "Your answer was lost on the way back. We are checking whether the run was recorded, using the same reference. Nothing is being sent again.");
    const progress = DispatchWindow.element("p", "", "demo-note");
    notice.append(heading, line, progress);
    box.replaceChildren(notice);
    const wait = state.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const settled = await DispatchWindow.confirmOutcome(state.desk, key, wait, (attempt, total) => {
      progress.textContent = `Check ${attempt} of ${total}. Please keep this window open.`;
    });
    DispatchWindow.finishUnknown(state, box, details, settled);
  }

  /**
   * Read the desk until the outcome is settled or the checking budget runs out.
   *
   * Three endings, and they are kept apart: the job is on the desk, the desk has said
   * twice that nothing is recorded, or the budget ran out without a settled answer.
   *
   * :param desk: The desk client.
   * :param key: The idempotency key.
   * :param wait: A function returning a promise that resolves after the given milliseconds.
   * :param onTick: Called after each unsettled read, with the attempt number and the total.
   * :return: A promise of {outcome: "recorded"|"absent"|"unknown", job?}.
   */
  static async confirmOutcome(desk, key, wait, onTick) {
    const total = DispatchWindow.POLL_DELAYS.length + 1;
    let absent = 0;
    for (let attempt = 1; attempt <= total; attempt += 1) {
      if (attempt > 1) {
        await wait(DispatchWindow.POLL_DELAYS[attempt - 2]);
      }
      const settled = await DispatchWindow.settle(desk, key);
      if (settled.outcome === "recorded") {
        return settled;
      }
      absent = settled.outcome === "absent" ? absent + 1 : 0;
      if (absent >= DispatchWindow.ABSENT_READS) {
        return settled;
      }
      onTick?.(attempt, total);
    }
    return { outcome: "unknown" };
  }

  /**
   * Settle an unknown dispatch by reading only. The write is never repeated.
   *
   * Three outcomes, and the caller must keep them apart: the job is on the desk, nothing
   * was recorded under that key, or the desk could not be read either and the outcome
   * stays unknown.
   *
   * :param desk: The desk client.
   * :param key: The idempotency key the dispatch was sent with.
   * :return: A promise of {outcome: "recorded"|"absent"|"unknown", job?}.
   */
  static async settle(desk, key) {
    let answer;
    try {
      answer = await desk.outcome(key);
    } catch {
      return { outcome: "unknown" };
    }
    // A refusal here is not an answer about the job: it means the read did not settle it.
    if (!answer || answer.ok !== true) {
      return { outcome: "unknown" };
    }
    // "recorded" must be an explicit boolean. A body that leaves it out has not said
    // whether the job landed, and guessing "absent" would invite a second send.
    if (typeof answer.recorded !== "boolean") {
      return { outcome: "unknown" };
    }
    if (answer.recorded === false) {
      return { outcome: "absent" };
    }
    return { outcome: "recorded", job: answer };
  }

  /**
   * Show and return what the reads settled, without ever sending the dispatch again.
   *
   * A recorded job is shown as the receipt. A confirmed absence is the one case where the
   * visitor may send again, on the same reference and only while the quote still holds.
   * An outcome the reads could not settle closes the window and points at the desk page:
   * the submit button is never offered while the outcome is still open.
   *
   * :param state: The window's state, with the caller's host and the resolver.
   * :param box: The window's content, replaced with the outcome.
   * :param details: What the visitor typed, shown only here.
   * :param settled: What the reads settled.
   */
  static finishUnknown(state, box, details, settled) {
    if (settled.outcome === "recorded") {
      const done = { ...settled.job, replayed: true };
      box.replaceChildren(DispatchWindow.confirmation(state, done, details));
      state.resolve({
        ...DispatchWindow.result(done),
        settledBy: "read",
        note: "The first send's answer was lost, so this window read the outcome back by the same idempotency key: the run was already on the desk. Nothing was sent twice. Track it with website_lookup_job.",
      });
      return;
    }
    const notice = DispatchWindow.element("section", "", "panel");
    if (settled.outcome === "absent") {
      notice.append(
        DispatchWindow.element("h2", "Nothing was recorded"),
        DispatchWindow.element("p", "The first send's answer was lost, so we checked the desk twice by the same reference: no job was recorded for it. Nothing was accepted and nothing was sent twice."),
      );
      if (DispatchWindow.retryOpen(state)) {
        // The absence is settled, so the visitor may decide to try again. The reference is
        // unchanged: if the first send turns out to have landed, the desk returns that job
        // instead of taking a second run.
        notice.append(DispatchWindow.element("p", "The quote still holds, so you can send it again with the same reference. If the first send did reach the desk after all, you will get that same job back, not a second one."));
        box.replaceChildren(notice, state.form);
        DispatchWindow.reopen(state, {});
        state.confirmButton.textContent = "Send this parcel again";
        return;
      }
      notice.append(DispatchWindow.element("p", `The quote has run out, so this window closes now. Ask the assistant on ${state.caller} for a fresh quote if you still want the run.`));
      box.replaceChildren(notice);
      state.resolve({
        ok: false,
        settledBy: "read",
        reason: "The dispatch's answer was lost, and reading the desk by the same idempotency key showed no job recorded. Nothing was accepted. The quote has expired, so ask for a new quote before trying again.",
      });
      return;
    }
    notice.append(
      DispatchWindow.element("h2", "We could not confirm it"),
      DispatchWindow.element("p", "The first send's answer was lost, and checking the desk for 45 seconds did not settle whether the job was accepted. Nothing was sent twice, and this window will not offer another send while that is unknown."),
      DispatchWindow.element("p", "Check it on our own jobs page, where every run on the desk is listed:"),
      DispatchWindow.deskLink(),
      DispatchWindow.element("p", "If the job is there, its receipt is signed. Our receipts page checks that signature in your browser, so you can see the fee and parcel the desk actually recorded:"),
      DispatchWindow.receiptsLink(),
      DispatchWindow.element("p", `Once you have the job number, the assistant on ${state.caller} can read it with website_lookup_job. If it is not there, ask for a new quote rather than sending this one again.`),
    );
    box.replaceChildren(notice);
    state.resolve({
      ok: false,
      unknown: true,
      reason: "The dispatch may or may not have been accepted, and 45 seconds of reading the desk did not settle it. Do not dispatch again: read the job with website_lookup_job, or check the courier's own jobs page.",
    });
  }

  /**
   * End a send whose reference already names a different run.
   *
   * :param state: The window's state, with the resolver.
   * :param box: The window's content.
   * :param refusal: The desk's conflict, with the job the reference belongs to.
   */
  static finishConflict(state, box, refusal) {
    const notice = DispatchWindow.element("section", "", "panel");
    notice.append(
      DispatchWindow.element("h2", "That reference is already used"),
      DispatchWindow.element("p", refusal.reason),
      DispatchWindow.element("p", "Nothing new was accepted. This window closes now."),
    );
    box.replaceChildren(notice);
    state.resolve({ ok: false, code: refusal.code, jobId: refusal.jobId, reason: refusal.reason });
  }

  /**
   * Whether the quote still holds, which is how long a retry may be offered.
   *
   * :param state: The window's state, with the held quote.
   * :return: True while the quote has not expired.
   */
  static retryOpen(state) {
    const until = Date.parse(state.quote?.expiresAt || "");
    return Number.isFinite(until) && Date.now() < until;
  }

  /**
   * A link to this site's own jobs page, on whatever origin the site is served from.
   *
   * :return: The anchor element.
   */
  static deskLink() {
    const link = DispatchWindow.element("a", "Conveyor Courier — jobs on the desk");
    link.href = new URL("../index.html", import.meta.url).href;
    link.target = "_blank";
    link.rel = "noopener";
    return link;
  }

  /**
   * A link to the desk's receipts page, where a recorded run can be verified.
   *
   * :return: The anchor element.
   */
  static receiptsLink() {
    const link = DispatchWindow.element("a", "Conveyor Courier — verify a receipt");
    link.href = `${new URL("../index.html", import.meta.url).href}#receipts`;
    link.target = "_blank";
    link.rel = "noopener";
    return link;
  }

  /**
   * Let the visitor try again after a refusal, with the desk's reason shown.
   *
   * :param state: The window's state.
   * :param errors: The desk's errors by field name.
   */
  static reopen(state, errors) {
    state.done = false;
    state.confirmButton.disabled = false;
    DispatchWindow.showErrors(state, errors);
  }

  /**
   * Show each error under its field, mark the field invalid, and focus the first one.
   *
   * :param state: The window's state, with the form and its error lines.
   * :param errors: The desk's errors by field name, empty when all is fine.
   */
  static showErrors(state, errors) {
    let first = null;
    for (const name of Object.keys(state.messages)) {
      const text = errors[name] || "";
      state.messages[name].textContent = text;
      state.messages[name].hidden = !text;
      const input = state.form.elements[name];
      if (input) {
        input.setAttribute("aria-invalid", text ? "true" : "false");
        if (text && !first) {
          first = input;
        }
      }
    }
    first?.focus();
  }

  /**
   * Show the result in this window, with the details the visitor typed so they can check
   * them here. Those details never leave this window.
   *
   * :param state: The window's state, with the caller's host.
   * :param done: The desk's job receipt.
   * :param details: What the visitor typed.
   * :return: The confirmation section.
   */
  static confirmation(state, done, details) {
    const box = DispatchWindow.element("section", "", "confirmation");
    box.append(
      DispatchWindow.element("h2", done.replayed ? "Already on the desk" : "On the desk"),
      DispatchWindow.element("p", `Your job number is ${done.jobId}.`),
      DispatchWindow.element("p", `Status ${done.status} · ${done.dropZone} · ${done.feeText} · about ${done.etaMinutes} minutes after pickup.`),
      DispatchWindow.element("p", `Receiving: ${details.customerName}, ${details.phone}, ${details.address}`),
      DispatchWindow.element("p", `This window closes now. The chat on ${state.caller} shows the job number and the fee, not these details.`),
    );
    return box;
  }

  /**
   * End the action without a change, after the visitor clicks the decline button.
   *
   * :param state: The resolver, the caller's host and whether the form is done.
   * :param box: The window's content.
   */
  static cancel(state, box) {
    if (state.done) {
      return;
    }
    state.done = true;
    const notice = DispatchWindow.element("section", "", "panel");
    notice.append(
      DispatchWindow.element("h2", "Nothing sent"),
      DispatchWindow.element("p", `No job was accepted. This window closes now, and the chat on ${state.caller} carries on.`),
    );
    box.replaceChildren(notice);
    state.resolve({
      ok: false,
      reason: "The visitor declined in the courier's own window. No job was accepted.",
    });
  }

  /**
   * Describe the result for the calling assistant. It leaves out what the visitor typed.
   *
   * :param done: The desk's job receipt.
   * :return: The job number and what was accepted.
   */
  static result(done) {
    return {
      ok: true,
      jobId: done.jobId,
      status: done.status,
      dropZone: done.dropZone,
      parcelSize: done.parcelSize,
      itemCount: done.itemCount,
      feeCents: done.feeCents,
      feeText: done.feeText,
      etaMinutes: done.etaMinutes,
      replayed: Boolean(done.replayed),
      note: "The visitor checked the run and typed their own details in the courier's window, which has now closed. Track it with website_lookup_job.",
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

  /**
   * Make a hidden error line for one field.
   *
   * :param name: The field's name, for the line's id.
   * :return: The element.
   */
  static message(name) {
    const line = DispatchWindow.element("p", "", "field-error");
    line.id = `write-${name}-error`;
    line.hidden = true;
    return line;
  }
}
