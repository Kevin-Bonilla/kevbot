/**
 * Base class for every intentional kevbot error.
 *
 * Lives in its own file (not re-exported through ./index) so error modules
 * can extend it without an import cycle: index -> purge-errors -> index.
 */
export class KevbotError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    // Set per-subclass without every subclass repeating it.
    this.name = new.target.name;
    if (cause instanceof Error) this.cause = cause;
  }
}
