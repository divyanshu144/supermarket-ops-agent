import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSandbox, validateAdminUrl, withSandbox, type Sandbox } from './database.js';

const normalUrl = 'postgres://kirana:kirana@localhost:5435/kirana';
const adminUrl = process.env.EVAL_TEST_DATABASE_ADMIN_URL;
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    const files = await readdir(directory);
    const manifests = await Promise.all(
      files
        .filter((file) => file.endsWith('.json'))
        .map(async (file) => JSON.parse(await readFile(join(directory, file), 'utf8'))),
    );
    if (manifests.every((manifest) => manifest.state === 'cleaned'))
      await rm(directory, { recursive: true, force: true });
  }
});
async function config() {
  const manifestDirectory = await mkdtemp(join(tmpdir(), 'eval-db-test-'));
  directories.push(manifestDirectory);
  return { adminUrl: adminUrl!, normalUrl, manifestDirectory };
}
async function connect(url: string) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.end();
    throw error;
  }
}
async function cannotConnect(url: string) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await expect(client.connect()).rejects.toThrow();
  } finally {
    await client.end();
  }
}

describe('eval database admission', () => {
  it('rejects the normal database even with a different credential or localhost spelling', () => {
    expect(() =>
      validateAdminUrl('postgres://other:secret@127.0.0.1:5435/kirana', normalUrl),
    ).toThrow('normal database');
  });
  it('requires explicit database names on both URLs', () => {
    for (const path of ['', '/']) {
      expect(() => validateAdminUrl(`postgres://pg@localhost:5435${path}`, normalUrl)).toThrow(
        'explicit database',
      );
      expect(() =>
        validateAdminUrl(
          'postgres://pg@localhost:5435/eval',
          `postgres://pg@localhost:5435${path}`,
        ),
      ).toThrow('explicit database');
    }
  });
  it('normalizes the default port and decoded database with localhost aliases', () => {
    expect(() =>
      validateAdminUrl(
        'postgres://admin@[::1]/%6b irana'.replace(' ', ''),
        'postgresql://normal@localhost:5432/kirana',
      ),
    ).toThrow('normal database');
  });
  it('rejects connection overrides on either URL', () => {
    for (const query of ['?host=elsewhere', '?port=9999', '?dbname=other']) {
      expect(() => validateAdminUrl(`postgres://pg@localhost/eval${query}`, normalUrl)).toThrow(
        'connection overrides',
      );
      expect(() =>
        validateAdminUrl('postgres://pg@localhost/eval', `${normalUrl}${query}`),
      ).toThrow('connection overrides');
    }
  });
  it('rejects remote admins unless the dedicated server is explicitly opted in', () => {
    const remote = 'postgres://admin:secret@eval.example.com/eval_admin';
    expect(() => validateAdminUrl(remote, normalUrl)).toThrow('dedicated remote');
    expect(() => validateAdminUrl(remote, normalUrl, true)).not.toThrow();
  });
});

