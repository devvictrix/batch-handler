// src/index.ts

import pLimit from 'p-limit';
// Import AbortError specifically
import pRetry, { AbortError } from 'p-retry';

/** Represents a successfully processed item within a batch */
export interface ProcessedItem<I, O> {
  /** The original input item. */
  readonly item: I;
  /** The result obtained from processing the item. */
  readonly result: O;
}

/** Represents a failed item within a batch */
export interface FailedItem<I> {
  /** The original input item. */
  readonly item: I;
  /** The error encountered while processing the item. */
  readonly error: any;
}

/** The expected return type from the user-provided batch processing function. */
export type HandlerResult<I, O> = {
  /** List of items successfully processed within this chunk. */
  readonly successes: Readonly<ProcessedItem<I, O>[]>;
  /** List of items that failed processing within this chunk (handler should catch and report these). */
  readonly failures: Readonly<FailedItem<I>[]>;
};

/** The detailed outcome of processing a single batch/chunk */
export interface BatchResult<I, O> {
  /** The 0-based index of this chunk. */
  readonly chunkIndex: number;
  /** The items included in this chunk. */
  readonly items: Readonly<I[]>;
  /**
   * Indicates if the chunk handler function executed without throwing an unrecoverable error
   * (like timeout, abort signal, or non-retriable error after all retries failed).
   * Note: Individual items within the chunk might still have failed if the handler reported them.
   */
  readonly success: boolean;
  /** List of items that were successfully processed by the handler function. Only populated if `success` is true. */
  readonly successes: Readonly<ProcessedItem<I, O>[]>;
  /**
   * List of items that failed during processing.
   * If `success` is true, this contains only items reported as failed by the handler function.
   * If `success` is false, this contains *all* items from the original chunk, marked with the chunk-level error.
   */
  readonly failures: Readonly<FailedItem<I>[]>;
  /** If `success` is false, this holds the overarching error for the chunk (e.g., timeout, AbortError, or error after all retries failed). */
  readonly error?: any;
}

/** Options for configuring retry behavior using p-retry. */
export interface RetryOptions {
  /** Maximum number of retry attempts (excluding the initial attempt). Default: 3. */
  retries: number;
  /** The exponential factor to use. Default: 2. */
  factor: number;
  /** The minimum time to wait before retrying (in milliseconds). Default: 1000. */
  minTimeout: number;
  /** The maximum time to wait before retrying (in milliseconds). Default: Infinity. */
  maxTimeout?: number;
  /** Randomize the timeout interval using exponential backoff jitter. Default: true. */
  jitter?: boolean;
  /**
   * A function determining whether an error should trigger a retry.
   * Receives the error as an argument. Return `true` to retry, `false` to abort.
   * Can return a Promise resolving to a boolean.
   * Default: `() => true` (retries on any error).
   */
  retryOn?: (error: any) => boolean | Promise<boolean>;
}

/** Configuration options for the BatchHandler. */
export interface BatchHandlerOptions<I, O> {
  /** Maximum number of chunks to process concurrently. Must be > 0. Default: 5. */
  concurrency?: number;
  /** Milliseconds to pause between starting the processing of consecutive chunks. Default: 0 (no delay). */
  rateLimit?: number;
  /**
   * Overall deadline in milliseconds for processing a single chunk, including all retries.
   * If exceeded, the chunk fails with a timeout error (which is an AbortError).
   * Default: undefined (no timeout).
   */
  timeout?: number;
  /** Retry behavior configuration. Uses `p-retry`. */
  retryOptions?: Partial<RetryOptions>;
  /** An AbortSignal to prematurely cancel the entire batch operation. */
  signal?: AbortSignal;
}

// Define the actual shape of options after defaults are applied
type ResolvedBatchHandlerOptions<I, O> = {
  readonly concurrency: number;
  readonly rateLimit: number;
  readonly timeout: number | undefined;
  readonly signal: AbortSignal | undefined;
  readonly retryOptions: Readonly<RetryOptions>;
};

