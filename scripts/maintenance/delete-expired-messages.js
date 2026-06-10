// Deletes all messages past their expiry timestamp, across all sessions.
import { connect } from './_db.js';

const client = await connect();
try {
  const { rows } = await client.query('SELECT auto_delete_expired_messages() AS deleted');
  console.log(`[delete-expired-messages] deleted ${rows[0].deleted} message(s) at ${new Date().toISOString()}`);
} finally {
  await client.end();
}
