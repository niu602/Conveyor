// One documented demo job, so the sample queries about a job number have something to
// read. It is made through the desk's own operations, not written into the store, so it
// obeys the same rules as a real run.
//
// The README names J-DEMO-1 as the demo job. Its details are made up and belong to no one.
import { CourierDesk } from "./courier-desk.js";

/**
 * Put the demo job on a desk, unless it is already there.
 *
 * :param store: The store to seed.
 * :return: A promise of the demo job's receipt, or null when it was already there.
 */
export async function seedDemoJob(store) {
  const existing = await store.getJob("J-DEMO-1");
  if (existing) {
    return null;
  }
  // A fixed clock and fixed ids keep the demo job the same on every start.
  const at = new Date("2026-11-20T14:00:00.000Z");
  let step = 0;
  const ids = () => ["demo-quote", "DEMO-1"][step++] || `demo-${step}`;
  const desk = new CourierDesk(store, () => at, ids);
  const quote = await desk.quote({ dropZone: "harbor", parcelSize: "small", itemCount: 2 });
  if (!quote.ok) {
    return null;
  }
  const job = await desk.dispatch(
    {
      quoteId: quote.quoteId,
      expectedFeeCents: quote.feeCents,
      dropZone: "harbor",
      parcelSize: "small",
      itemCount: 2,
      itemSummary: "2x Margherita",
      pizzaOrderRef: "DEMO-ORDER",
      idempotencyKey: "demo-job-1",
    },
    { customerName: "Demo Recipient", phone: "555-0100", address: "1 Demo Quay, Marrow Point" },
  );
  return job.ok ? job : null;
}
