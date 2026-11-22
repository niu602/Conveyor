// Conveyor Courier's business data and rules. No DOM, no page state: the page, the
// bridge and the Worker all import this module and use the same rules, so a quote the
// visitor saw and the job the desk accepts can never disagree.
//
// Money is integer cents everywhere. Dates are ISO strings; the caller passes the clock.

/**
 * The courier desk's zones, parcel sizes, fees and rules.
 */
export class CourierData {
  /**
   * The delivery zones, with their base fee in cents and the trip time in minutes.
   */
  static ZONES = [
    { id: "harbor", name: "Harbor front", baseCents: 300, etaMinutes: 14 },
    { id: "north", name: "North town", baseCents: 450, etaMinutes: 18 },
    { id: "old_town", name: "Old town", baseCents: 550, etaMinutes: 22 },
    { id: "outside", name: "Outside Marrow Point", baseCents: 0, etaMinutes: 0 },
  ];

  /**
   * The parcel sizes, with their extra fee in cents and extra minutes.
   */
  static SIZES = [
    { id: "small", name: "Small bag (up to 2 items)", extraCents: 0, extraMinutes: 0, maxItems: 2 },
    { id: "medium", name: "Medium box (up to 6 items)", extraCents: 200, extraMinutes: 4, maxItems: 6 },
    { id: "large", name: "Large crate (up to 12 items)", extraCents: 450, extraMinutes: 9, maxItems: 12 },
  ];

  /**
   * Each extra item beyond the parcel size's allowance, in cents.
   */
  static PER_EXTRA_ITEM_CENTS = 50;

  /**
   * How long a quote stays valid, in minutes.
   */
  static QUOTE_TTL_MINUTES = 15;

  /**
   * The desk's opening hours, on a 24-hour clock, as [open, close] in minutes.
   */
  static HOURS = { open: "10:00", close: "22:00" };

  /**
   * The statuses a job goes through, in order.
   */
  static STATUSES = ["assigned", "picked_up", "delivered", "cancelled"];

  /**
   * The zone ids, for action schemas.
   *
   * :return: The ids.
   */
  static zoneIds() {
    return CourierData.ZONES.map((zone) => zone.id);
  }

  /**
   * The parcel size ids, for action schemas.
   *
   * :return: The ids.
   */
  static sizeIds() {
    return CourierData.SIZES.map((size) => size.id);
  }

  /**
   * Find a zone by id.
   *
   * :param id: The zone id.
   * :return: The zone, or null.
   */
  static zone(id) {
    return CourierData.ZONES.find((zone) => zone.id === id) || null;
  }

  /**
   * Find a parcel size by id.
   *
   * :param id: The size id.
   * :return: The size, or null.
   */
  static size(id) {
    return CourierData.SIZES.find((size) => size.id === id) || null;
  }

  /**
   * Say an amount as the desk shows it.
   *
   * :param cents: The amount in integer cents.
   * :return: The amount, such as "$4.50".
   */
  static money(cents) {
    return `$${(cents / 100).toFixed(2)}`;
  }

