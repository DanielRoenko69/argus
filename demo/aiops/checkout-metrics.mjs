import { createServer } from 'node:http';

const metrics = `# HELP checkout_requests_total Requests handled by the checkout service.
# TYPE checkout_requests_total counter
checkout_requests_total{service="checkout-api",environment="argus-demo",status_code="200"} 982
checkout_requests_total{service="checkout-api",environment="argus-demo",status_code="504"} 18
# HELP checkout_payment_provider_timeouts_total Payment provider timeout failures.
# TYPE checkout_payment_provider_timeouts_total counter
checkout_payment_provider_timeouts_total{service="checkout-api",environment="argus-demo",provider="demo-bank"} 18
# HELP checkout_request_duration_seconds Checkout request duration.
# TYPE checkout_request_duration_seconds gauge
checkout_request_duration_seconds{service="checkout-api",environment="argus-demo",quantile="0.95"} 5.2
`;

createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"status":"ok"}');
    return;
  }
  if (request.url === '/metrics') {
    response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
    response.end(metrics);
    return;
  }
  response.writeHead(404).end();
}).listen(9464, '0.0.0.0', () => process.stdout.write('checkout-api demo metrics listening on :9464\n'));
