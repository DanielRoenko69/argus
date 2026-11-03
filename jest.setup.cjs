// Keep integration tests aligned with the same local PostgreSQL credentials
// used by Docker Compose without importing the entire developer .env into
// every unit test. Loading the full file would, for example, turn the
// embedding-model default into a machine-specific value and make focused
// unit tests depend on local runtime settings.
// Jest 30 no longer guarantees NODE_ENV=test when it is started directly.
// Keep test imports on the synchronous logger path so pino-pretty cannot leave
// a worker MessagePort open after a suite has completed.
if (process.env.NODE_ENV == null) process.env.NODE_ENV = 'test';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  const parsed = dotenv.parse(fs.readFileSync(envPath));
  for (const key of [
    'DATABASE_URL',
    'POSTGRES_CONNECTION_URL',
    'POSTGRES_ENABLED',
    'POSTGRES_DB',
    'POSTGRES_USER',
    'POSTGRES_PASSWORD',
    'DB_ENCRYPTION_KEY',
  ]) {
    if (process.env[key] == null && parsed[key] != null) process.env[key] = parsed[key];
  }
}
