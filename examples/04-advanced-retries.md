# Example 4: Advanced Retry Logic (`retryOn`)

This example focuses on configuring the `retryOptions.retryOn` function to precisely control which errors trigger a retry attempt for a failed chunk.

```typescript
import {
  BatchHandler,
  HandlerResult,
  ProcessedItem,
  FailedItem,
  ExecutionContext,
  AbortError,
} from 'batch-handler';

// Custom Error types for clarity
class TransientNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientNetworkError';
  }
}
class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
class FatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalError';
  }
}

// Sample data
const items = [1, 2, 3, 'invalid', 5, 6, 'network_fail', 8, 9, 'fatal'];
const chunkSize = 3;

// --- Configuration with Advanced retryOn ---
const handler = new BatchHandler<any, string>({
  concurrency: 1, // Simplify for logging
  retryOptions: {
    retries: 2, // Retry up to 2 times
    minTimeout: 100, // Quick retry delay for example
    retryOn: (error: any): boolean => {
      console.log(`retryOn checking error: ${error?.name} - "${error?.message}"`);
      // --- Logic ---
      // YES: Retry specific transient errors
      if (error instanceof TransientNetworkError) {
        console.log(' -> Decision: RETRY (Transient Network Error)');
        return true;
      }
      // YES: Retry generic network codes (could be caught by underlying library)
      if (error?.code && ['ECONNRESET', 'ETIMEDOUT'].includes(error.code)) {
        console.log(` -> Decision: RETRY (Network Code: ${error.code})`);
        return true;
      }
      // NO: Do NOT retry validation errors (permanent issue with data)
      if (error instanceof ValidationError) {
        console.log(' -> Decision: NO RETRY (Validation Error)');
        return false;
      }
      // NO: Do NOT retry fatal errors (unrecoverable)
      if (error instanceof FatalError) {
        console.log(' -> Decision: NO RETRY (Fatal Error)');
        return false;
      }
      // NO: Do NOT retry AbortErrors (signal/timeout/explicit non-retry)
      if (error instanceof AbortError || error?.name === 'AbortError') {
         console.log(' -> Decision: NO RETRY (AbortError)');
         return false;
      }

      // DEFAULT: Decide based on error properties if needed.
      // For this example, let's assume unknown errors are NOT retriable.
      console.log(` -> Decision: NO RETRY (Unknown error type: ${error?.name})`);
      return false;
    },
  },
});

// --- Processor Function Simulating Errors ---
const errorSimulator = async (
  chunk: readonly any[],
  ctx?: Readonly<ExecutionContext<any, string>>
): Promise<HandlerResult<any, string>> => {
  const attempt = ctx?.attempt ?? 1;
  console.log(`\nProcessing chunk #${ctx?.chunkIndex}, attempt ${attempt}: [${chunk.join(', ')}]`);
  await new Promise(res => setTimeout(res, 50)); // Simulate work

  const successes: ProcessedItem<any, string>[] = [];
  const failures: FailedItem<any>[] = [];

  for (const item of chunk) {
    if (item === 'invalid') {
      // Permanent validation error for this item/chunk
      throw new ValidationError(`Item "${item}" is invalid.`);
    }
    if (item === 'network_fail' && attempt === 1) {
      // Transient network error on the first attempt only
      throw new TransientNetworkError(`Simulated network issue for item "${item}".`);
    }
    if (item === 'fatal') {
      // Unrecoverable error
      throw new FatalError(`Fatal error processing item "${item}".`);
    }

    // Successful processing
    successes.push({ item, result: `Processed item ${item} on attempt ${attempt}` });
  }
  return { successes, failures };
};

// --- Event Listeners ---
handler.on('onRetry', (ctx) => {
  console.log(`HANDLER EVENT: onRetry scheduled for chunk #${ctx.chunkIndex} (attempt ${ctx.attempt} failed with ${ctx.error?.name})`);
});
handler.on('onChunkSuccess', (ctx) => {
    console.log(`HANDLER EVENT: onChunkSuccess for chunk #${ctx.chunkIndex} on attempt ${ctx.attempt}`);
});
handler.on('onChunkFailure', (ctx) => {
  console.log(`HANDLER EVENT: onChunkFailure for chunk #${ctx.chunkIndex} after ${ctx.attempt} attempts. Final Error: ${ctx.error?.name} - "${ctx.error?.message}"`);
});

// --- Execute ---
async function runAdvancedRetries() {
  console.log(`Starting processing with advanced retry logic...`);
  const results = await handler.execute(items, chunkSize, errorSimulator);

  console.log('\n--- Final Results Summary ---');
  results.forEach(r => {
    console.log(`Chunk #${r.chunkIndex}: Success=${r.success}, Items=${r.items.join(',')}, Error=${r.error?.name ?? 'N/A'}`);
  });
}

runAdvancedRetries();

/* Expected Output (Illustrative):

Processing chunk #0, attempt 1: [1, 2, 3]
HANDLER EVENT: onChunkSuccess for chunk #0 on attempt 1

Processing chunk #1, attempt 1: [invalid, 5, 6]
retryOn checking error: ValidationError - "Item "invalid" is invalid."
 -> Decision: NO RETRY (Validation Error)
HANDLER EVENT: onChunkFailure for chunk #1 after 1 attempts. Final Error: AbortError - "Non-retriable error encountered in chunk 1 (attempt 1): Item "invalid" is invalid."

Processing chunk #2, attempt 1: [network_fail, 8, 9]
retryOn checking error: TransientNetworkError - "Simulated network issue for item "network_fail"."
 -> Decision: RETRY (Transient Network Error)
HANDLER EVENT: onRetry scheduled for chunk #2 (attempt 1 failed with TransientNetworkError)
Processing chunk #2, attempt 2: [network_fail, 8, 9]
HANDLER EVENT: onChunkSuccess for chunk #2 on attempt 2

Processing chunk #3, attempt 1: [fatal]
retryOn checking error: FatalError - "Fatal error processing item "fatal"."
 -> Decision: NO RETRY (Fatal Error)
HANDLER EVENT: onChunkFailure for chunk #3 after 1 attempts. Final Error: AbortError - "Non-retriable error encountered in chunk 3 (attempt 1): Fatal error processing item "fatal"."

--- Final Results Summary ---
Chunk #0: Success=true, Items=1,2,3, Error=N/A
Chunk #1: Success=false, Items=invalid,5,6, Error=AbortError  <-- Failed fast due to ValidationError
Chunk #2: Success=true, Items=network_fail,8,9, Error=N/A   <-- Succeeded on retry
Chunk #3: Success=false, Items=fatal, Error=AbortError       <-- Failed fast due to FatalError
*/