/** Names of events emitted by the BatchHandler. */
export type EventName =
  | 'onStart' // Before a chunk starts processing (after potential rate limit delay, before first attempt)
  | 'onRetry' // When a chunk attempt fails and a retry is scheduled
  | 'onChunkSuccess' // After a chunk successfully processes (handler resolved after all retries/middleware)
  | 'onChunkFailure' // After a chunk fails definitively (timeout, abort, retries exhausted, non-retriable error)
  | 'onProgress' // After each chunk finishes processing (successfully or not)
  | 'onComplete'; // After all chunks have been processed or the operation was aborted

/** Base context provided to most event handlers. */
export interface BaseContext<I, O> {
  /** The options the BatchHandler was configured with (including defaults). */
  readonly options: Readonly<ResolvedBatchHandlerOptions<I, O>>;
  /** The AbortSignal provided in the options, if any. */
  readonly signal?: AbortSignal;
}

/** Context provided to chunk-related event handlers (onStart, onRetry, onChunkSuccess, onChunkFailure). */
export interface ExecutionContext<I, O> extends BaseContext<I, O> {
  /** The 0-based index of the chunk this context relates to. */
  readonly chunkIndex: number;
  /** The items in the current chunk. */
  readonly items: Readonly<I[]>;
  /** The current attempt number for this chunk (starts at 1). Available in onRetry, onChunkSuccess, onChunkFailure. */
  attempt: number; // Writable by internal logic
  /** The error that caused the current failure or retry (present in onRetry, onChunkFailure). */
  error?: any;
  /** The result data from a successful chunk execution (present in onChunkSuccess). Contains successes and failures arrays as reported by the handler. */
  data?: HandlerResult<I, O>;
}

/** Context provided to the onProgress event handler. */
export interface ProgressContext<I, O> extends BaseContext<I, O> {
  /** Number of chunks processed so far (either success or failure). */
  readonly processedChunks: number;
  /** Total number of chunks to be processed. */
  readonly totalChunks: number;
  /** Total number of items across all chunks processed so far. */
  readonly processedItems: number;
  /** Total number of items in the input dataset. */
  readonly totalItems: number;
  /** Total number of items successfully processed across all chunks so far (based on `successes` array in successful `BatchResult`s). */
  readonly successfulItems: number;
  /** Total number of items that failed processing across all chunks so far (based on `failures` array in successful `BatchResult`s and all items in failed `BatchResult`s). */
  readonly failedItems: number;
}

/** Context provided to the onComplete event handler. */
export interface CompletionContext<I, O> extends ProgressContext<I, O> {
  /** Total duration of the batch execution in milliseconds. */
  readonly durationMs: number;
  /** Indicates whether the operation was aborted via the signal. */
  readonly aborted: boolean;
}

/** Type signature for event handlers. */
export type EventHandler<Ctx> = (ctx: Readonly<Ctx>) => void | Promise<void>;

/**
 * Type signature for middleware functions.
 * Middlewares are executed in order before the chunk handler function runs (this includes retries).
 * Call `next()` to proceed to the next middleware or the handler function's retry loop.
 */
export type Middleware<I, O> = (
  /** The execution context, mutable by middleware but use caution. */
  ctx: ExecutionContext<I, O>,
  /** Call to proceed to the next middleware or the core handler logic. */
  next: () => Promise<void>
) => Promise<void>;

/**
 * Type signature for the user-provided batch processing function.
 * Can optionally receive the execution context.
 */
export type BatchProcessorFn<I, O> = (
  /** The current chunk of items being processed. */
  chunk: Readonly<I[]>,
  /** Optional execution context, including attempt number, chunk index, etc. */
  ctx?: Readonly<ExecutionContext<I, O>> // Added optional context
) => Promise<HandlerResult<I, O>>;

/**
 * Handles batch processing tasks over datasets by splitting into chunks,
 * managing concurrency, rate limiting, retries, timeouts, middleware, and events.
 * Implements core v1.0.0 features.
 *
 * @template I The type of individual items in the input array.
 * @template O The type of the result object for a single successfully processed item.
 */
export class BatchHandler<I, O> {
  private readonly options: Readonly<ResolvedBatchHandlerOptions<I, O>>;
  private readonly retryOpts: Readonly<RetryOptions>; // Use full RetryOptions internally

