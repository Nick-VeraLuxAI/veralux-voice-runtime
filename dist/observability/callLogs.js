"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logCallEvent = logCallEvent;
const log_1 = require("../log");
function logCallEvent(event, payload = {}) {
    log_1.log.info({ event, ...payload }, 'call event');
}
//# sourceMappingURL=callLogs.js.map