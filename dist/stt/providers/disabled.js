"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DisabledSttProvider = void 0;
class DisabledSttProvider {
    constructor() {
        this.id = 'disabled';
        this.supportsPartials = false;
    }
    async transcribe(_audio, _opts = {}) {
        return { text: '', isFinal: true, confidence: 0 };
    }
}
exports.DisabledSttProvider = DisabledSttProvider;
//# sourceMappingURL=disabled.js.map