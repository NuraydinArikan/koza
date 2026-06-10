// Shared Postgres connection helper for maintenance scripts.
// Mirrors the fallback strategy in scripts/migrate-db.js.
import { setDefaultResultOrder } from 'dns';
setDefaultResultOrder('ipv4first');

import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const { Client } = pg;

export async function connect() {
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL not set in .env.local');
    process.exit(1);
  }

  const projectRef = process.env.VITE_SUPABASE_URL?.split('//')[1]?.split('.')[0];
  const password = process.env.DATABASE_URL.match(/:([^@]+)@/)?.[1];
  const commonOpts = { password, database: 'postgres', ssl: { rejectUnauthorized: false } };

  const configs = [
    { host: `db.${projectRef}.supabase.co`, port: 5432, user: 'postgres', ...commonOpts },
    { host: 'aws-0-eu-central-1.pooler.supabase.com', port: 5432, user: `postgres.${projectRef}`, ...commonOpts },
    { host: 'aws-0-eu-west-2.pooler.supabase.com', port: 5432, user: `postgres.${projectRef}`, ...commonOpts },
  ];

  for (const config of configs) {
    const client = new Client(config);
    try {
      await client.connect();
      return client;
    } catch (err) {
      await client.end().catch(() => {});
      const retriable =
        ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'].includes(err.code) ||
        err.message?.includes('tenant') ||
        err.message?.includes('not found');
      if (!retriable) throw err;
    }
  }
  throw new Error('Could not connect to any database endpoint');
}
