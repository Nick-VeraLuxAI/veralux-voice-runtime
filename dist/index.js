"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const env_1 = require("./env");
const log_1 = require("./log");
const server_1 = require("./server");
const { server } = (0, server_1.buildServer)();
server.listen(env_1.env.PORT, () => {
    log_1.log.info({ port: env_1.env.PORT }, 'server listening');
});
//# sourceMappingURL=index.js.map