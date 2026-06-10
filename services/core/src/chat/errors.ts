/**
 * Chat-core errors (feature 2).
 */

export class ContextOverflowError extends Error {
  constructor(
    readonly total: number,
    readonly ceiling: number,
  ) {
    super(`Assembled prompt overflows context: ${total} > ${ceiling} tokens`);
    this.name = "ContextOverflowError";
  }
}
