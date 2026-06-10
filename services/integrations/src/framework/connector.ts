/**
 * Connector interface — the contract all data-source connectors must implement.
 *
 * A Connector knows how to:
 *   1. Authenticate (via injected HttpClient + TokenStore)
 *   2. Fetch incremental data since a Cursor
 *   3. Return normalized MetricPoints (and optionally CalendarEvents)
 *
 * The framework (registry + scheduler + runner) knows nothing about source-
 * specific shapes. Connectors are the ONLY code that talks to external APIs.
 */

export type { Connector, ConnectorSyncResult } from "../types.js";
