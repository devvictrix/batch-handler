# Example 2: Real-World API Requests (Axios)

This example demonstrates using `BatchHandler` to fetch data from an external API using Axios for batches of IDs. It showcases concurrency control to avoid overwhelming the API and retries for common transient HTTP errors.

**Note:** This example uses a mock API endpoint (`https://httpbin.org/anything/`) for demonstration. Replace it with your actual API endpoint. You'll need to install Axios: `npm install axios`

```typescript
import {
  BatchHandler,
  HandlerResult,
  ProcessedItem,
  FailedItem,
  ExecutionContext,
} from 'batch-handler';
import axios, { AxiosError } from 'axios'; // Import AxiosError

// Sample user IDs to fetch data for
const userIds = Array.from({ length: 15 }, (_, i) => i + 101); // [101, 102, ..., 115]
const chunkSize = 3; // Process 3 IDs per API call/chunk

// Mock API endpoint (replace with your actual API)
// This endpoint echoes the request data. We'll pretend it returns user data.
const API_ENDPOINT = 'https://httpbin.org/anything/';

// --- Configuration ---
const handler = new BatchHandler<number, { id: number; data: string }>({
  concurrency: 2, // Limit to 2 concurrent API calls
  retryOptions: {
    retries: 3, // Retry up to 3 times on failure
    minTimeout: 500, // Start with 500ms delay
    factor: 2, // Double delay each time
    retryOn: (error: any): boolean => {
      // Only retry on specific HTTP errors or network issues
      if (error instanceof AxiosError) {
        const status = error.response?.status;
        // Retry on server errors (5xx) or rate limiting (429)
        if (status && (status >= 500 || status === 429)) {
          console.warn(`Retrying chunk due to HTTP ${status} for item(s) starting with ${error.config?.data?.ids?.[0] ?? 'N/A'}...`);
          return true;
        }
        // Don't retry on client errors (4xx, excluding 429) or other Axios errors
        return false;
      }
      // Retry on generic network errors (e.g., ECONNREFUSED)
      if (error.code && ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'].includes(error.code)) {
         console.warn(`Retrying chunk due to network error ${error.code}...`);
         return true;
      }
      // Don't retry other error types
      return false;
    },
  },
});

// --- Processor Function ---
const apiFetcher = async (
  chunk: readonly number[], // Chunk of user IDs
  ctx?: Readonly<ExecutionContext<number, { id: number; data: string }>>
): Promise<HandlerResult<number, { id: number; data: string }>> => {
  const attempt = ctx?.attempt ?? 1;
  console.log(`Attempt ${attempt}: Fetching data for IDs: [${chunk.join(', ')}] (Chunk #${ctx?.chunkIndex})`);

  try {
    // Simulate making a single API call for the batch of IDs
    // Adjust payload structure based on your actual API
    const response = await axios.post(API_ENDPOINT, { ids: chunk });

    // Assuming the API returns data for each requested ID successfully
    // Adapt this based on your API's response structure
    const successes: ProcessedItem<number, { id: number; data: string }>[] = chunk.map((id) => ({
      item: id,
      // Extract or format result based on API response (response.data)
      result: { id, data: `User data for ${id} fetched via API on attempt ${attempt}` },
    }));

    return { successes, failures: [] };

  } catch (error: any) {
    console.error(`Attempt ${attempt} failed for chunk #${ctx?.chunkIndex} [${chunk.join(', ')}]: ${error.message}`);
    // Let BatchHandler's retry logic handle this based on `retryOn`
    throw error; // Re-throw the error to trigger retry/failure logic
  }
};

// --- Event Listeners (Optional) ---
handler.on('onRetry', (ctx) => {
  console.log(`Scheduled retry for chunk #${ctx.chunkIndex} after attempt ${ctx.attempt} failed. Error: ${ctx.error?.message}`);
});

handler.on('onChunkFailure', (ctx) => {
  console.error(`Chunk #${ctx.chunkIndex} FAILED definitively after ${ctx.attempt} attempts. Error: ${ctx.error}`);
});

handler.on('onComplete', (ctx) => {
  console.log(`\nAPI Fetching Complete! Duration: ${ctx.durationMs}ms. Success: ${ctx.successfulItems}, Fail: ${ctx.failedItems}`);
});

// --- Execute ---
async function runApiFetching() {
  console.log(`Fetching data for ${userIds.length} users with chunk size ${chunkSize} and concurrency ${handler.options.concurrency}...`);
  const results = await handler.execute(userIds, chunkSize, apiFetcher);

  console.log('\n--- Final Results ---');
  // Process results (e.g., collect all successful user data)
  const allUserData = results
    .filter(r => r.success)
    .flatMap(r => r.successes)
    .map(s => s.result);

  const allFailedItems = results.flatMap(r => r.failures);

  console.log(`Successfully fetched data for ${allUserData.length} users.`);
  // console.log(allUserData);
  if (allFailedItems.length > 0) {
    console.log(`Failed to process ${allFailedItems.length} items:`);
    allFailedItems.forEach(f => console.log(`  - Item ${f.item}: ${f.error.message}`));
  }
}

runApiFetching();