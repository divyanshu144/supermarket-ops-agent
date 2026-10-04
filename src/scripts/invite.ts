import 'dotenv/config';
import { pool } from '../db/client.js';
import { createInvite, listInvites, revokeInvite } from '../repositories/access.js';

const USAGE = 'Usage: invite create | invite list | invite revoke <id>';

async function main(): Promise<number> {
  const [command, arg] = process.argv.slice(2);

  if (command === 'create') {
    const { id, code } = await createInvite();
    console.log(`Invite created (id ${id}).`);
    console.log(`Code: ${code}`);
    console.log('This is the only time the code is shown. The owner sends: /start ' + code);
    return 0;
  }

  if (command === 'list') {
    const rows = await listInvites();
    if (rows.length === 0) console.log('No invites.');
    for (const r of rows) {
      const state = r.revokedAt ? 'revoked' : r.usedAt ? `used by chat ${r.usedByChat}` : 'unused';
      console.log(`${r.id}  ${r.createdAt.toISOString()}  ${state}`);
    }
    return 0;
  }

  if (command === 'revoke' && arg) {
    const revoked = await revokeInvite(arg);
    console.log(
      revoked
        ? `Revoked ${arg}.`
        : `Nothing revoked: ${arg} is unknown, already used or already revoked.`,
    );
    return revoked ? 0 : 1;
  }

  console.error(USAGE);
  return 2;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
