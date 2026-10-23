// Private host finalization only; this module never processes DSP samples.
export function createCounterCollector() {
  const bytes = new Uint8Array(1024);
  const decoder = new TextDecoder();
  let length = 0;
  let discarded = false;
  let receipt = null;
  return {
    add(buffer) {
      for (const byte of buffer) {
        if (byte === 10) {
          if (!discarded) {
            const line = decoder.decode(bytes.subarray(0, length));
            const match = /cases(\d+) rate(\d+) baseFrames(\d+) numericWords(\d+) outputBytes(\d+) fixedGraphBytes(\d+) inputSHA256([0-9a-f]{64})/.exec(line);
            if (match) {
              if (receipt !== null) throw new Error('duplicate Go counter receipt');
              const keys = ['cases', 'rate', 'baseFrames', 'numericWords', 'outputBytes', 'fixedGraphBytes', 'inputSHA256'];
              receipt = Object.fromEntries(keys.map((key, i) => [key, i === 6 ? match[i + 1] : Number(match[i + 1])]));
            }
          }
          length = 0;
          discarded = false;
        } else if (length < bytes.length) {
          bytes[length++] = byte;
        } else {
          discarded = true;
        }
      }
    },
    verify(expected, rate, outputBytes) {
      if (receipt === null || receipt.rate !== rate || receipt.cases !== 27 || receipt.baseFrames > 200000 || receipt.baseFrames * 4 > 800000 || receipt.numericWords > 16 * 1024 * 1024 || receipt.outputBytes > 8 * 1024 * 1024 || receipt.fixedGraphBytes > 2 * 1024 * 1024 || receipt.outputBytes !== outputBytes) {
        throw new Error('Go counter admission refused');
      }
      for (const key of ['cases', 'rate', 'baseFrames', 'numericWords', 'outputBytes', 'inputSHA256']) {
        if (receipt[key] !== expected?.[key]) throw new Error(`frozen native counter differs: ${key}`);
      }
      return receipt;
    },
  };
}

export function finishChild({ code, receipt, writeReceipt, writeError, exit }) {
  // These callbacks MUST finish synchronously, including descriptor closure.
  const result = writeReceipt(receipt);
  if (result?.then !== undefined) throw new Error('asynchronous receipt sink refused');
  if (code !== 0) writeError(`private fixture refused: ${receipt.failure ?? 'incomplete Go exit'}\n`);
  // The official Go Node wrapper exits in go.exit. We defer only until the full
  // Go run and synchronous receipts finish, then exit before stale runtime timers.
  exit(code);
}
