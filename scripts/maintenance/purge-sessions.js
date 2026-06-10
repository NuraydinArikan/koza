// Purges every expired, not-yet-purged session (messages, heartbeats,
// WebRTC signaling data). Fallback for environments without pg_cron -
// run on a 1-minute external schedule.
import { connect } from './_db.js';

const client = await connect();
try {
  const { rows } = await client.query('SELECT auto_purge_session() AS purged');
  console.log(`[purge-sessions] purged ${rows[0].purged} expired session(s) at ${new Date().toISOString()}`);
} finally {
  await client.end();
}