describe.skipIf(!adminUrl)('dedicated Postgres isolation (real integration)', () => {
  it('fails closed on PUBLIC CONNECT without creating resources or changing grants', async () => {
    const admin = await connect(adminUrl!);
    try {
      const original = pg.Client.prototype.query;
      vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (
        this: pg.Client,
        ...args: unknown[]
      ) {
        if (String(args[0]).includes('a.grantee = 0'))
          return Promise.resolve({ rows: [{ datname: 'eval_control' }], rowCount: 1 });
        return original.apply(this, args as never);
      } as typeof original);
      const before = await admin.query(
        'SELECT datname, datacl::text FROM pg_database ORDER BY datname',
      );
      const roles = await admin.query('SELECT rolname FROM pg_roles ORDER BY rolname');
      await expect(createSandbox(await config())).rejects.toThrow('PUBLIC CONNECT');
      expect(
        (await admin.query('SELECT datname, datacl::text FROM pg_database ORDER BY datname')).rows,
      ).toEqual(before.rows);
      expect((await admin.query('SELECT rolname FROM pg_roles ORDER BY rolname')).rows).toEqual(
        roles.rows,
      );
    } finally {
      vi.restoreAllMocks();
      await admin.end();
    }
  });

  it('migrates two sandboxes and denies cross-sandbox, admin and normal connections', async () => {
    // A refused worker connection is meaningful only if the normal DB is actually reachable.
    const normal = await connect(adminUrl!);
    try {
      await normal.query('SELECT 1');
    } finally {
      await normal.end();
    }
    const a = await createSandbox(await config());
    let b: Sandbox | undefined;
    let client: pg.Client | undefined;
    const probe = randomUUID().replaceAll('-', '');
    const probeRole = `eval_probe_role_${probe}`;
    const probeDatabase = `eval_probe_db_${probe}`;
    try {
      client = await connect(a.workerUrl);
      b = await createSandbox(await config());
      await client.query(
        "CREATE TABLE eval_marker (value text); INSERT INTO eval_marker VALUES ('only-a')",
      );
      expect(
        (await client.query("SELECT to_regclass('public.products') AS table_name")).rows[0]
          .table_name,
      ).toBe('products');
      const second = await connect(b.workerUrl);
      try {
        await expect(second.query('SELECT * FROM eval_marker')).rejects.toThrow('does not exist');
      } finally {
        await second.end();
      }
      for (const target of [b.workerUrl, adminUrl!]) {
        const url = new URL(target);
        const credentials = new URL(a.workerUrl);
        url.username = credentials.username;
        url.password = credentials.password;
        await cannotConnect(url.toString());
      }
      await expect(client.query(`CREATE ROLE ${probeRole}`)).rejects.toThrow('permission denied');
      await expect(client.query(`CREATE DATABASE ${probeDatabase}`)).rejects.toThrow(
        'permission denied',
      );
      const manifest = await readFile(a.manifestPath, 'utf8');
      expect(manifest).not.toContain(new URL(a.workerUrl).password);
      expect(manifest).not.toContain('postgres://');
    } finally {
      await finish([
        async () => {
          await client?.end();
        },
        async () => {
          const admin = await connect(adminUrl!);
          try {
            await finish([
              async () => {
                await admin.query(`DROP DATABASE IF EXISTS "${probeDatabase}" WITH (FORCE)`);
              },
              async () => {
                await admin.query(`DROP ROLE IF EXISTS "${probeRole}"`);
              },
            ]);
          } finally {
            await admin.end();
          }
        },
        async () => {
          await b?.cleanup();
        },
        async () => {
          await a.cleanup();
        },
      ]);
    }
  });

  it('refuses cleanup when the database ownership marker was changed', async () => {
    const sandbox = await createSandbox(await config());
    let admin: pg.Client | undefined;
    try {
      admin = await connect(adminUrl!);
      await admin.query(`COMMENT ON DATABASE "${sandbox.manifest.database}" IS 'not-this-run'`);
      await expect(sandbox.cleanup()).rejects.toThrow('ownership');
      expect(
        (
          await admin.query('SELECT datname FROM pg_database WHERE datname = $1', [
            sandbox.manifest.database,
          ])
        ).rowCount,
      ).toBe(1);
    } finally {
      try {
        admin ??= await connect(adminUrl!);
        if (
          (
            await admin.query('SELECT datname FROM pg_database WHERE datname = $1', [
              sandbox.manifest.database,
            ])
          ).rowCount
        ) {
          await admin.query(
            `COMMENT ON DATABASE "${sandbox.manifest.database}" IS '${sandbox.manifest.ownerToken}'`,
          );
        }
      } finally {
        await finish([
          async () => {
            await sandbox.cleanup();
          },
          async () => {
            await admin?.end();
          },
        ]);
      }
    }
  });

  it.each(['comment', 'rollback'])(
    'cleans exact resources after %s provisioning failure',
    async (boundary) => {
      const cfg = await config();
      const original = pg.Client.prototype.query;
      const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (
        this: pg.Client,
        ...args: unknown[]
      ) {
        const sql = String(args[0]);
        if (sql.startsWith('COMMENT ON DATABASE'))
          return Promise.reject(new Error('injected database comment failure'));
        if (boundary === 'rollback' && sql === 'ROLLBACK')
          return Promise.reject(new Error('injected rollback failure'));
        return original.apply(this, args as never);
      } as typeof original);
      let failure: unknown;
      try {
        failure = await createSandbox(cfg).catch((error: unknown) => error);
      } finally {
        spy.mockRestore();
      }
      const files = await readdir(cfg.manifestDirectory);
      const manifest = JSON.parse(await readFile(join(cfg.manifestDirectory, files[0]!), 'utf8'));
      const admin = await connect(adminUrl!);
      try {
        expect(String(failure)).toContain(
          boundary === 'rollback' ? 'provisioning failed' : 'injected',
        );
        expect(
          (
            await admin.query('SELECT datname FROM pg_database WHERE datname = $1', [
              manifest.database,
            ])
          ).rowCount,
        ).toBe(0);
        expect(
          (await admin.query('SELECT rolname FROM pg_roles WHERE rolname = $1', [manifest.role]))
            .rowCount,
        ).toBe(0);
        expect(manifest.state).toBe('cleaned');
      } finally {
        await admin.end();
        await recover(manifest, join(cfg.manifestDirectory, files[0]!));
      }
    },
  );

  it('refuses on-disk manifest tampering and recovers after restoration', async () => {
    const sandbox = await createSandbox(await config());
    const original = await readFile(sandbox.manifestPath, 'utf8');
    try {
      const disk = JSON.parse(original);
      disk.ownerToken = 'tampered';
      await writeFile(sandbox.manifestPath, JSON.stringify(disk));
      await expect(sandbox.cleanup()).rejects.toThrow('ownership');
      expect(await readFile(sandbox.manifestPath, 'utf8')).toContain('tampered');
      const client = await connect(sandbox.workerUrl);
      try {
        expect((await client.query('SELECT 1 AS alive')).rows[0].alive).toBe(1);
      } finally {
        await client.end();
      }
    } finally {
      await writeFile(sandbox.manifestPath, original);
      await sandbox.cleanup();
    }
  });

  it('preserves recovery identity and command on cleanup failure', async () => {
    const sandbox = await createSandbox(await config());
    const original = pg.Client.prototype.query;
    const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (
      this: pg.Client,
      ...args: unknown[]
    ) {
      if (String(args[0]).startsWith('DROP DATABASE'))
        return Promise.reject(new Error('injected drop failure'));
      return original.apply(this, args as never);
    } as typeof original);
    try {
      const error = await sandbox.cleanup().catch((error: Error) => error);
      expect(error).toBeInstanceOf(AggregateError);
      expect(String(error)).toContain(sandbox.manifestPath);
      expect(String(error)).toContain(`DROP DATABASE "${sandbox.manifest.database}" WITH (FORCE)`);
      expect(String(error)).toContain(`DROP ROLE "${sandbox.manifest.role}"`);
      expect(String(error)).not.toContain('postgres://');
      expect(String(error)).not.toContain(new URL(sandbox.workerUrl).password);
      expect(JSON.parse(await readFile(sandbox.manifestPath, 'utf8')).state).toBe('cleanup-failed');
    } finally {
      spy.mockRestore();
      await sandbox.cleanup();
    }
  });

  it('uses captured identities after returned manifest mutation', async () => {
    const sandbox = await createSandbox(await config());
    const original = { ...sandbox.manifest };
    try {
      sandbox.manifest.database = 'not_owned';
      sandbox.manifest.role = 'not_owned';
      sandbox.manifest.ownerToken = 'tampered';
      await sandbox.cleanup();
      const disk = JSON.parse(await readFile(sandbox.manifestPath, 'utf8'));
      expect(disk).toEqual({ ...original, state: 'cleaned' });
    } finally {
      Object.assign(sandbox.manifest, original);
      await recover(original, sandbox.manifestPath);
    }
  });

  it('cleans only manifest resources after an interrupted worker, leaving another sandbox intact', async () => {
    const survivor = await createSandbox(await config());
    let interrupted: { database: string; role: string } | undefined;
    let interruptedSandbox: Sandbox | undefined;
    try {
      await expect(
        withSandbox(await config(), async (sandbox) => {
          interrupted = sandbox.manifest;
          interruptedSandbox = sandbox;
          const worker = spawn(
            process.execPath,
            [
              '--input-type=module',
              '-e',
              "import pg from 'pg'; const c = new pg.Client({connectionString:process.env.DATABASE_URL}); await c.connect(); console.log('ready'); setInterval(()=>{},1000);",
            ],
            {
              env: { PATH: process.env.PATH, DATABASE_URL: sandbox.workerUrl },
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          );
          const closed = new Promise<void>((resolve) => worker.once('close', () => resolve()));
          try {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => done(new Error('worker startup timed out')), 3000);
              const done = (error?: Error) => {
                clearTimeout(timer);
                worker.off('error', failed);
                worker.off('exit', exited);
                worker.stdout!.off('data', ready);
                if (error) reject(error);
                else resolve();
              };
              const failed = (error: Error) => done(error);
              const exited = () => done(new Error('worker exited before ready'));
              const ready = (data: Buffer) => {
                if (data.toString().includes('ready')) done();
              };
              worker.once('error', failed);
              worker.once('exit', exited);
              worker.stdout!.on('data', ready);
            });
          } finally {
            if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
            await closed;
          }
          throw new Error('worker interrupted');
        }),
      ).rejects.toThrow('worker interrupted');
      const admin = await connect(adminUrl!);
      try {
        expect(
          (
            await admin.query('SELECT datname FROM pg_database WHERE datname = $1', [
              interrupted!.database,
            ])
          ).rowCount,
        ).toBe(0);
        expect(
          (
            await admin.query('SELECT rolname FROM pg_roles WHERE rolname = $1', [
              interrupted!.role,
            ])
          ).rowCount,
        ).toBe(0);
        expect(
          (
            await admin.query('SELECT datname FROM pg_database WHERE datname = $1', [
              survivor.manifest.database,
            ])
          ).rowCount,
        ).toBe(1);
      } finally {
        await admin.end();
      }
      const client = await connect(survivor.workerUrl);
      await client.end();
    } finally {
      await finish([
        async () => {
          await interruptedSandbox?.cleanup();
        },
        async () => {
          await survivor.cleanup();
        },
      ]);
    }
  });
});

