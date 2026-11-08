/** Application budgets only; upstream hosts may cancel requests earlier. */
export const ALLOCATION_WAIT_MS = 2 * 60 * 60 * 1000;
// GET and POST share ALLOCATION_WAIT_MS. Allow overhead for token lookup,
// verification, kernel start and ledger finalization.
export const OPEN_REQUEST_MS = ALLOCATION_WAIT_MS + 60_000;
export const OPEN_CLIENT_REQUEST_MS = OPEN_REQUEST_MS + 30_000;
