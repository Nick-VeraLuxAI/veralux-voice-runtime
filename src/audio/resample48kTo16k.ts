function clampInt16(value: number): number {
  if (value > 32767) return 32767;
  if (value < -32768) return -32768;
  return value | 0;
}

export function resample48kTo16k(input: Int16Array): Int16Array {
  if (!input || input.length < 3) {
    return new Int16Array(0);
  }

  const outputLength = Math.floor(input.length / 3);
  const output = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i += 1) {
    const base = i * 3;
    const sum = (input[base] ?? 0) + (input[base + 1] ?? 0) + (input[base + 2] ?? 0);
    output[i] = clampInt16(Math.round(sum / 3));
  }

  return output;
}
