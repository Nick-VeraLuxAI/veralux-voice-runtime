import { env } from './env';
import { log } from './log';
import { buildServer } from './server';

const { server } = buildServer();

server.listen(env.PORT, () => {
  log.info({ port: env.PORT }, 'server listening');
});
