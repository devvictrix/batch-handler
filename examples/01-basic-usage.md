# Example 1: Basic Usage

This example demonstrates the fundamental usage of `BatchHandler` to process an array of numbers in chunks.

```typescript
import { BatchHandler, HandlerResult, ProcessedItem, FailedItem } from 'batch-handler';

// Sample data
const itemsToProcess: number[] = Array.from({ length: 25 }, (_, i) => i + 1); // [1, 2, ..., 25]
const chunkSize = 5;

// Create a handler instance with default options
const handler = new BatchHandler<number, string>();

// Define the processor function (must return Promise<HandlerResult>)
const simpleProcessor = async (
  chunk: readonly number[]
): Promise<HandlerResult<number, string>> => {
  console.log(`Processing chunk: [${chunk.join(', ')}]`);
  await new Promise(res => setTimeout(res, 50)); // Simulate async work

  const successes: ProcessedItem<number, string>[] = [];
  const failures: FailedItem<number>[] = [];

  for (const item of chunk) {
    if (item % 7 === 0) {
      // Simulate a failure for items divisible by 7
      failures.push({ item, error: new Error(`Item ${item} is divisible by 7`) });
    } else {
      successes.push({ item, result: `Processed item ${item}` });
    }
  }

  // Return successes and failures *handled* within this chunk
  return { successes, failures };
};

// --- Event Listeners (Optional) ---
handler.on('onProgress', (ctx) => {
  const progress = (ctx.processedChunks / ctx.totalChunks) * 100;
  console.log(`Progress: ${ctx.processedChunks}/${ctx.totalChunks} chunks (${progress.toFixed(0)}%). Items: ${ctx.processedItems}/${ctx.totalItems}. Success: ${ctx.successfulItems}, Fail: ${ctx.failedItems}`);
});

handler.on('onComplete', (ctx) => {
  console.log(`\nBatch processing complete!`);
  console.log(`Duration: ${ctx.durationMs}ms`);
  console.log(`Total Items: ${ctx.totalItems}, Successful: ${ctx.successfulItems}, Failed: ${ctx.failedItems}`);
  console.log(`Aborted: ${ctx.aborted}`);
});

// --- Execute ---
async function run() {
  console.log(`Starting batch processing for ${itemsToProcess.length} items with chunk size ${chunkSize}...`);
  try {
    const results = await handler.execute(itemsToProcess, chunkSize, simpleProcessor);

    console.log('\n--- Detailed Results ---');
    results.forEach(result => {
      console.log(`Chunk #${result.chunkIndex} (Success: ${result.success}):`);
      if (result.success) {
        result.successes.forEach(s => console.log(`  ✅ Item ${s.item}: ${s.result}`));
        result.failures.forEach(f => console.log(`  ❌ Item ${f.item}: ${f.error.message}`));
      } else {
        // Chunk itself failed (e.g., timeout, retry failure)
        console.log(`  🔥 Chunk Failed! Items: [${result.items.join(', ')}]. Error: ${result.error}`);
        // All items in a failed chunk are marked as failures in the result
        result.failures.forEach(f => console.log(`     Item ${f.item} marked failed due to chunk error.`));
      }
    });

  } catch (error) {
    console.error('An unexpected error occurred during execute:', error);
  }
}

run();

/* Expected Output (simplified):
Starting batch processing for 25 items with chunk size 5...
Processing chunk: [1, 2, 3, 4, 5]
Progress: 1/5 chunks (20%). Items: 5/25. Success: 5, Fail: 0
Processing chunk: [6, 7, 8, 9, 10]
Progress: 2/5 chunks (40%). Items: 10/25. Success: 9, Fail: 1
Processing chunk: [11, 12, 13, 14, 15]
Progress: 3/5 chunks (60%). Items: 15/25. Success: 13, Fail: 2
Processing chunk: [16, 17, 18, 19, 20]
Progress: 4/5 chunks (80%). Items: 20/25. Success: 18, Fail: 2
Processing chunk: [21, 22, 23, 24, 25]
Progress: 5/5 chunks (100%). Items: 25/25. Success: 22, Fail: 3

Batch processing complete!
Duration: ...ms
Total Items: 25, Successful: 22, Failed: 3
Aborted: false

--- Detailed Results ---
Chunk #0 (Success: true):
  ✅ Item 1: Processed item 1
  ✅ Item 2: Processed item 2
  ...
Chunk #1 (Success: true):
  ✅ Item 6: Processed item 6
  ❌ Item 7: Item 7 is divisible by 7
  ✅ Item 8: Processed item 8
  ...
Chunk #2 (Success: true):
  ...
  ❌ Item 14: Item 14 is divisible by 7
  ...
Chunk #3 (Success: true):
  ...
Chunk #4 (Success: true):
  ...
  ❌ Item 21: Item 21 is divisible by 7
  ...
*/