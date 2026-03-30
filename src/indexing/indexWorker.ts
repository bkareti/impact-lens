import { parentPort, workerData } from 'worker_threads';
import * as fs from 'fs';
import { parseFile, classifyFile } from './fileParser';
import {
  WorkerMessageType,
  MetadataType,
  ParsedFile,
} from '../models/searchResult';

interface FileEntry {
  path: string;
  metadataType?: MetadataType;
}

interface WorkerInput {
  files: FileEntry[];
  maxFileSize: number;
}

/**
 * Worker thread entry point.
 * Receives a list of file paths, parses each, and sends results back.
 */
function run(): void {
  const input = workerData as WorkerInput;
  const { files, maxFileSize } = input;
  const results: ParsedFile[] = [];
  const errors: Array<{ file: string; error: string }> = [];
  const batchSize = 50;
  let processed = 0;

  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);

    for (const entry of batch) {
      try {
        // Check file size before reading
        const stat = fs.statSync(entry.path);
        if (stat.size > maxFileSize) {
          continue; // Skip oversized files
        }

        const content = fs.readFileSync(entry.path, 'utf-8');
        const metadataType = entry.metadataType ?? classifyFile(entry.path);
        const parsed = parseFile(entry.path, content, metadataType);

        // Don't send full content back to save memory
        results.push({
          ...parsed,
          content: '', // Strip content; index will store separately if needed
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ file: entry.path, error: message });
      }

      processed++;
    }

    // Report progress
    parentPort?.postMessage({
      type: WorkerMessageType.Progress,
      payload: { processed, total: files.length },
    });
  }

  // Send final result
  parentPort?.postMessage({
    type: WorkerMessageType.ParseComplete,
    payload: { parsed: results, errors },
  });
}

run();