  private middlewares: Middleware<I, O>[] = [];
  private listeners: {
    [K in EventName]?: EventHandler<any>[]; // Use 'any' internally, but expose typed 'on'
  } = {};

  /**
   * Creates a new BatchHandler instance.
   * @param opts Configuration options for the handler.
   */
  constructor(opts: BatchHandlerOptions<I, O> = {}) {
    if (opts.concurrency !== undefined && opts.concurrency <= 0) {
      throw new Error('options.concurrency must be greater than 0.');
    }
    if (opts.rateLimit !== undefined && opts.rateLimit < 0) {
      throw new Error('options.rateLimit cannot be negative.');
    }
    if (opts.timeout !== undefined && opts.timeout <= 0) {
      throw new Error('options.timeout must be greater than 0.');
    }

    const defaultRetryOptions: RetryOptions = {
      retries: 3,
      factor: 2,
      minTimeout: 1000,
      maxTimeout: Infinity,
      jitter: true,
      retryOn: () => true, // Default: retry on any error
    };
    // Ensure retryOn is always a function
    const userRetryOn = opts.retryOptions?.retryOn;
    this.retryOpts = Object.freeze({
      ...defaultRetryOptions,
      ...(opts.retryOptions ?? {}),
      retryOn:
        userRetryOn !== undefined ? userRetryOn : defaultRetryOptions.retryOn,
    });

    // Store combined options, applying defaults and ensuring the correct shape
    this.options = Object.freeze({
      concurrency: opts.concurrency ?? 5,
      rateLimit: opts.rateLimit ?? 0,
      timeout: opts.timeout, // Retain potential undefined
      signal: opts.signal,
      retryOptions: this.retryOpts, // Store the fully resolved retry options
    });

    // Early abort listener
    this.options.signal?.addEventListener(
      'abort',
      () => {
        // Optional: add debug logging if needed
        // console.debug('BatchHandler: Abort signal received.');
      },
      { once: true }
    );
  }

  /**
   * Adds a middleware function to the execution pipeline.
   * Middlewares are executed in the order they are added, before the handler function runs for each attempt.
   * @param mw The middleware function.
   * @returns The BatchHandler instance for chaining.
   */
  use(mw: Middleware<I, O>): this {
    this.middlewares.push(mw);
    return this;
  }

  /**
   * Subscribes a handler function to a specific event.
   * @param event The name of the event to subscribe to.
   * @param handler The function to call when the event is emitted.
   * @returns The BatchHandler instance for chaining.
   */
  on<E extends EventName>(
    event: E,
    handler: E extends 'onProgress'
      ? EventHandler<ProgressContext<I, O>>
      : E extends 'onComplete'
        ? EventHandler<CompletionContext<I, O>>
        : EventHandler<ExecutionContext<I, O>>
  ): this {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    // Type assertion is safe due to the conditional type in the signature
    (this.listeners[event] as EventHandler<any>[]).push(handler);
    return this;
  }

  /** Safely emits an event (fire and forget). */
  private async emit<Ctx>(event: EventName, ctx: Readonly<Ctx>) {
    const handlers = this.listeners[event];
    if (handlers) {
      handlers.forEach(async (fn) => {
        try {
          await fn({ ...ctx }); // Pass shallow copy
        } catch (err) {
          console.error(`Error in async event handler for '${event}':`, err);
        }
      });
    }
  }

