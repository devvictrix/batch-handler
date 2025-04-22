// src/index.test.ts

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import {
  BatchHandler,
  HandlerResult,
  ProcessedItem,
  FailedItem,
  ExecutionContext,
  ProgressContext,
  CompletionContext,
} from './index.js';
import { AbortError } from 'p-retry';

describe('BatchHandler', () => {
  let handler: BatchHandler<number, string>;
  const baseItems = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const defaultChunkSize = 3;

  // Default successful processor
  // Provide explicit types for the mock function
  const successProcessor = jest.fn<
    (chunk: readonly number[]) => Promise<HandlerResult<number, string>>
  >(
    async (
      chunk: readonly number[]
    ): Promise<HandlerResult<number, string>> => {
      await new Promise((res) => setTimeout(res, 10)); // Simulate async work with real timer
      const successes: ProcessedItem<number, string>[] = chunk.map((item) => ({
        item,
        result: `Processed ${item}`,
      }));
      return { successes, failures: [] };
    }
  );

  // Processor that fails based on item value
  // Provide explicit types for the mock function
  const conditionalFailProcessor = jest.fn<
    (
      chunk: readonly number[],
      ctx?: Readonly<ExecutionContext<number, string>>
    ) => Promise<HandlerResult<number, string>>
  >(
    async (
      chunk: readonly number[],
      ctx?: Readonly<ExecutionContext<number, string>>
    ): Promise<HandlerResult<number, string>> => {
      await new Promise((res) => setTimeout(res, 15)); // Simulate async work with real timer
      const successes: ProcessedItem<number, string>[] = [];
      const failures: FailedItem<number>[] = [];
      let shouldThrow = false; // Flag to throw outside the loop if needed
      let thrownError: any = null;

      for (const item of chunk) {
        if (item === 5) {
          // Fail item 5 (handler-level failure)
          failures.push({
            item,
            error: new Error(`Item ${item} failed validation`),
          });
        } else if (item === 7 && ctx?.attempt === 1) {
          // Fail item 7 on first attempt only (retriable chunk failure)
          shouldThrow = true;
          thrownError = new Error(`Item ${item} failed temporarily`);
          break; // Stop processing this chunk, throw the error
        } else if (item === 9) {
          // Fail item 9 permanently (non-retriable chunk failure)
          const err = new Error(`Item ${item} failed permanently`);
          (err as any).nonRetriable = true;
          shouldThrow = true;
          thrownError = err;
          break; // Stop processing this chunk, throw the error
        } else {
          successes.push({
            item,
            result: `Processed ${item} on attempt ${ctx?.attempt ?? 'N/A'}`,
          });
        }
      } // End for loop

      if (shouldThrow) {
        throw thrownError;
      }

      return { successes, failures };
    }
  );

  beforeEach(() => {
    // Reset mocks before each test
    successProcessor.mockClear();
    conditionalFailProcessor.mockClear();
    // Default handler for most tests
    handler = new BatchHandler<number, string>();
  });

  // --- Core Execution ---
  it('should process all items in correct chunk sizes', async () => {
    const results = await handler.execute(
      baseItems,
      defaultChunkSize,
      successProcessor
    );
    expect(results).toHaveLength(4);
    expect(results[0].items).toEqual([1, 2, 3]);
    expect(results[1].items).toEqual([4, 5, 6]);
    expect(results[2].items).toEqual([7, 8, 9]);
    expect(results[3].items).toEqual([10]);
    expect(successProcessor).toHaveBeenCalledTimes(4);
  });

  it('should return correct success/failure status and data for successful chunks', async () => {
    const results = await handler.execute([1, 2], 2, successProcessor);
    expect(results[0].success).toBe(true);
    expect(results[0].error).toBeUndefined();
    expect(results[0].successes).toHaveLength(2);
    expect(results[0].failures).toHaveLength(0);
    expect(results[0].successes[0].item).toBe(1);
    expect(results[0].successes[0].result).toBe('Processed 1');
  });

  it('should handle empty input array', async () => {
    const results = await handler.execute(
      [],
      defaultChunkSize,
      successProcessor
    );
    expect(results).toEqual([]);
    expect(successProcessor).not.toHaveBeenCalled();
  });

  it('should throw error for invalid chunk size', async () => {
    await expect(
      handler.execute(baseItems, 0, successProcessor)
    ).rejects.toThrow('chunkSize must be greater than 0');
    await expect(
      handler.execute(baseItems, -1, successProcessor)
    ).rejects.toThrow('chunkSize must be greater than 0');
  });

  // --- Concurrency ---
  it('should limit concurrency', async () => {
    const concurrencyLimit = 2;
    handler = new BatchHandler<number, string>({
      concurrency: concurrencyLimit,
    });
    let currentProcessing = 0;
    let maxProcessing = 0;

    const slowProcessor = jest.fn<
      (chunk: readonly number[]) => Promise<HandlerResult<number, string>>
    >(async (chunk) => {
      currentProcessing++;
      maxProcessing = Math.max(maxProcessing, currentProcessing);
      await new Promise((res) => setTimeout(res, 50)); // Longer delay with real timer
      currentProcessing--;
      const successes: ProcessedItem<number, string>[] = chunk.map((item) => ({
        item,
        result: `Processed ${item}`,
      }));
      return { successes, failures: [] };
    });

    await handler.execute(baseItems, defaultChunkSize, slowProcessor); // Await the execution directly
    // REMOVED timer advancement loops

    expect(maxProcessing).toBe(concurrencyLimit);
    expect(slowProcessor).toHaveBeenCalledTimes(4); // Will be called 4 times for 10 items / chunk 3
  });

  // --- Retries ---
  it('should retry chunks that throw retriable errors', async () => {
    handler = new BatchHandler<number, string>({
      retryOptions: { retries: 1, minTimeout: 5 }, // Use short real timeout
    });
    const results = await handler.execute([7], 1, conditionalFailProcessor);
    expect(conditionalFailProcessor).toHaveBeenCalledTimes(2);
    expect(results[0].success).toBe(true);
    expect(results[0].successes).toHaveLength(1);
    expect(results[0].successes[0].result).toContain('attempt 2');
  });

  it('should not retry chunks if retryOn returns false', async () => {
    handler = new BatchHandler<number, string>({
      retryOptions: {
        retries: 2,
        minTimeout: 5, // Use short real timeout
        retryOn: (error: any) => !error.nonRetriable,
      },
    });
    const results = await handler.execute([9], 1, conditionalFailProcessor);
    expect(conditionalFailProcessor).toHaveBeenCalledTimes(1);
    expect(results[0].success).toBe(false);
    // Error thrown by p-retry when retryOn returns false is AbortError
    expect(results[0].error).toBeInstanceOf(AbortError);
    expect((results[0].error as AbortError)?.originalError?.message).toContain(
      'Item 9 failed permanently'
    );
  });

  it('should fail chunk after exhausting retries', async () => {
    const failingProcessor = jest
      .fn<
        (chunk: readonly number[]) => Promise<HandlerResult<number, string>>
      >()
      .mockRejectedValue(new Error(`Chunk failed`));

    handler = new BatchHandler<number, string>({
      retryOptions: { retries: 2, minTimeout: 5 }, // Use short real timeout
    });
    const results = await handler.execute([1, 2], 2, failingProcessor);
    expect(failingProcessor).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    expect(results[0].success).toBe(false);
    expect(results[0].error?.message).toContain('Chunk failed');
  });

  // --- Abort Signal ---
  it('should stop processing new chunks when signal aborts early', async () => {
    const abortController = new AbortController();
    handler = new BatchHandler<number, string>({
      concurrency: 1,
      signal: abortController.signal,
    });
    const promise = handler.execute(
      baseItems,
      defaultChunkSize,
      successProcessor
    );

    // Abort after a short delay to allow the first chunk to start
    await new Promise((res) => setTimeout(res, 5));
    abortController.abort();

    const results = await promise; // Await the completion

    // With concurrency 1, only the first chunk should attempt to process
    // The abort signal stops p-limit from scheduling more.
    // The promise returned by execute() resolves with results for *all* chunks,
    // but those not started or aborted early will have success=false and an AbortError.
    expect(successProcessor).toHaveBeenCalledTimes(1); // Only the first chunk runs
    expect(results.length).toBe(4); // Still get results for all potential chunks

    // The first chunk might succeed or fail depending on timing vs abort
    // If it succeeds, it should have completed before the abort signal was fully processed by p-retry/handler
    // If it fails, it means abort happened during its execution
    // Let's check if it *didn't* succeed (more robust test) or failed with AbortError
    if (results[0].success === false) {
      expect(results[0].error?.name).toBe('AbortError'); // Check name
    }
    // Subsequent chunks definitely fail due to abort
    expect(results[1].success).toBe(false);
    expect(results[1].error?.name).toBe('AbortError'); // Check name
    expect(results[2].success).toBe(false);
    expect(results[2].error?.name).toBe('AbortError'); // Check name
    expect(results[3].success).toBe(false);
    expect(results[3].error?.name).toBe('AbortError'); // Check name
  });

  it('should respect abort signal during processing and report correctly', async () => {
    const ac = new AbortController();
    const h = new BatchHandler<number, string>({
      concurrency: 1,
      signal: ac.signal,
    });
    let completionCtx: CompletionContext<number, string> | null = null;
    h.on('onComplete', (ctx: Readonly<CompletionContext<number, string>>) => {
      completionCtx = ctx;
    });

    const slowProcessor = jest.fn<
      (chunk: readonly number[]) => Promise<HandlerResult<number, string>>
    >(async (chunk) => {
      await new Promise((res) => setTimeout(res, 30)); // Real delay
      if (ac.signal.aborted)
        throw new AbortError('Aborted during handler execution');
      // Abort during the processing of the second chunk (items [4,5,6])
      if (chunk.includes(4)) {
        ac.abort();
        // Add a tiny delay to ensure abort status propagates if needed
        await new Promise((res) => setTimeout(res, 5));
        // Check again, p-retry should ideally pick this up, but throw defensively
        if (ac.signal.aborted)
          throw new AbortError('Aborted just after signal set');
      }
      const successes: ProcessedItem<number, string>[] = chunk.map((item) => ({
        item,
        result: `Processed ${item}`,
      }));
      return { successes, failures: [] };
    });

    const promise = h.execute(baseItems, defaultChunkSize, slowProcessor);
    const results = await promise;

    expect(slowProcessor).toHaveBeenCalledTimes(2); // First chunk completes, second starts and aborts
    expect(results[0].success).toBe(true); // First chunk should succeed
    expect(results[1].success).toBe(false); // Second chunk aborted
    expect(results[1].error?.name).toBe('AbortError'); // Check name
    expect(results[2].success).toBe(false); // Third chunk never ran or aborted early
    expect(results[2].error?.name).toBe('AbortError'); // Check name
    expect(results[3].success).toBe(false); // Fourth chunk never ran or aborted early
    expect(results[3].error?.name).toBe('AbortError'); // Check name

    expect(completionCtx).not.toBeNull();
    expect(completionCtx!.aborted).toBe(true); // Check completion status
  });

  // --- Error Reporting ---
  it('should report chunk errors in BatchResult', async () => {
    const failingProcessor = jest
      .fn<
        (chunk: readonly number[]) => Promise<HandlerResult<number, string>>
      >()
      .mockRejectedValue(new Error('Chunk processing failed'));

    handler = new BatchHandler<number, string>({
      retryOptions: { retries: 0 },
    });
    const results = await handler.execute([1, 2], 2, failingProcessor);
    expect(results[0].success).toBe(false);
    expect(results[0].error?.message).toBe('Chunk processing failed');
    // When chunk fails, all items in that chunk are marked as failed with the chunk error
    expect(results[0].failures).toHaveLength(2);
    expect(results[0].failures[0].item).toBe(1);
    expect(results[0].failures[0].error.message).toBe(
      'Chunk processing failed'
    );
    expect(results[0].failures[1].item).toBe(2);
    expect(results[0].failures[1].error.message).toBe(
      'Chunk processing failed'
    );
  });

  it('should report item-level failures returned by handler', async () => {
    handler = new BatchHandler<number, string>({
      retryOptions: { retries: 0 },
    });
    const results = await handler.execute(
      [4, 5, 6],
      3,
      conditionalFailProcessor
    );
    expect(results[0].success).toBe(true); // Chunk itself succeeded
    expect(results[0].error).toBeUndefined();
    expect(results[0].successes).toHaveLength(2); // Items 4 and 6 succeeded
    expect(results[0].failures).toHaveLength(1); // Item 5 failed per handler logic
    expect(results[0].failures[0].item).toBe(5);
    expect(results[0].failures[0].error.message).toBe(
      'Item 5 failed validation'
    );
  });

  // --- Events ---
  it('should emit onProgress after each chunk', async () => {
    const onProgressMock =
      jest.fn<(ctx: Readonly<ProgressContext<number, string>>) => void>();
    handler.on('onProgress', onProgressMock);

    await handler.execute(baseItems, defaultChunkSize, successProcessor); // Await completion

    expect(onProgressMock).toHaveBeenCalledTimes(4); // Called after each of the 4 chunks
    // Check the final progress event call
    const lastCallArgs = onProgressMock.mock.calls[3][0] as ProgressContext<
      number,
      string
    >;
    expect(lastCallArgs.processedChunks).toBe(4);
    expect(lastCallArgs.totalChunks).toBe(4);
    expect(lastCallArgs.processedItems).toBe(10); // 3+3+3+1
    expect(lastCallArgs.totalItems).toBe(10);
    expect(lastCallArgs.successfulItems).toBe(10); // Based on successProcessor
    expect(lastCallArgs.failedItems).toBe(0);
  });

  it('should emit onComplete with final summary', async () => {
    const onCompleteMock =
      jest.fn<(ctx: Readonly<CompletionContext<number, string>>) => void>();
    handler.on('onComplete', onCompleteMock);

    const startTime = Date.now();
    await handler.execute(baseItems, defaultChunkSize, successProcessor); // Await completion
    const endTime = Date.now();

    expect(onCompleteMock).toHaveBeenCalledTimes(1);
    const args = onCompleteMock.mock.calls[0][0] as CompletionContext<
      number,
      string
    >;
    expect(args.processedChunks).toBe(4);
    expect(args.totalChunks).toBe(4);
    expect(args.successfulItems).toBe(10);
    expect(args.failedItems).toBe(0);
    expect(args.totalItems).toBe(10);
    // Duration check might be flaky, ensure it's non-negative
    expect(args.durationMs).toBeGreaterThanOrEqual(0);
    expect(args.durationMs).toBeLessThanOrEqual(endTime - startTime + 50); // Allow some buffer
    expect(args.aborted).toBe(false);
  });

  it('should emit onRetry when a chunk is retried', async () => {
    const onRetryMock =
      jest.fn<(ctx: Readonly<ExecutionContext<number, string>>) => void>();
    handler = new BatchHandler<number, string>({
      retryOptions: { retries: 1, minTimeout: 5 }, // Use short real timeout
    });
    handler.on('onRetry', onRetryMock);

    await handler.execute([7], 1, conditionalFailProcessor); // Await completion

    expect(onRetryMock).toHaveBeenCalledTimes(1); // Item 7 fails once, triggers one retry
    const args = onRetryMock.mock.calls[0][0] as ExecutionContext<
      number,
      string
    >;
    expect(args.chunkIndex).toBe(0);
    expect(args.attempt).toBe(1); // The attempt *that failed* was attempt 1
    expect(args.error?.message).toContain('Item 7 failed temporarily');
  });

  it('should emit onChunkSuccess for successful chunks', async () => {
    const onSuccessMock =
      jest.fn<(ctx: Readonly<ExecutionContext<number, string>>) => void>();
    handler.on('onChunkSuccess', onSuccessMock);

    await handler.execute([1, 2], 2, successProcessor); // Await completion

    expect(onSuccessMock).toHaveBeenCalledTimes(1);
    const args = onSuccessMock.mock.calls[0][0] as ExecutionContext<
      number,
      string
    >;
    expect(args.chunkIndex).toBe(0);
    expect(args.items).toEqual([1, 2]);
    expect(args.data?.successes).toHaveLength(2);
    expect(args.error).toBeUndefined(); // Should not have error on success
  });

  it('should emit onChunkFailure for failed chunks', async () => {
    const onFailureMock =
      jest.fn<(ctx: Readonly<ExecutionContext<number, string>>) => void>();
    const failingProcessor = jest
      .fn<
        (chunk: readonly number[]) => Promise<HandlerResult<number, string>>
      >()
      .mockRejectedValue(new Error('Failed hard'));

    handler = new BatchHandler<number, string>({
      retryOptions: { retries: 0 },
    });
    handler.on('onChunkFailure', onFailureMock);

    await handler.execute([1, 2], 2, failingProcessor); // Await completion

    expect(onFailureMock).toHaveBeenCalledTimes(1);
    const args = onFailureMock.mock.calls[0][0] as ExecutionContext<
      number,
      string
    >;
    expect(args.chunkIndex).toBe(0);
    expect(args.items).toEqual([1, 2]);
    expect(args.error?.message).toBe('Failed hard');
    expect(args.data).toBeUndefined(); // Should not have data on failure
  });

  // --- Timeout ---
  it('should fail chunk if timeout is exceeded', async () => {
    const timeoutMs = 50; // Short real timeout
    const longProcessor = jest.fn<
      (chunk: readonly number[]) => Promise<HandlerResult<number, string>>
    >(async (chunk) => {
      await new Promise((res) => setTimeout(res, timeoutMs + 30)); // Ensure it exceeds timeout
      // This part shouldn't be reached if timeout works
      const successes: ProcessedItem<number, string>[] = chunk.map((item) => ({
        item,
        result: `Processed ${item}`,
      }));
      return { successes: [], failures: [] }; // Return dummy data
    });

    handler = new BatchHandler<number, string>({
      timeout: timeoutMs,
      retryOptions: { retries: 0 }, // No retries for simplicity
    });

    const results = await handler.execute([1], 1, longProcessor); // Await completion

    expect(longProcessor).toHaveBeenCalledTimes(1); // Processor is called once
    expect(results[0].success).toBe(false); // Chunk should fail
    expect(results[0].error).toBeInstanceOf(AbortError); // p-retry timeout throws AbortError
    expect(results[0].error?.message).toContain(
      `timed out after ${timeoutMs}ms`
    ); // Check error message
    // Check name as well for robustness
    expect(results[0].error?.name).toBe('AbortError');
  });
});
