import { fileURLToPath } from 'node:url';
import { createLiveApi, liveConfiguration } from './live-api.mjs';

export async function startLiveServer(config = liveConfiguration()) {
  const service = createLiveApi(config);
  await new Promise((resolve, reject) => {
    const onError = error => { service.server.off('listening', onListening); reject(error); };
    const onListening = () => { service.server.off('error', onError); resolve(); };
    service.server.once('error', onError);
    service.server.once('listening', onListening);
    service.server.listen(config.port, config.host);
  });
  return service;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const service = await startLiveServer();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    service.server.close(() => { service.close(); process.exit(0); });
  });
}
