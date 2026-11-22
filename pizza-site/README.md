# Little Oven Pizza, Marrow Point — Conveyor's calling site

The Little Oven Pizza website with an assistant built into the page. The site
has a menu, a cart, a demo checkout, an address, opening hours and a note on
its neighbors, Tidewhistle Guesthouse and Marrow Point Harbor Tours. The
assistant runs in the visitor's browser, uses the visitor's own LLM API key,
answers from the site's real data and calls the site's own functions to fill
the cart and place a demo order. It can also ask the guesthouse and the tour
site's assistants what they offer, and other agent sites can call its network
(see "Linked sites"). It uses plain HTML, CSS and JavaScript modules with no
dependencies or build step.

**This is a fork.** It started as `examples/marrow_point_pizza_agentified` from the
[agentic-web](https://github.com/cognizant-ai-labs/agentic-web) repository, made with the
agentify-website skill. Conveyor adds one partner, **Conveyor Courier**, so this site's
assistant can quote a delivery and hand it to the courier's desk. Everything else is the
official example. The additions are: the `courier_dispatch` partner tool, its
`link_labels` entry and `allowed_peers` origin, the "How to work" line for it, the
`#courier-note` paragraph under **Find us** and its `courier` page fact, the greeting and
sample query, and the third entry in the tests' `PARTNERS` table.

Run it with the official repository checked out at `D:\OpenAgenticWeb`:

```powershell
$SKILL_DIR = "D:\OpenAgenticWeb\skills\agentify-website"
node "$SKILL_DIR\scripts\serve_site.mjs" D:\Conveyor\pizza-site --port 8084 --open-as 127.0.0.1
```

Open http://127.0.0.1:8084/, the address it prints. The skill's server sends the
CORS header on the public files, so other agent sites can call this one. Use
the local server rather than opening `index.html` from disk: browsers don't run
JavaScript modules from `file://` pages.

## Try it

1. Browse the four pizzas, their ingredients, dietary labels and allergens.
2. Add pizzas, increase or decrease quantities, or remove items from the cart.
3. Enter a name, choose pickup or delivery, and optionally choose a time today.
   Delivery requires an address.
4. Select **Place demo order** to see an order number, items, total and fulfillment
   details. The cart empties so you can start another order.
5. Under **Find us**, see the address, phone number and opening hours, and the
   neighbors the restaurant recommends for rooms and boat trips.
6. Under **Ask Little Oven Pizza**, open **⚙ AI model settings**, paste your own
   [Otari](https://otari.ai) API key and select **Save and start**. The site uses
   hosted Otari (`https://api.otari.ai/api/v1`) with `alibaba/qwen3.8-flash`
   by default. For another provider, select it in the panel, which fills in its
   provider URL and model. Then ask, for example, "Which pizzas are vegan or
   gluten-free, and what allergens do they have?" or "Order one Pepperoni for
   pickup as soon as possible. My name is Sam Lee." The browser asks you to
   confirm before the assistant places an order. Adding and removing pizzas runs
   without asking, because you can undo it on the page. On `[::1]` the runtime
   also keeps the key in a cookie that other pages on `[::1]` can read, on any
   port, so use a key with a low spending limit. Afterwards, select
   **Delete setup** under **Advanced settings (optional)** and close the tab:
   the tab keeps using the key until it is closed.

Prices are in USD. Delivery is free and no taxes or other fees are added in this
demo. Orders and customer details stay in page memory; refreshing clears them.
No payment is collected and no real order is placed. The assistant sends your
messages, and the page data it reads, to the LLM provider you choose. The latest
confirmation remains visible until another order replaces it or the page is
refreshed.

The site does not check the order time against the opening hours, and neither
did the original page. The assistant is told to check the time against today's
date and the opening hours before it orders.

## Linked sites

The assistant can ask three partner sites' assistants, each at most once per
message:

- Tidewhistle Guesthouse, about rooms and stays, at the network URL
  `http://127.0.0.1:8080/tidewhistle_guesthouse`;
- Marrow Point Harbor Tours, about boat trips and walks, at the network URL
  `http://localhost:8081/marrow_point_harbor_tours`;
- **Conveyor Courier**, about parcel runs, at the network URL
  `http://localhost:8085/courier_dispatch`. This one shares a write, so it can
  accept a delivery for this site's visitor, not just answer questions.

To try them, serve each in its own terminal. The two official examples come from the
agentic-web checkout; the courier is this repository's own site:

```powershell
$SKILL_DIR = "D:\OpenAgenticWeb\skills\agentify-website"
node "$SKILL_DIR\scripts\serve_site.mjs" D:\OpenAgenticWeb\examples\guesthouse_agentified --port 8080 --open-as 127.0.0.1
node "$SKILL_DIR\scripts\serve_site.mjs" D:\OpenAgenticWeb\examples\harbor_tours_agentified --port 8081 --open-as localhost
node D:\Conveyor\courier-site\worker\local-server.mjs --port 8086
node "$SKILL_DIR\scripts\serve_site.mjs" D:\Conveyor\courier-site --port 8085 --open-as localhost
```

The sites use different host names on purpose. On these hosts the runtime keeps
saved keys in a cookie for the host name, on every port. On a shared host name, a
partner site would get that cookie, key included, with each request.

Then ask this site's assistant, for example, "Is there somewhere to stay
nearby?" Before anything is sent, a card shows the partner's name, its host and
the first 140 characters of the request, and asks you to agree. Treat the
request as sent to the partner: its assistant reads it. This site's rules tell
the assistant to give exact dates and numbers of people, and never to put in
names, emails, phone numbers or booking codes. The runtime does not filter the
request, so check it on the card.
**Always allow** skips the card, and that check, for every partner on that host
until you reload the page. A partner's assistant can ask its own partners too,
each after its own card.

After you agree, the partner's network runs in this browser, on your key and
router, and costs more than the card's token estimate. It gets only the reads
the partner's site shares with this one, such as the guesthouse's free rooms
and prices or the tour site's departures. Each runs the partner's own code in a
hidden frame on the partner's address. Bookings stay on the partner's own page.
The assistant then gives the partner's link from this page's **Find us** note. If you decline,
nothing is sent to the partner, and the assistant should say so and give that
link. It should do the same when a partner is not running.

Other agent sites can call this network at
`http://127.0.0.1:8084/little_oven_pizza`. It then runs in their visitor's browser
with one read that this site shares with the guesthouse and the tour site in
`bridge/bridge-actions.js`: the menu, the time and the page's facts, such as
opening hours and delivery. It also shares one order with the guesthouse,
`place_order` in `bridge/order-window.js`. That opens this site's own window,
where the visitor checks the pizzas and types their name and address, and the
guesthouse's chat gets back only the order number, the pizzas, the total and
when. The cart stays on this page. Their visitor also gets a card for each
partner this network asks.

### The courier, which accepts a delivery

Ask, for example, "Order two Margherita pizzas and ask the courier what it costs to run
them to North town." After the consent card, the courier's assistant reads its own fee
table and quotes the run. This site's assistant reports the fee and the trip time, and
only once you agree to that fee does it ask the courier to accept the delivery.

That acceptance opens **the courier's own window**, on `localhost:8085`, not a dialog on
this page. There you see the zone, the parcel, the fee and how long the quote lasts, and
you type your name, phone number and address. Those go straight to the courier's desk.
This chat gets back only the job number, the status, the fee and the trip minutes. Press
**Keep it with them** and nothing is recorded.

The assistant is told never to ask for your details and never to put them in a request,
but the runtime does not filter what a model writes, so check the card. The courier
records one job per quote: asking twice for the same quote returns the first job rather
than a second run. To cancel, use the courier's own desk page while the job is still
assigned — this site cannot cancel it.

## Tests

From anywhere, with the paths below:

```powershell
node --test "D:\Conveyor\pizza-site\tests\*.test.mjs"
```

The tests use the real runtime and page code with a scripted model, and call no
LLM provider. One test prints how many characters of system prompt and tool
definitions each model call sends. After changing `little_oven_pizza.hocon` or
`agent-manifest.json`, rebuild the generated files with the skill's
`scripts/build_network.mjs` (see the comment at the top of the `.hocon` file).

## Files

- `index.html`: semantic page structure, cart, checkout form and the assistant section.
- `styles.css`: small responsive layout, with no external fonts or assets, and
  the assistant's styles at the end.
- `script.js`: menu data, cart state, rendering and demo checkout, as the class
  `App`, with the page object at `App.page`.
- `site.js`: boots the assistant and shows its confirmation dialog.
- `site-actions.js`: registers the operations the assistant can call.
- `little_oven_pizza.hocon`: the agent network's source.
- `little_oven_pizza.network.json`, `agent-mcp.json` and `.well-known/`:
  generated from the `.hocon` file and the manifest. Do not edit them by hand.
- `bridge/`: the page other agent sites load in a hidden frame before they run
  this network. `bridge-actions.js` holds the read it shares with them, and
  `order-window.js` the order it shares with the guesthouse. The build writes
  the page and its manifest. Do not edit those by hand.
- `agent-manifest.json` and `links.json`: the public files that describe the
  network.
- `runtime/`: the browser runtime, copied unchanged from the skill.
- `tests/`: Node tests with a DOM stand-in and a scripted model.

`App.MENU` in `script.js` holds stable item IDs, prices in integer cents,
ingredients, dietary labels and allergens. The page's buttons, its checkout
form and the assistant all call the same methods on `App.page`:

- `getState()` returns today's date and time, the menu, the page-only facts
  with their links, the cart with its version and the latest demo order.
- `addItem(id, quantity)` adds pizzas and keeps the rest of the cart.
- `setQuantities(lines)` sets exact quantities, where 0 removes a pizza, and
  checks every line before it changes any.
- `checkOrder(details)` checks an order without placing it.
- `placeOrder(details)` runs `checkOrder`, then shows the confirmation and
  empties the cart. It takes `customerName`, `fulfillment` (`"pickup"` or
  `"delivery"`), `address`, `orderTime` (`HH:MM`, or empty for as soon as
  possible) and `expectedVersion`, the cart version the visitor saw.

These return `{ok: false, reason, field}` when the site refuses, and change
nothing then. The cart version goes up on every cart change, so an order never
uses a cart the visitor did not see. `App.now()` is the only place the site
reads the clock. To pin it in tests, set `App.fixedNow`, such as
`"2026-11-13T18:30:00"`.

Real payment, durable order storage and order tracking are not implemented.
Replace the demo checkout with a backend before accepting real orders.
