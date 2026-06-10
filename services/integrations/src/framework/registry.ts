/**
 * ConnectorRegistry — register, list, and resolve connectors.
 *
 * TODO(future): share registry with @jarvis/memory connector layer (feature 3)
 * once there is a shared connector abstraction package.
 */

import type { Connector, SourceId } from "../types.js";

export class ConnectorRegistry {
  private connectors = new Map<SourceId, Connector>();

  register(connector: Connector): void {
    this.connectors.set(connector.id, connector);
  }

  get(id: SourceId): Connector {
    const c = this.connectors.get(id);
    if (!c) throw new Error(`No connector registered for source: ${id}`);
    return c;
  }

  has(id: SourceId): boolean {
    return this.connectors.has(id);
  }

  list(): Connector[] {
    return [...this.connectors.values()];
  }
}
