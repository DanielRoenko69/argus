import http from 'node:http';

const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><title>Callback captured</title><p>Callback captured for the HA test.</p>');
});

server.listen(9999, '0.0.0.0');
