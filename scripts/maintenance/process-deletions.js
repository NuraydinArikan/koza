// Executes scheduled user-data deletion requests (KVKK/GDPR right to
// erasure - 30-day appeal window handled in SQL).
import { connect } from './_db.js';

const client = await connect();
try {
  await client.query('SELECT execute_scheduled_user_deletions()');
  console.log(`[process-deletions] scheduled user deletions executed at ${new Date().toISOString()}`);
} finally {
  await client.end();
}