  /** Runs the middleware chain and the core batch processing logic with retries. */
  private async runMiddlewareAndHandler(
    ctx: ExecutionContext<I, O>,
    batchProcessorFn: BatchProcessorFn<I, O>
  ): Promise<HandlerResult<I, O>> {
    // Core function to be wrapped by middleware and retries
    const coreHandlerExecution = async (): Promise<HandlerResult<I, O>> => {
      return pRetry(
        // The main function pRetry will attempt/retry
        async (attemptNumber) => {
          // attemptNumber is the CURRENT attempt count (1, 2, ...)
          ctx.attempt = attemptNumber; // Update context for this specific attempt
          if (this.options.signal?.aborted) {
            throw new AbortError(
              'Operation aborted by signal before handler execution.'
            );
          }

          try {
            // Execute the user's batch processor function
            const result = await batchProcessorFn(ctx.items, ctx); // Pass context
            // Validate the structure of the result
            if (
              !result ||
              !Array.isArray(result.successes) ||
              !Array.isArray(result.failures)
            ) {
              throw new Error(
                `Handler for chunk ${ctx.chunkIndex}, attempt ${attemptNumber} returned invalid result structure.`
              );
            }
            // If the processor succeeds, return the result. pRetry will resolve with this value.
            ctx.error = undefined; // Clear any lingering error from previous attempts
            return result;
          } catch (err: any) {
            // The processor function threw an error for this attempt.
            ctx.error = err; // Store the error encountered *in this attempt*

            // *** Conditional Retry Logic ***
            let shouldRetry: boolean;
            try {
              // Evaluate the user-defined retryOn condition
              // Use the fully resolved retryOpts here
              const retryResult = this.retryOpts.retryOn!(err);
              shouldRetry =
                typeof retryResult === 'boolean'
                  ? retryResult
                  : await retryResult;
            } catch (retryOnError: any) {
              // If the retryOn function itself throws, treat it as non-retriable
              console.error(
                `Error executing retryOn function for chunk ${ctx.chunkIndex}, attempt ${attemptNumber}:`,
                retryOnError
              );
              shouldRetry = false;
              // Wrap the errors and abort immediately
              const abortError = new AbortError(
                `retryOn function failed for chunk ${ctx.chunkIndex}: ${retryOnError?.message ?? retryOnError}`
              );
              (abortError as any).originalError = err; // Attach the original handler error
              (abortError as any).retryOnError = retryOnError; // Attach the error from retryOn
              throw abortError;
            }

            // If the error should NOT be retried based on the user's logic...
            if (!shouldRetry) {
              // Throw pRetry.AbortError to stop retries immediately.
              // Wrap the original error for context.
              const abortError = new AbortError(
                `Non-retriable error encountered in chunk ${ctx.chunkIndex} (attempt ${attemptNumber}): ${err?.message ?? err}`
              );
              (abortError as any).originalError = err; // Attach original error
              throw abortError;
            }

            // *** If we determined it IS retriable ***
            // Emit the onRetry event (pass cloned context)
            this.emit('onRetry', { ...ctx }); // Clone context here for safety

            // Re-throw the original error. pRetry will catch this and schedule the next attempt
            // because we didn't throw AbortError.
            throw err;
          }
        },
        // Options for pRetry
        {
          retries: this.retryOpts.retries,
          factor: this.retryOpts.factor,
          minTimeout: this.retryOpts.minTimeout,
          maxTimeout: this.retryOpts.maxTimeout,
          randomize: this.retryOpts.jitter,
          signal: this.options.signal,
          // No 'retryOn' option here - handled inside the function above
          onFailedAttempt: (error) => {
            // error here is the error thrown from the function above (either original or AbortError)
            // Note: error.attemptNumber is the attempt that *failed*. error.retriesLeft is remaining.
            // console.debug(`[pRetry.onFailedAttempt] Chunk ${ctx.chunkIndex}, attempt ${error.attemptNumber} failed. Error: ${error.message}`);

            // Re-check signal in case it aborted during the backoff delay
            if (this.options.signal?.aborted && error.name !== 'AbortError') {
              throw new AbortError('Operation aborted during retry delay.');
            }
            // If error is AbortError (from retryOn=false or signal), pRetry stops automatically.
          },
        }
      ); // End pRetry call
    }; // End coreHandlerExecution definition

    // --- Middleware chain execution ---
    const chain = this.middlewares.reduceRight<() => Promise<void>>(
      (next, mw) => async () => {
        if (this.options.signal?.aborted)
          throw new AbortError(
            'Operation aborted before middleware execution.'
          );
        await mw(ctx, next);
      },
      // Innermost function wraps core execution with timeout
      async () => {
        let timeoutId: NodeJS.Timeout | undefined;
        try {
          if (this.options.timeout !== undefined) {
            const timeoutPromise = new Promise<never>((_, reject) => {
              timeoutId = setTimeout(() => {
                clearTimeout(timeoutId);
                reject(
                  new AbortError(
                    `Chunk #${ctx.chunkIndex} timed out after ${this.options.timeout}ms.`
                  )
                );
              }, this.options.timeout);
            });
            // Race the core handler (with internal retries) against the timeout
            ctx.data = await Promise.race([
              coreHandlerExecution(),
              timeoutPromise,
            ]);
          } else {
            // No timeout, just run the core execution
            ctx.data = await coreHandlerExecution();
          }
          // Success path: clear potential error from previous failed attempts
          ctx.error = undefined;
        } catch (error: any) {
          // Failure path: store final error (timeout, error after retries, or potentially original error if pRetry unwrapped AbortError)
          ctx.error = error;

          // *** ADAPTATION FOR FAILED TEST ***
          // Check if the caught error *should* have been an AbortError based on retryOn, but isn't.
          let shouldHaveAborted = false;
          if (!(error instanceof AbortError || error?.name === 'AbortError')) {
            // Only check if not already AbortError
            try {
              // Re-evaluate the retryOn condition based on the caught error
              const retryResult = this.retryOpts.retryOn!(error);
              if (typeof retryResult === 'boolean') {
                shouldHaveAborted = !retryResult;
              } else {
                // Await the promise if retryOn is async
                shouldHaveAborted = !(await retryResult);
              }
            } catch (retryOnError) {
              // If retryOn itself throws when re-evaluated, assume it should have aborted
              shouldHaveAborted = true;
            }
          }

          // If retryOn determined it's non-retriable, but we have the original error, wrap it now.
          if (shouldHaveAborted) {
            const wrappedAbortError = new AbortError(
              `Non-retriable error encountered in chunk ${ctx.chunkIndex}: ${error?.message ?? error}`
            );
            (wrappedAbortError as any).originalError = error; // Keep original error reference
            throw wrappedAbortError; // Throw the *wrapped* AbortError
          }
          // *** END ADAPTATION ***

          // Otherwise, propagate the error as caught (could be timeout AbortError, original error after retries exhausted, etc.)
          throw error;
        } finally {
          if (timeoutId) clearTimeout(timeoutId);
        }
      }
    ); // End middleware reducer

    // Execute the full chain (Middleware -> Timeout -> pRetry -> Handler)
    await chain();

    // If chain completed without throwing, return the data from the context
    if (!ctx.data) {
      // Defensive check: Should have data or thrown error by now
      if (!ctx.error)
        ctx.error = new Error(
          `Middleware chain for chunk ${ctx.chunkIndex} completed without data or error.`
        );
      throw ctx.error;
    }

    // Return the successful HandlerResult (stored in ctx.data)
    return ctx.data;
  }

