# Example 6: Custom Middleware

This example shows how to create and use custom middleware with the `handler.use()` method. Middleware allows you to intercept the execution of each chunk attempt, wrap it with additional logic (like logging, metrics, context modification), and control the flow using the `next()` function.

We'll use the built-in `createTimingMiddleware` for demonstration.

```typescript
import {
  BatchHandler,
  HandlerResult,
  ProcessedItem,
  FailedItem,
  ExecutionContext,
  // Import the built-in middleware creator
  createTimingMiddleware,
  SimpleLogger, // Interface for the logger used by middleware
} from 'batch-handler';

// Sample data
const items = [1, 'fail', 3, 4, 5];
const chunkSize = 2;

// --- Custom Logger (Optional) ---
// You can pass any object matching the SimpleLogger interface
const myLogger: SimpleLogger = {
    log: (...args) => console.log('[LOG]', ...args),
    info: (...args) => console.info('[INFO]', ...args),
    warn: (...args) => console.warn('[WARN]', ...args),
    error: (...args) => console.error('[ERROR]', ...args),
    // debug is optional for createTimingMiddleware
    debug: (...args) => console.debug('[DEBUG]', ...args),
};

// --- Create Handler and Apply Middleware ---
const handler = new BatchHandler<any, string>({
  concurrency: 1,
  retryOptions: { retries: 1, minTimeout: 50 },
});

// Create and use the timing middleware, passing our custom logger
const timingMiddleware = createTimingMiddleware(myLogger);
handler.use(timingMiddleware);

// You can add more middleware; they run in the order added
handler.use(async (ctx, next) => {
    myLogger.log(`My Custom MW: Entering for chunk #${ctx.chunkIndex}, attempt ${ctx.attempt}`);
    // You could modify ctx here (carefully!) before calling next()
    // e.g., ctx.customData = { traceId: generateTraceId() };
    try {
        await next(); // Call the next middleware or the handler processing
        myLogger.log(`My Custom MW: Exiting successfully for chunk #${ctx.chunkIndex}, attempt ${ctx.attempt}`);
    } catch (error) {
        myLogger.warn(`My Custom MW: Exiting with error for chunk #${ctx.chunkIndex}, attempt ${ctx.attempt}: ${error}`);
        throw error; // IMPORTANT: Re-throw error to propagate it
    }
});


// --- Processor Function ---
const simpleProcessor = async (
  chunk: readonly any[],
  ctx?: Readonly<ExecutionContext<any, string>>
): Promise<HandlerResult<any, string>> => {
  myLogger.info(`Processor: Running for chunk #${ctx?.chunkIndex}, attempt ${ctx?.attempt}`);
  await new Promise(res => setTimeout(res, 100)); // Simulate work

  if (chunk.includes('fail') && ctx?.attempt === 1) {
    throw new Error("Simulated failure on attempt 1");
  }

  const successes: ProcessedItem<any, string>[] = chunk.map(item => ({
    item,
    result: `Processed ${item}`,
  }));
  return { successes, failures: [] };
};

// --- Execute ---
async function runWithMiddleware() {
  console.log(`Starting processing with middleware...`);
  await handler.execute(items, chunkSize, simpleProcessor);
  console.log('\nProcessing finished.');
}

runWithMiddleware();

/* Expected Output (Illustrative):

Starting processing with middleware...
[DEBUG] BatchHandler Timing MW: Chunk #0 attempt 1 starting...  <-- Timing MW (Outer)
[LOG] My Custom MW: Entering for chunk #0, attempt 1           <-- Custom MW (Inner)
[INFO] Processor: Running for chunk #0, attempt 1              <-- Handler
[INFO] BatchHandler Timing MW: Chunk #0 attempt 1 finished successfully in 100.xxms. Handler S/F: 2/0. <-- Timing MW
[LOG] My Custom MW: Exiting successfully for chunk #0, attempt 1 <-- Custom MW

[DEBUG] BatchHandler Timing MW: Chunk #1 attempt 1 starting...
[LOG] My Custom MW: Entering for chunk #1, attempt 1
[INFO] Processor: Running for chunk #1, attempt 1
[WARN] BatchHandler Timing MW: Chunk #1 attempt 1 failed after 100.xxms. Error: Simulated failure on attempt 1 <-- Timing MW (catches error)
[WARN] My Custom MW: Exiting with error for chunk #1, attempt 1: Error: Simulated failure on attempt 1 <-- Custom MW (catches error)

[DEBUG] BatchHandler Timing MW: Chunk #1 attempt 2 starting...  <-- Retry starts new middleware chain
[LOG] My Custom MW: Entering for chunk #1, attempt 2
[INFO] Processor: Running for chunk #1, attempt 2
[INFO] BatchHandler Timing MW: Chunk #1 attempt 2 finished successfully in 100.xxms. Handler S/F: 1/0.
[LOG] My Custom MW: Exiting successfully for chunk #1, attempt 2

[DEBUG] BatchHandler Timing MW: Chunk #2 attempt 1 starting...
[LOG] My Custom MW: Entering for chunk #2, attempt 1
[INFO] Processor: Running for chunk #2, attempt 1
[INFO] BatchHandler Timing MW: Chunk #2 attempt 1 finished successfully in 100.xxms. Handler S/F: 1/0.
[LOG] My Custom MW: Exiting successfully for chunk #2, attempt 1

Processing finished.
*/