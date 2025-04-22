# Example 3: Real-World Database Operations (Mock)

This example shows how `BatchHandler` can be used to perform batch database operations, like inserting multiple records. It uses a mock database client to simulate async DB calls, concurrency control to manage connection pool usage, and basic error handling.

**Note:** Replace the `mockDbClient` with your actual database client (e.g., `node-postgres`, `mongodb`, `sequelize`, `prisma`).

```typescript
import {
  BatchHandler,
  HandlerResult,
  ProcessedItem,
  FailedItem,
  ExecutionContext,
} from 'batch-handler';

// --- Mock Database Client ---
// Replace this with your actual DB client import and setup
interface MockDbClient {
  insertMany: (records: readonly UserRecord[]) => Promise<{ insertedCount: number; errors: any[] }>;
}
const mockDbClient: MockDbClient = {
  insertMany: async (records) => {
    console.log(`DB Client: Inserting ${records.length} records...`);
    await new Promise(res => setTimeout(res, 75 + Math.random() * 50)); // Simulate DB latency

    // Simulate potential transient DB errors (e.g., connection issue)
    if (Math.random() < 0.1) { // 10% chance of failure
      console.error("DB Client: Simulated connection error!");
      throw new Error("DB_CONNECTION_ERROR");
    }

    // Simulate potential individual record errors (e.g., constraint violation)
    const errors: any[] = [];
    let insertedCount = 0;
    records.forEach(record => {
      if (record.email.includes('invalid')) { // Simulate constraint violation
         errors.push({ recordId: record.id, error: 'INVALID_EMAIL_FORMAT' });
      } else {
         insertedCount++;
      }
    });

    if (errors.length > 0) {
        console.warn(`DB Client: ${errors.length} record errors during insert.`);
    }
    console.log(`DB Client: Inserted ${insertedCount} records successfully.`);
    return { insertedCount, errors };
  },
};
// --- End Mock DB Client ---

// Sample data to insert
interface UserRecord { id: number; name: string; email: string; }
const usersToInsert: UserRecord[] = Array.from({ length: 30 }, (_, i) => ({
  id: i + 1,
  name: `User ${i + 1}`,
  email: (i + 1) % 10 === 0 ? `user${i+1}@invalid.com` : `user${i+1}@example.com`, // Make every 10th email invalid
}));
const chunkSize = 10;

// --- Configuration ---
const handler = new BatchHandler<UserRecord, { insertedId: number }>({
  concurrency: 3, // Limit concurrent inserts (e.g., based on connection pool size)
  retryOptions: {
    retries: 2,
    minTimeout: 200,
    retryOn: (error: any): boolean => {
      // Only retry specific DB errors (e.g., transient connection issues)
      if (error?.message === 'DB_CONNECTION_ERROR') {
        console.warn('Retrying chunk due to simulated DB connection error...');
        return true;
      }
      // Do not retry other errors (like constraint violations handled within the processor)
      return false;
    },
  },
});

// --- Processor Function ---
const dbInserter = async (
  chunk: readonly UserRecord[],
  ctx?: Readonly<ExecutionContext<UserRecord, { insertedId: number }>>
): Promise<HandlerResult<UserRecord, { insertedId: number }>> => {
  const attempt = ctx?.attempt ?? 1;
  console.log(`Attempt ${attempt}: Inserting records with IDs: [${chunk.map(u => u.id).join(', ')}] (Chunk #${ctx?.chunkIndex})`);

  try {
    // Call the actual database client method
    const dbResult = await mockDbClient.insertMany(chunk);

    // Process the DB result to fit HandlerResult structure
    const successes: ProcessedItem<UserRecord, { insertedId: number }>[] = [];
    const failures: FailedItem<UserRecord>[] = [];

    // Assume dbResult.errors contains info about which records failed if the overall call succeeded
    const failedIds = new Set(dbResult.errors.map(e => e.recordId));

    for (const record of chunk) {
      if (failedIds.has(record.id)) {
        const dbError = dbResult.errors.find(e => e.recordId === record.id)?.error || 'Unknown DB Error';
        failures.push({ item: record, error: new Error(`DB Insert Failed: ${dbError}`) });
      } else {
        // If not in errors, assume success for this record
        successes.push({ item: record, result: { insertedId: record.id } });
      }
    }

    // If the insertMany itself threw (e.g., connection error), this part won't be reached.
    // The error will be caught below and potentially retried.
    return { successes, failures };

  } catch (error: any) {
    console.error(`Attempt ${attempt} failed for chunk #${ctx?.chunkIndex} [IDs: ${chunk.map(u => u.id).join(', ')}]: ${error.message}`);
    // Re-throw the error (e.g., DB_CONNECTION_ERROR) to let BatchHandler retry/fail the chunk
    throw error;
  }
};

// --- Event Listeners (Optional) ---
handler.on('onProgress', (ctx) => {
  const progress = (ctx.processedChunks / ctx.totalChunks) * 100;
  console.log(`Progress: ${ctx.processedChunks}/${ctx.totalChunks} chunks (${progress.toFixed(0)}%). Items Succeeded: ${ctx.successfulItems}, Failed: ${ctx.failedItems}`);
});

handler.on('onComplete', (ctx) => {
  console.log(`\nDB Insertion Complete! Duration: ${ctx.durationMs}ms. Total Items: ${ctx.totalItems}, Succeeded: ${ctx.successfulItems}, Failed: ${ctx.failedItems}`);
});

// --- Execute ---
async function runDbInsertion() {
  console.log(`Inserting ${usersToInsert.length} user records with chunk size ${chunkSize} and concurrency ${handler.options.concurrency}...`);
  const results = await handler.execute(usersToInsert, chunkSize, dbInserter);

  console.log('\n--- Final Summary ---');
  const totalSucceeded = results.reduce((sum, r) => sum + r.successes.length, 0);
  const totalFailed = results.reduce((sum, r) => sum + r.failures.length, 0);

  console.log(`Total DB Records Processed: ${totalSucceeded + totalFailed}`);
  console.log(`Successfully Inserted (or marked as success): ${totalSucceeded}`);
  console.log(`Failed Items (DB error or Chunk failure): ${totalFailed}`);

  if (totalFailed > 0) {
      console.log("Failed items details:");
      results.forEach(r => {
          r.failures.forEach(f => console.log(`  - Item ID ${f.item.id}: ${f.error.message}`));
      });
  }
}

runDbInsertion();