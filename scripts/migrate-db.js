import { setDefaultResultOrder } from 'dns';
setDefaultResultOrder('ipv4first');

import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { Client } = pg;

const schemaFile = process.argv[2] || path.join(__dirname, '..', 'DATABASE_SCHEMA_FIXED.sql');

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL not set in .env.local');
  process.exit(1);
}

const projectRef = process.env.VITE_SUPABASE_URL?.split('//')[1]?.split('.')[0];
const password = process.env.DATABASE_URL.match(/:([^@]+)@/)?.[1];

const commonOpts = { password, database: 'postgres', ssl: { rejectUnauthorized: false } };

const connectionConfigs = [
  // Direct connection
  { host: `db.${projectRef}.supabase.co`, port: 5432, user: 'postgres', ...commonOpts },
  // EU Central 1 pooler (session mode)
  { host: 'aws-0-eu-central-1.pooler.supabase.com', port: 5432, user: `postgres.${projectRef}`, ...commonOpts },
  // EU West 2 pooler (session mode)
  { host: 'aws-0-eu-west-2.pooler.supabase.com', port: 5432, user: `postgres.${projectRef}`, ...commonOpts },
];

const sql = fs.readFileSync(schemaFile, 'utf8');

for (const config of connectionConfigs) {
  console.log(`Trying: ${config.user}@${config.host}:${config.port}...`);
  const client = new Client(config);
  try {
    await client.connect();
    console.log('Connected. Deploying schema...');
    await client.query(sql);
    console.log('Schema deployed successfully.');
    await client.end();
    process.exit(0);
  } catch (err) {
    await client.end().catch(() => {});
    const isConnErr = ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'].includes(err.code);
    const isTenantErr = err.message?.includes('tenant') || err.message?.includes('not found');
    if (isConnErr || isTenantErr) {
      console.log(`  -> ${err.message}`);
      continue;
    }
    console.error('Migration failed:', err.message);
    process.exit(1);
  }
}

console.error('\nAll connection attempts failed.');
console.error('Deploy manually: open Supabase Dashboard → SQL Editor → paste DATABASE_SCHEMA_FIXED.sql');
process.exit(1);
