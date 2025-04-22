# Example 5: Using AbortSignal for Cancellation

This example demonstrates how to use an `AbortController` and its `AbortSignal` to gracefully cancel a long-running batch operation.

```typescript
import {
  BatchHandler,
  HandlerResult,
  ProcessedItem,
  FailedItem,
  ExecutionContext,
  AbortError, // Useful for checking error type
} from 'batch-handler';

// Sample data
const items = Array.from({ length: 100 }, (_, i) => i + 1); // 100 items
const chunkSize = 5;

// Create an AbortController
const abortController = new AbortController();

// --- Configuration with AbortSignal ---
const handler = new BatchHandler<number, string>({
  concurrency: 2, // Allow some parallelism
  signal: abortController.signal, // Pass the signal to the handler
  retryOptions: { retries: 1, minTimeout: 50 }, // Allow quick retries
});

// --- Processor Function Simulating Work ---
const slowProcessor = async (
  chunk: readonly number[],
  ctx?: Readonly<ExecutionContext<number, string>>
): Promise<HandlerResult<number, string>> => {
  console.log(`Starting chunk #${ctx?.chunkIndex} [${chunk.join(', ')}]...`);

  // Simulate work that takes time
  await new Promise(res => setTimeout(res, 150 + Math.random() * 100));

  // --- IMPORTANT: Check signal within your handler if possible ---
  // If the work involves multiple steps or loops, check the signal periodically.
  // Libraries like p-retry (used internally) already check the signal,
  // but long-running tasks within your handler code should also check it.
  if (ctx?.signal?.aborted) {
      console.warn(`Chunk #${ctx.chunkIndex} detected abort signal during execution.`);
      // Throwing AbortError is conventional and works well with p-retry
      throw new AbortError(`Aborted during processing chunk ${ctx.chunkIndex}`);
  }

  console.log(`Finished chunk #${ctx?.chunkIndex} successfully.`);
  const successes: ProcessedItem<number, string>[] = chunk.map(item => ({
    item,
    result: `Processed item ${item}`,
  }));
  return { successes, failures: [] };
};

// --- Event Listeners ---
handler.on('onProgress', (ctx) => {
  // Don't log too much in this example, focus on abort
  if (ctx.processedChunks % 5 === 0 || ctx.processedChunks === ctx.totalChunks) {
      console.log(`Progress: ${ctx.processedChunks}/${ctx.totalChunks} chunks processed.`);
  }
});

handler.on('onComplete', (ctx) => {
  console.log(`\nBatch processing complete!`);
  console.log(`Duration: ${ctx.durationMs}ms`);
  console.log(`Aborted: ${ctx.aborted}`); // Check the aborted status
  console.log(`Total Items: ${ctx.totalItems}, Successful: ${ctx.successfulItems}, Failed: ${ctx.failedItems}`);
});

handler.on('onChunkFailure', (ctx) => {
    // Log failures, especially AbortErrors
    if (ctx.error instanceof AbortError || ctx.error?.name === 'AbortError') {
        console.error(`Chunk #${ctx.chunkIndex} aborted. Error: ${ctx.error.message}`);
    } else {
        console.error(`Chunk #${ctx.chunkIndex} failed for other reason. Error: ${ctx.error}`);
    }
});

// --- Execute and Abort ---
async function runAndAbort() {
  console.log(`Starting processing for ${items.length} items... Will abort shortly.`);

  const executionPromise = handler.execute(items, chunkSize, slowProcessor);

  // --- Trigger Abort After Delay ---
  const abortDelayMs = 500; // Abort after 500ms
  console.log(`Setting timer to abort in ${abortDelayMs}ms...`);
  setTimeout(() => {
    console.log('<<<<<<<<<< ABORTING NOW! >>>>>>>>>>');
    abortController.abort();
  }, abortDelayMs);

  // Await the final results (will resolve even if aborted)
  const results = await executionPromise;

  console.log('\n--- Final Results Summary ---');
  let successfulChunks = 0;
  let abortedChunks = 0;
  results.forEach(r => {
    if (r.success) {
        successfulChunks++;
    } else if (r.error instanceof AbortError || r.error?.name === 'AbortError') {
        abortedChunks++;
    }
    // Optionally log individual results
    // console.log(`Chunk #${r.chunkIndex}: Success=${r.success}, Error=${r.error?.name ?? 'N/A'}`);
  });
  console.log(`Total Chunks: ${results.length}, Successful: ${successfulChunks}, Aborted/Failed: ${results.length - successfulChunks} (Aborted Error Count: ${abortedChunks})`);

  // Verify the completion context also reflects the abort
  // (Requires storing the context from the 'onComplete' listener)
}

runAndAbort();

/* Expected Output (Illustrative, timing varies):
Starting processing for 100 items... Will abort shortly.
Setting timer to abort in 500ms...
Starting chunk #0 [1, 2, 3, 4, 5]...
Starting chunk #1 [6, 7, 8, 9, 10]...
Finished chunk #0 successfully.
Finished chunk #1 successfully.
Progress: 0/20 chunks processed.  <-- Note: Progress updates AFTER chunk finishes
Starting chunk #2 [11, 12, 13, 14, 15]...
Starting chunk #3 [16, 17, 18, 19, 20]...
Finished chunk #2 successfully.
<<<<<<<<<< ABORTING NOW! >>>>>>>>>>
Chunk #3 detected abort signal during execution. <-- Processor checks signal
Chunk #3 aborted. Error: Aborted during processing chunk 3
Progress: 5/20 chunks processed.  <-- Includes completed and failed/aborted chunks
Chunk #4 aborted. Error: Operation aborted before chunk processing started. <-- Aborted before starting
Chunk #5 aborted. Error: Operation aborted before chunk processing started.
... (Many more "aborted before chunk processing started" errors) ...

Batch processing complete!
Duration: 500+ms
Aborted: true
Total Items: 100, Successful: 15, Failed: 85 <-- Based on 3 successful chunks of 5 items

--- Final Results Summary ---
Total Chunks: 20, Successful: 3, Aborted/Failed: 17 (Aborted Error Count: 17)
*/