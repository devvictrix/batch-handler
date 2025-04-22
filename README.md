# BatchHandler

[![npm version](https://badge.fury.io/js/batch-handler.svg)](https://badge.fury.io/js/batch-handler)

A simple yet powerful Node.js utility for processing arrays or streams of items in batches with fine-grained control over concurrency, retries, rate limiting, cancellation, and progress reporting.

Designed for reliability and developer experience, `batch-handler` helps you manage complex asynchronous workflows like API interactions, database operations, file processing, and more, without getting bogged down in boilerplate logic.

## Why BatchHandler?

Handling large sets of asynchronous tasks efficiently and reliably in Node.js can be complex. You often need to:

*   **Limit Concurrency:** Avoid overwhelming downstream systems (APIs, databases), manage resource usage (memory, CPU, network sockets), or adhere to connection pool limits.
*   **Implement Retries:** Gracefully handle transient network errors or temporary service unavailability with configurable backoff strategies.
*   **Control Flow:** Process items in manageable chunks, potentially rate-limit requests.
*   **Handle Failures:** Distinguish between item-level failures (e.g., invalid data) and chunk-level failures (e.g., timeout, network error), reporting them accurately.
*   **Enable Cancellation:** Allow long-running jobs to be stopped gracefully.
*   **Monitor Progress:** Get visibility into how the batch job is progressing.

`BatchHandler` provides a clean, unified API to manage all these concerns, leveraging robust libraries like `p-limit` and `p-retry` internally.

## Key Features

*   **⚙️ Configurable Concurrency:** Easily limit the number of chunks processed in parallel (`p-limit`).
*   **🔁 Advanced Retries:** Automatic retries for failed chunks with exponential backoff, jitter, custom timeout limits, and conditional logic (`retryOn`) powered by `p-retry`.
*   **⏱️ Rate Limiting:** Optional delay between starting consecutive chunks.
*   **🛑 Graceful Cancellation:** Supports `AbortSignal` to cancel operations cleanly.
*   **🎯 Chunk Timeouts:** Set an overall time limit for processing a single chunk (including retries).
*   **✨ Middleware Support:** Inject custom logic (logging, metrics, context enrichment) into the processing pipeline using `handler.use()`.
*   **📣 Event Emitter:** Hook into lifecycle events (`onStart`, `onProgress`, `onRetry`, `onChunkSuccess`, `onChunkFailure`, `onComplete`) for monitoring and side effects.
*   **📊 Clear Results:** Provides detailed results per chunk, distinguishing between successful items, handler-reported item failures, and chunk-level errors.
*   **🔌 I/O Agnostic:** Process *any* asynchronous operation wrapped in the handler function – API calls (Axios, fetch), database queries (Postgres, MongoDB, Prisma), file system operations, message queue publishing, gRPC/GraphQL requests, etc.
*   **🛡️ TypeScript Native:** Written in TypeScript with comprehensive type definitions for excellent developer experience.

## Installation

```bash
npm install batch-handler
# or
yarn add batch-handler
# or
pnpm add batch-handler
```

## Quick Start

Process an array of numbers, converting them to strings, in chunks of 5.

```typescript
import { BatchHandler, HandlerResult, ProcessedItem, FailedItem } from 'batch-handler';

const items = Array.from({ length: 10 }, (_, i) => i + 1); // [1...10]

const handler = new BatchHandler<number, string>();

handler.on('onProgress', ({ processedChunks, totalChunks }) => {
  console.log(`Progress: ${processedChunks}/${totalChunks} chunks`);
});

handler.on('onComplete', ({ durationMs, successfulItems, failedItems }) => {
  console.log(`Done in ${durationMs}ms! Success: ${successfulItems}, Failed: ${failedItems}`);
});

async function run() {
  const results = await handler.execute(
    items,
    5, // Chunk size
    async (chunk): Promise<HandlerResult<number, string>> => {
      console.log(`Processing chunk: ${chunk}`);
      await new Promise(res => setTimeout(res, 100)); // Simulate async work

      const successes: ProcessedItem<number, string>[] = [];
      const failures: FailedItem<number>[] = [];

      for (const item of chunk) {
        if (item === 7) { // Simulate failure for item 7
          failures.push({ item, error: new Error('Item 7 is unlucky') });
        } else {
          successes.push({ item, result: `Item-${item}` });
        }
      }
      return { successes, failures };
    }
  );

  // results is an array of BatchResult<number, string>
  console.log('Detailed Results:', JSON.stringify(results, null, 2));
}

run();
```

➡️ See more detailed examples in the `examples/` directory!

## Core Concepts

**BatchHandler<I, O>:** The main class instance configured with options. I is the input item type, O is the output type for a single successful item.

**chunkSize:** The number of items from the input array processed together in one call to your handler function.

**BatchProcessorFn<I, O>:** Your async function `(async (chunk, ctx?) => ...)` that processes a chunk (`readonly` array of I) and must return a `Promise<HandlerResult<I, O>>`. It can optionally receive an `ExecutionContext` object.

**HandlerResult<I, O>:** The object your `BatchProcessorFn` must resolve with:
- `successes: ProcessedItem<I, O>[]` — Array of items successfully processed within the chunk.
- `failures: FailedItem<I>[]` — Array of items that failed processing within the chunk (e.g., validation error), along with the corresponding error.

**BatchResult<I, O>:** The result object returned for each chunk in the final array from `handler.execute()`:
- `chunkIndex: number` — Index of the chunk.
- `items: Readonly<I[]>` — The original items in the chunk.
- `success: boolean` — `true` if the `BatchProcessorFn` resolved successfully (after retries); `false` if it ultimately failed (e.g., timeout, non-retriable error after all retries, abort signal).
- `successes: ProcessedItem<I, O>[]` — Populated only if `success` is `true`. Contains successes reported by your handler.
- `failures: FailedItem<I>[]` — If `success` is `true`, contains failures reported by your handler. If `success` is `false`, contains *all* items from the chunk, marked with the chunk-level error.
- `error?: any` — The chunk-level error if `success` is `false`.

**ExecutionContext<I, O>:** Context object passed to the `BatchProcessorFn` (optional second argument) and event listeners/middleware. Contains `chunkIndex`, `items`, `attempt` number, `options`, `signal`, and potentially `error` or `data` depending on the stage/event.

## Configuration Options

Pass an options object to the `BatchHandler` constructor:
```ts
new BatchHandler(options)
```
```ts
interface BatchHandlerOptions<I, O> {
  /** Max concurrent chunk processors. Default: 5. */
  concurrency?: number;
  /** Milliseconds delay between starting chunks. Default: 0. */
  rateLimit?: number;
  /** Overall ms timeout for a single chunk (incl. retries). Default: undefined. */
  timeout?: number;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
  /** Retry settings (p-retry options). */
  retryOptions?: Partial<{
    retries: number; // Default: 3
    factor: number; // Default: 2
    minTimeout: number; // Default: 1000 ms
    maxTimeout?: number; // Default: Infinity
    jitter?: boolean; // Default: true
    /** Function `(error) => boolean | Promise<boolean>` to decide if retry occurs. Default: `() => true` */
    retryOn?: (error: any) => boolean | Promise<boolean>;
  }>;
}
```

## Events

Listen to events using:
```ts
handler.on('eventName', (ctx) => { ... });
```

| Event            | Context Type            | Description                                                                                  |
| ---------------- | ----------------------- | -------------------------------------------------------------------------------------------- |
| `onStart`        | `ExecutionContext`      | Before a chunk starts processing (after rate limit, before 1st attempt).                     |
| `onRetry`        | `ExecutionContext`      | When a chunk attempt fails and a retry is scheduled. `ctx.error` has the error.               |
| `onChunkSuccess` | `ExecutionContext`      | After a chunk handler successfully resolves (after all retries). `ctx.data` has HandlerResult.|
| `onChunkFailure` | `ExecutionContext`      | After a chunk fails definitively. `ctx.error` has the final error.                           |
| `onProgress`     | `ProgressContext`       | After each chunk finishes (success or failure). Has aggregate counts.                         |
| `onComplete`     | `CompletionContext`     | After all chunks are processed or aborted. Has final summary and aborted status.              |

See type definitions (`ExecutionContext`, `ProgressContext`, `CompletionContext`) for details on context properties.

## Middleware

Add custom logic using:
```ts
handler.use(middlewareFn);
```

```ts
type Middleware<I, O> = (
  ctx: ExecutionContext<I, O>,
  next: () => Promise<void>
) => Promise<void>;

// Example: Simple logger middleware
handler.use(async (ctx, next) => {
  console.log(`Attempt ${ctx.attempt} for chunk ${ctx.chunkIndex} starting...`);
  try {
    await next(); // MUST call next() to proceed
    console.log(`Chunk ${ctx.chunkIndex} attempt ${ctx.attempt} succeeded.`);
  } catch (err) {
    console.error(`Chunk ${ctx.chunkIndex} attempt ${ctx.attempt} failed: ${err}`);
    throw err; // MUST re-throw error
  }
});
```

Middleware functions run in the order added for each chunk attempt before the core retry logic begins.
See `examples/06-custom-middleware.md` for more.

## Examples
- [Basic Usage](./examples/01-basic-usage.md): Fundamental processing and result handling.
- [API Requests (Axios)](./examples/02-axios-api-requests.md): Fetching data from an API with concurrency and HTTP error retries. (Intermediate)
- [Database Operations (Mock)](./examples/03-database-operations.md): Batch inserting records with concurrency and DB error handling. (Intermediate)
- [Advanced Retries (retryOn)](./examples/04-advanced-retries.md): Conditionally retrying based on specific error types. (Advanced)
- [Cancellation (AbortSignal)](./examples/05-abort-signal.md): Gracefully stopping a batch job. (Intermediate)
- [Custom Middleware](./examples/06-custom-middleware.md): Adding logging and timing middleware. (Advanced)

BatchHandler is not limited to HTTP. Use it with any async I/O: files, queues, gRPC, WebSockets, etc.

## Contributing

Contributions (bug reports, feature requests) are welcome!

## License

MIT

