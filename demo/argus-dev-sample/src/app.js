import { randomUUID } from 'node:crypto';

const services = [
  { id: 'catalog', owner: 'platform', tier: 'critical' },
  { id: 'checkout', owner: 'commerce', tier: 'critical' },
  { id: 'notifications', owner: 'experience', tier: 'standard' },
];

function json(response, statusCode, body) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'x-request-id': randomUUID(),
  });
  response.end(JSON.stringify(body));
}

export function createApp() {
  return (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (request.method === 'GET' && url.pathname === '/health') {
      json(response, 200, { status: 'ok', service: 'argus-dev-sample' });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/services') {
      const tier = url.searchParams.get('tier');
      const result = tier ? services.filter(service => service.tier === tier) : services;
      json(response, 200, { count: result.length, services: result });
      return;
    }

    json(response, 404, { error: 'not_found' });
  };
}