  /**
   * Say a clock time as minutes since midnight.
   *
   * :param hhmm: A time such as "18:30".
   * :return: The minutes, or null when the text is not a time.
   */
  static minutesOf(hhmm) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
    if (!match) {
      return null;
    }
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) {
      return null;
    }
    return hours * 60 + minutes;
  }

  /**
   * Check a quote request against the desk's rules, without making anything.
   *
   * :param request: The request with dropZone, parcelSize and itemCount.
   * :return: A refusal {ok: false, reason, field}, or null when it passes.
   */
  static quoteProblem(request) {
    const zone = CourierData.zone(request?.dropZone);
    if (!zone) {
      return { ok: false, reason: "Choose a delivery zone the desk serves.", field: "dropZone" };
    }
    if (zone.id === "outside") {
      return {
        ok: false,
        reason: "The desk does not deliver outside Marrow Point. It serves Harbor front, North town and Old town.",
        field: "dropZone",
      };
    }
    const size = CourierData.size(request?.parcelSize);
    if (!size) {
      return { ok: false, reason: "Choose a parcel size: small, medium or large.", field: "parcelSize" };
    }
    const count = request?.itemCount;
    if (!Number.isInteger(count) || count < 1) {
      return { ok: false, reason: "Give how many items are in the parcel, at least 1.", field: "itemCount" };
    }
    if (count > size.maxItems) {
      return {
        ok: false,
        reason: `A ${size.id} parcel holds up to ${size.maxItems} items. Choose a larger parcel for ${count}.`,
        field: "parcelSize",
      };
    }
    return null;
  }

  /**
   * Work out a quote's fee and time from the desk's own table.
   *
   * :param request: A request that passed quoteProblem.
   * :return: The fee in cents, the trip minutes and what they are made of.
   */
  static priceOf(request) {
    const zone = CourierData.zone(request.dropZone);
    const size = CourierData.size(request.parcelSize);
    // Every item beyond the small bag's allowance is charged, so a medium box of 6
    // costs the zone base, the box and 4 extra items.
    const chargeable = Math.max(0, request.itemCount - CourierData.SIZES[0].maxItems);
    const perItemCents = chargeable * CourierData.PER_EXTRA_ITEM_CENTS;
    const feeCents = zone.baseCents + size.extraCents + perItemCents;
    const etaMinutes = zone.etaMinutes + size.extraMinutes;
    return {
      feeCents,
      etaMinutes,
      basis: {
        zone: zone.name,
        zoneBaseCents: zone.baseCents,
        parcel: size.name,
        parcelExtraCents: size.extraCents,
        extraItems: chargeable,
        perItemCents,
      },
    };
  }

  /**
   * Check whether the desk is open at a time of day.
   *
   * :param hhmm: A time such as "18:30".
   * :return: True when the desk takes jobs then.
   */
  static openAt(hhmm) {
    const minutes = CourierData.minutesOf(hhmm);
    const open = CourierData.minutesOf(CourierData.HOURS.open);
    const close = CourierData.minutesOf(CourierData.HOURS.close);
    if (minutes === null) {
      return false;
    }
    return minutes >= open && minutes < close;
  }

  /**
   * Check the visitor's details, as the desk's own form does.
   *
   * :param details: The details with customerName, phone and address.
   * :return: The problems by field name, empty when all is fine.
   */
  static detailErrors(details) {
    const errors = {};
    const name = String(details?.customerName ?? "").trim();
    if (!name) {
      errors.customerName = "Give the name of the person receiving the parcel.";
    } else if (name.length > 80) {
      errors.customerName = "Keep the name under 80 characters.";
    }
    const phone = String(details?.phone ?? "").trim();
    const digits = phone.replace(/\D/g, "");
    if (!phone) {
      errors.phone = "Give a phone number the courier can call.";
    } else if (digits.length < 7 || digits.length > 15) {
      errors.phone = "Give a phone number with 7 to 15 digits.";
    } else if (!/^[0-9+()\-.\s]+$/.test(phone)) {
      errors.phone = "A phone number may hold digits, spaces and + ( ) - . only.";
    }
    const address = String(details?.address ?? "").trim();
    if (!address) {
      errors.address = "Give the street address to deliver to.";
    } else if (address.length > 300) {
      errors.address = "Keep the address under 300 characters.";
    }
    const note = String(details?.note ?? "");
    if (note.length > 200) {
      errors.note = "Keep the note under 200 characters.";
    }
    return errors;
  }

  /**
   * Say whether a job in a status may still be cancelled.
   *
   * :param status: The job's status.
   * :return: True while the courier has not picked the parcel up.
   */
  static cancellable(status) {
    return status === "assigned";
  }

  /**
   * Say why a job in a status cannot be cancelled.
   *
   * The desk and the confirmation dialog both read this sentence, so the visitor is told
   * the same reason wherever they meet the rule.
   *
   * :param status: The job's status.
   * :return: The reason.
   */
  static cancelProblem(status) {
    return `A job that is ${status} can no longer be cancelled. The desk cancels only before pickup.`;
  }
}
