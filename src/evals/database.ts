import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

export interface SandboxConfig {
  adminUrl: string;
  normalUrl: string;
  manifestDirectory: string;
  allowDedicatedRemote?: boolean;
}
export interface SandboxManifest {
  version: 1;
  database: string;
  role: string;
  ownerToken: string;
  createdAt: string;
  state: 'provisioning' | 'ready' | 'cleaned' | 'cleanup-failed';
}
export interface Sandbox {
  workerUrl: string;
  manifest: SandboxManifest;
  manifestPath: string;
  cleanup: () => Promise<void>;
}

/** Only literal loopback aliases are normalized; DNS/private routing aliases cannot be
 * established from URL strings. Operators must provide a genuinely dedicated endpoint. */
function hostIdentity(url: URL): string {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? 'localhost' : url.hostname;
}
export function validateAdminUrl(
  adminUrl: string,
  normalUrl: string,
  allowDedicatedRemote = false,
) {
  const admin = new URL(adminUrl);
  const normal = new URL(normalUrl);
  for (const url of [admin, normal]) {
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search) {
      throw new Error('Eval URLs require PostgreSQL URLs without connection overrides');
    }
    if (!decodeURIComponent(url.pathname).replace(/^\//, '')) {
      throw new Error('Eval URLs require an explicit database name');
    }
  }
  if (
    hostIdentity(admin) === hostIdentity(normal) &&
    (admin.port || '5432') === (normal.port || '5432') &&
    decodeURIComponent(admin.pathname) === decodeURIComponent(normal.pathname)
  ) {
    throw new Error('Eval admin must not target the normal database');
  }
  if (hostIdentity(admin) !== 'localhost' && !allowDedicatedRemote) {
    throw new Error('Explicit opt-in required for a dedicated remote eval server');
  }
  return admin;
}
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

async function saveManifest(path: string, manifest: SandboxManifest) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

/** No existing cluster ACL is changed. PUBLIC grants cannot be revoked for one role. */
async function assertIsolatedCluster(admin: pg.Client) {
  const user = await admin.query<{ superuser: boolean }>(
    'SELECT rolsuper AS superuser FROM pg_roles WHERE rolname = current_user',
  );
  if (!user.rows[0]?.superuser) throw new Error('Dedicated eval admin must be a superuser');
  const publicConnections = await admin.query(
    `SELECT d.datname FROM pg_database d,
      LATERAL aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
      WHERE d.datallowconn AND a.grantee = 0 AND a.privilege_type = 'CONNECT'`,
  );
  if (publicConnections.rowCount !== 0) {
    throw new Error(
      'Eval cluster is not isolated: PUBLIC CONNECT exists; bootstrap a dedicated cluster',
    );
  }
}

