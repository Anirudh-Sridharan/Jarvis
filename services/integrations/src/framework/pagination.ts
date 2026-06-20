/**
 * Generic token-based pagination for connector sync().
 *
 * Most provider list endpoints return a page of items plus an opaque "next page
 * token"; you re-request with that token until it's absent. {@link fetchAllPages}
 * captures that loop once — with a safety cap on page count — so each connector
 * only describes how to fetch ONE page (its URL, params, and where the items and
 * next-page token live in the response).
 */

/** One page of a paginated list endpoint. */
export interface Page<T> {
  items: T[];
  /** Token for the next page; `null`/`undefined` means this was the last page. */
  nextPageToken?: string | null;
}

/**
 * Fetch every page of a token-paginated endpoint and return the flattened items.
 *
 * @param fetchPage  Fetch one page given the current page token (`undefined` on
 *                   the first request); returns that page's items + next token.
 * @param maxPages   Safety bound — stop after this many pages even if the
 *                   provider keeps returning tokens (guards against runaway loops
 *                   and abusive responses).
 */
export async function fetchAllPages<T>(
  fetchPage: (pageToken: string | undefined) => Promise<Page<T>>,
  maxPages: number,
): Promise<T[]> {
  const items: T[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const { items: pageItems, nextPageToken } = await fetchPage(pageToken);
    items.push(...pageItems);
    if (!nextPageToken) break;
    pageToken = nextPageToken;
  }

  return items;
}