async function finish(actions: (() => Promise<void>)[]) {
  const results = await Promise.allSettled(actions.map((action) => action()));
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      'Test cleanup failed; preserve manifests',
    );
}

async function recover(
  manifest: { database: string; role: string; ownerToken: string },
  path: string,
) {
  const admin = await connect(adminUrl!);
  try {
    const database = (
      await admin.query(
        "SELECT pg_get_userbyid(datdba) AS owner, shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname=$1",
        [manifest.database],
      )
    ).rows[0];
    const role = (
      await admin.query(
        "SELECT shobj_description(oid, 'pg_authid') AS marker FROM pg_roles WHERE rolname=$1",
        [manifest.role],
      )
    ).rows[0];
    if (
      (role && role.marker !== manifest.ownerToken) ||
      (database &&
        (database.owner !== manifest.role ||
          (database.marker !== null && database.marker !== manifest.ownerToken)))
    )
      throw new Error(`Refused test recovery; manifest ${path}`);
    if (database) await admin.query(`DROP DATABASE "${manifest.database}" WITH (FORCE)`);
    if (role) await admin.query(`DROP ROLE "${manifest.role}"`);
    await writeFile(path, JSON.stringify({ ...manifest, state: 'cleaned' }));
  } finally {
    await admin.end();
  }
}