export async function createSandbox(config: SandboxConfig): Promise<Sandbox> {
  const adminUrl = validateAdminUrl(config.adminUrl, config.normalUrl, config.allowDedicatedRemote);
  const admin = new pg.Client({
    connectionString: adminUrl.toString(),
    connectionTimeoutMillis: 3000,
  });
  await admin.connect();
  try {
    await assertIsolatedCluster(admin);
  } catch (error) {
    await admin.end();
    throw error;
  }
  const suffix = randomUUID().replaceAll('-', '');
  const manifest: SandboxManifest = {
    version: 1,
    database: `eval_db_${suffix}`,
    role: `eval_role_${suffix}`,
    ownerToken: `eval-owner:${randomUUID()}`,
    createdAt: new Date().toISOString(),
    state: 'provisioning',
  };
  const password = randomBytes(32).toString('hex');
  const worker = new URL(adminUrl);
  worker.pathname = `/${manifest.database}`;
  worker.username = manifest.role;
  worker.password = password;
  const manifestPath = join(config.manifestDirectory, `${suffix}.json`);
  try {
    await mkdir(config.manifestDirectory, { recursive: true });
    await saveManifest(manifestPath, manifest);
  } catch (error) {
    await admin.end();
    throw error;
  }
  // Capture exact identities independently of the mutable public manifest.
  const owned = Object.freeze({
    database: manifest.database,
    role: manifest.role,
    ownerToken: manifest.ownerToken,
    createdAt: manifest.createdAt,
  });
  let freshDatabaseOid: number | undefined;
  let databaseMarked = false;
  const recovery = `Manifest ${manifestPath}; after verifying ownership, run: DROP DATABASE ${identifier(owned.database)} WITH (FORCE); DROP ROLE ${identifier(owned.role)};`;
  const persist = async (state: SandboxManifest['state']) => {
    manifest.state = state;
    await saveManifest(manifestPath, { version: 1, ...owned, state });
  };
  const cleanup = async () => {
    let client: pg.Client | undefined;
    let diskVerified = false;
    try {
      const disk: SandboxManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      for (const key of ['database', 'role', 'ownerToken'] as const) {
        if (disk[key] !== owned[key]) throw new Error('Sandbox manifest ownership mismatch');
      }
      diskVerified = true;
      client = new pg.Client({
        connectionString: adminUrl.toString(),
        connectionTimeoutMillis: 3000,
      });
      await client.connect();
      const database = (
        await client.query<{ oid: number; marker: string | null; owner: string }>(
          `SELECT oid, shobj_description(oid, 'pg_database') AS marker,
          pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1`,
          [owned.database],
        )
      ).rows[0];
      const role = (
        await client.query<{ marker: string }>(
          "SELECT shobj_description(oid, 'pg_authid') AS marker FROM pg_roles WHERE rolname = $1",
          [owned.role],
        )
      ).rows[0];
      if (
        (database &&
          ((database.marker !== owned.ownerToken &&
            !(freshDatabaseOid === database.oid && !databaseMarked && database.marker === null)) ||
            database.owner !== owned.role)) ||
        (role && role.marker !== owned.ownerToken)
      )
        throw new Error('Sandbox catalog ownership mismatch');
      if (database) await client.query(`DROP DATABASE ${identifier(owned.database)} WITH (FORCE)`);
      if (role) await client.query(`DROP ROLE ${identifier(owned.role)}`);
      await persist('cleaned');
    } catch (error) {
      const failures = [error];
      if (diskVerified) {
        try {
          await persist('cleanup-failed');
        } catch (saveError) {
          failures.push(saveError);
        }
      }
      throw new AggregateError(
        failures,
        `Sandbox cleanup failed${error instanceof Error && error.message.includes('ownership') ? ' (ownership mismatch)' : ''}: ${recovery}`,
        { cause: error },
      );
    } finally {
      await client?.end();
    }
  };
  try {
    await admin.query('BEGIN');
    await admin.query(
      `CREATE ROLE ${identifier(manifest.role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${literal(password)}`,
    );
    await admin.query(
      `COMMENT ON ROLE ${identifier(manifest.role)} IS ${literal(manifest.ownerToken)}`,
    );
    await admin.query('COMMIT');
    // No worker can connect during the CREATE/REVOKE window, even on a concurrent run.
    await admin.query(
      `CREATE DATABASE ${identifier(manifest.database)} OWNER ${identifier(manifest.role)} ALLOW_CONNECTIONS false`,
    );
    freshDatabaseOid = (
      await admin.query<{ oid: number }>('SELECT oid FROM pg_database WHERE datname = $1', [
        owned.database,
      ])
    ).rows[0]?.oid;
    await admin.query(
      `COMMENT ON DATABASE ${identifier(manifest.database)} IS ${literal(manifest.ownerToken)}`,
    );
    databaseMarked = true;
    await admin.query(`REVOKE ALL ON DATABASE ${identifier(manifest.database)} FROM PUBLIC`);
    await admin.query(`ALTER DATABASE ${identifier(manifest.database)} ALLOW_CONNECTIONS true`);
    await admin.query(`ALTER ROLE ${identifier(manifest.role)} LOGIN`);
    const pool = new pg.Pool({
      connectionString: worker.toString(),
      connectionTimeoutMillis: 3000,
    });
    try {
      await migrate(drizzle(pool), {
        migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), '../db/migrations'),
      });
    } finally {
      await pool.end();
    }
    // Prove effective permissions, rather than assuming NOINHERIT cancels PUBLIC grants.
    const permissions = await admin.query<{ datname: string; permitted: boolean }>(
      "SELECT datname, has_database_privilege($1, oid, 'CONNECT') AS permitted FROM pg_database WHERE datallowconn",
      [manifest.role],
    );
    if (permissions.rows.some((row) => row.datname !== manifest.database && row.permitted)) {
      throw new Error('Sandbox isolation failed: role can connect to another database');
    }
    manifest.state = 'ready';
    await saveManifest(manifestPath, manifest);
    return { workerUrl: worker.toString(), manifest, manifestPath, cleanup };
  } catch (error) {
    const failures = [error];
    try {
      await admin.query('ROLLBACK');
    } catch (rollbackError) {
      failures.push(rollbackError);
    }
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [...failures, cleanupError],
        `Sandbox provisioning and cleanup failed: ${recovery}`,
        { cause: cleanupError },
      );
    }
    if (failures.length > 1)
      throw new AggregateError(failures, 'Sandbox provisioning failed; owned resources cleaned', {
        cause: error,
      });
    throw error;
  } finally {
    await admin.end();
  }
}

/** The callback must close/stop its workers before returning or throwing. */
export async function withSandbox<T>(config: SandboxConfig, run: (sandbox: Sandbox) => Promise<T>) {
  const sandbox = await createSandbox(config);
  try {
    return await run(sandbox);
  } finally {
    await sandbox.cleanup();
  }
}