  /**
   * Executes the batch processing operation.
   *
   * @param allItems The entire array of items to be processed.
   * @param chunkSize The number of items to include in each chunk. Must be > 0.
   * @param batchProcessorFn A function that takes a chunk of items (readonly I[]) and optionally the execution context, returning a Promise resolving to a HandlerResult<I, O>.
   * @returns A Promise that resolves to an array of BatchResult objects, one for each chunk processed before potential abortion.
   * @throws Error if chunkSize is less than or equal to 0 or if configuration is invalid.
   */
  public async execute(
    allItems: Readonly<I[]>,
    chunkSize: number,
    batchProcessorFn: BatchProcessorFn<I, O>
  ): Promise<BatchResult<I, O>[]> {
    if (chunkSize <= 0) throw new Error('chunkSize must be greater than 0.');
    if (!allItems || allItems.length === 0) return []; // Handle empty/null array

    const startTime = Date.now();
    let wasAborted = false;

    // Create chunks
    const chunks: Readonly<I[]>[] = [];
    for (let i = 0; i < allItems.length; i += chunkSize) {
      chunks.push(Object.freeze(allItems.slice(i, i + chunkSize)));
    }

    const totalChunks = chunks.length;
    const totalItems = allItems.length;
    let processedChunks = 0;
    let processedItems = 0;
    let successfulItems = 0;
    let failedItems = 0;

    const limit = pLimit(this.options.concurrency);
    let lastChunkStartTime = 0;

    // Map each chunk to a promise that represents its processing task
    const resultsPromises: Promise<BatchResult<I, O>>[] = chunks.map(
      (items, idx) =>
        limit(async (): Promise<BatchResult<I, O>> => {
          let batchResult: BatchResult<I, O> | undefined = undefined;
          const baseCtx: BaseContext<I, O> = {
            options: this.options,
            signal: this.options.signal,
          };
          // Define ctx outside try for catch/finally block access
          let ctx: ExecutionContext<I, O> = {
            ...baseCtx,
            chunkIndex: idx,
            items: items,
            attempt: 0,
          };

          try {
            // Check signal *before* rate limit delay and starting the chunk task
            if (this.options.signal?.aborted) {
              wasAborted = true;
              throw new AbortError(
                'Operation aborted before chunk processing started.'
              );
            }

            // Rate Limiting Delay
            if (this.options.rateLimit > 0) {
              const now = Date.now();
              const timeSinceLast = now - lastChunkStartTime;
              if (timeSinceLast < this.options.rateLimit) {
                await new Promise((resolve) =>
                  setTimeout(resolve, this.options.rateLimit - timeSinceLast)
                );
              }
              // Check again after delay
              if (this.options.signal?.aborted) {
                wasAborted = true;
                throw new AbortError(
                  'Operation aborted during rate limit delay.'
                );
              }
              lastChunkStartTime = Date.now();
            } else {
              lastChunkStartTime = Date.now(); // Still update time if no delay
            }

            // Emit start event
            this.emit('onStart', { ...ctx }); // Clone context

            if (this.options.signal?.aborted) {
              // Check after potential async event handlers
              throw new AbortError('Operation aborted after onStart handlers.');
            }

            // Run middleware and the handler
            const handlerOutcome = await this.runMiddlewareAndHandler(
              ctx,
              batchProcessorFn
            );

            // --- Chunk Success ---
            ctx.data = handlerOutcome;
            ctx.error = undefined;
            this.emit('onChunkSuccess', { ...ctx }); // Clone context
            batchResult = {
              chunkIndex: idx,
              items,
              success: true,
              successes: handlerOutcome.successes,
              failures: handlerOutcome.failures,
              error: undefined,
            };
          } catch (err: any) {
            // --- Chunk Failure ---
            const isAbort =
              err instanceof AbortError || err?.name === 'AbortError';
            wasAborted = wasAborted || isAbort;

            const finalError =
              err ?? new Error(`Unknown chunk failure for chunk ${idx}`);

            // Update context with the final error
            if (ctx) {
              ctx.error = finalError;
            } else {
              // If ctx wasn't created (should be rare), create a basic one
              ctx = {
                ...baseCtx,
                chunkIndex: idx,
                items: items,
                attempt: 0,
                error: finalError,
              };
            }

            // Emit failure event
            this.emit('onChunkFailure', { ...ctx }); // Clone context

            batchResult = {
              chunkIndex: idx,
              items,
              success: false,
              successes: [],
              failures: items.map((item) => ({ item, error: finalError })),
              error: finalError, // Assign the final caught error
            };
          } finally {
            // --- Progress Update (Always Runs) ---
            processedChunks++;
            processedItems += items.length;

            if (!batchResult) {
              // Defensive fallback
              console.error(
                `BatchHandler Internal Error: batchResult was not assigned for chunk ${idx}.`
              );
              const fallbackError =
                ctx?.error ??
                new Error(`Internal error: Result missing for chunk ${idx}`);
              batchResult = {
                chunkIndex: idx,
                items,
                success: false,
                successes: [],
                failures: items.map((item) => ({ item, error: fallbackError })),
                error: fallbackError,
              };
            }

            successfulItems += batchResult.successes.length;
            failedItems += batchResult.failures.length;

            const progressCtx: ProgressContext<I, O> = {
              ...baseCtx, // Use base context for stable options/signal
              processedChunks,
              totalChunks,
              processedItems,
              totalItems,
              successfulItems,
              failedItems,
            };
            this.emit('onProgress', progressCtx); // Use newly created context
          }
          return batchResult!;
        }) // End pLimit wrapped function
    ); // End chunks.map

    // Await all chunk processing promises
    const results = await Promise.all(resultsPromises);

    // --- Completion ---
    const endTime = Date.now();
    if (!wasAborted && this.options.signal?.aborted) {
      wasAborted = true;
    }
    const completionCtx: CompletionContext<I, O> = {
      options: this.options,
      signal: this.options.signal,
      processedChunks,
      totalChunks,
      processedItems,
      totalItems,
      successfulItems,
      failedItems,
      durationMs: endTime - startTime,
      aborted: wasAborted,
    };
    await this.emit('onComplete', completionCtx); // Use newly created context

    return results;
  }
} // End BatchHandler Class

