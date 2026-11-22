// A stand-in for the browser's DOMParser, for the bridge tests.
import { StubDocument } from "./stub_document.mjs";

/**
 * Parses HTML into the site's stub document, as the action bridge parses the page it
 * fetches (bridge/bridge-actions.js). The stub knows the page's ids, and gets a head that
 * takes the base element the bridge adds.
 */
export class StubParser {
  /**
   * The address the parsed page's links resolve against, as the bridge's base element sets.
   */
  static url = "http://[::1]:8083/";

  /**
   * Called with each parsed page, so a test can give its elements text, or null.
   */
  static fill = null;

  /**
   * Parse a page.
   *
   * :param html: The page's HTML.
   * :return: The stub document.
   */
  parseFromString(html) {
    const page = StubDocument.fromHtml(html, StubParser.url);
    page.head = {
      prepend: StubParser.ignore,
    };
    if (StubParser.fill !== null) {
      StubParser.fill(page);
    }
    return page;
  }

  /**
   * Accept a call and do nothing.
   */
  static ignore() {}
}
