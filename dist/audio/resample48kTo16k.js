"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resample48kTo16k = resample48kTo16k;
function clampInt16(value) {
    if (value > 32767)
        return 32767;
    if (value < -32768)
        return -32768;
    return value | 0;
}
function resample48kTo16k(input) {
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
//# sourceMappingURL=resample48kTo16k.js.map