// --- Built-in Middleware Examples ---

/** Basic logger interface compatible with console. */
export interface SimpleLogger {
  log: (...args: any[]) => void;
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
  debug?: (...args: any[]) => void;
}

/**
 * Creates a middleware that logs the start and end time (or failure) of each chunk attempt.
 * @param logger A logger object (defaults to console).
 */
export function createTimingMiddleware<I, O>(
  logger: SimpleLogger = console
): Middleware<I, O> {
  return async (ctx, next) => {
    const start = process.hrtime.bigint();
    logger.debug?.(
      `BatchHandler Timing MW: Chunk #${ctx.chunkIndex} attempt ${ctx.attempt} starting...`
    );
    try {
      await next();
      const end = process.hrtime.bigint();
      const durationMs = Number(end - start) / 1_000_000;
      const successCount = ctx.data?.successes?.length ?? 'N/A';
      const failureCount = ctx.data?.failures?.length ?? 'N/A';
      logger.info(
        `BatchHandler Timing MW: Chunk #${ctx.chunkIndex} attempt ${ctx.attempt} finished successfully in ${durationMs.toFixed(2)}ms. Handler S/F: ${successCount}/${failureCount}.`
      );
    } catch (error: any) {
      const end = process.hrtime.bigint();
      const durationMs = Number(end - start) / 1_000_000;
      logger.warn(
        `BatchHandler Timing MW: Chunk #${ctx.chunkIndex} attempt ${ctx.attempt} failed after ${durationMs.toFixed(2)}ms. Error: ${error?.message ?? error}`
      );
      throw error;
    }
  };
}

