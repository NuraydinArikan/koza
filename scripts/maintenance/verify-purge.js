// Verifies the anonymity guarantee: no recoverable data may survive for
// any purged or expired session. Exits 1 on violation (CI-friendly).
import { connect } from './_db.js';

const client = await connect();
try {
  const { rows } = await client.query('SELECT * FROM verify_purge_integrity()');
  const violations = rows.filter(
    (r) =>
      Number(r.leftover_messages) > 0 ||
      Number(r.leftover_heartbeats) > 0 ||
      !r.sdp_cleared ||
      !r.ice_cleared
  );

  if (violations.length === 0) {
    console.log(`[verify-purge] OK - ${rows.length} purged/expired session(s) verified clean`);
    process.exit(0);
  }

  console.error(`[verify-purge] VIOLATION - ${violations.length} session(s) with recoverable data:`);
  for (const v of violations) {
    console.error(
      `  session=${v.session_id} messages=${v.leftover_messages} heartbeats=${v.leftover_heartbeats} sdp_cleared=${v.sdp_cleared} ice_cleared=${v.ice_cleared}`
    );
  }
  process.exit(1);
} finally {
  await client.end();
}
