import { createServer } from 'node:http';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 8080);
const server = createServer(createApp());

server.listen(port, '0.0.0.0', () => {
  console.log(`argus-dev-sample listening on ${port}`);
});

function shutdown(signal) {
  console.log(`received ${signal}, shutting down`);
  server.close(error => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