/** Configuration for the logging middleware. */
export interface LoggingMiddlewareOptions {
  /** Log when entering the middleware chain for an attempt. Default: true. */
  logStart?: boolean;
  /** Log when the `next()` call resolves successfully (chunk succeeded). Default: true. */
  logSuccess?: boolean;
  /** Log when the `next()` call rejects (chunk failed). Default: true. */
  logFailure?: boolean;
  /** Logger instance to use. Default: console. */
  logger?: SimpleLogger;
}

/**
 * Creates a middleware that logs the entry and exit (success/failure) of the middleware chain for each chunk attempt.
 * @param options Configuration options for logging.
 */
export function createLoggingMiddleware<I, O>(
  options?: LoggingMiddlewareOptions
): Middleware<I, O> {
  const config = {
    logStart: options?.logStart ?? true,
    logSuccess: options?.logSuccess ?? true,
    logFailure: options?.logFailure ?? true,
    logger: options?.logger ?? console,
  };

  return async (ctx, next) => {
    if (config.logStart) {
      config.logger.info(
        `BatchHandler Logging MW: Chunk #${ctx.chunkIndex} attempt ${ctx.attempt} entering middleware chain (Items: ${ctx.items.length}).`
      );
    }
    try {
      await next();
      if (config.logSuccess) {
        const successCount = ctx.data?.successes?.length ?? 'N/A';
        const failureCount = ctx.data?.failures?.length ?? 'N/A';
        config.logger.info(
          `BatchHandler Logging MW: Chunk #${ctx.chunkIndex} attempt ${ctx.attempt} 'next()' resolved. Handler S/F: ${successCount}/${failureCount}.`
        );
      }
    } catch (error: any) {
      if (config.logFailure) {
        config.logger.warn(
          `BatchHandler Logging MW: Chunk #${ctx.chunkIndex} attempt ${ctx.attempt} 'next()' rejected. Error: ${error?.message ?? error}`
        );
      }
      throw error;
    }
  };
}
