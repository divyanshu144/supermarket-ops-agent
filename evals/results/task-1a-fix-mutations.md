# Task 1a fix mutation evidence

Each mutation changes the guarded behavior, uses the real dedicated disposable Postgres cluster when applicable, and is restored before the green run. No model/API calls. Commands below intentionally redact the throwaway admin URL.

Initial TDD: `EVAL_TEST_DATABASE_ADMIN_URL=<dedicated-disposable-admin> pnpm exec vitest run src/evals/database.test.ts` — 5 failed, 8 passed. See `task-1a-fix-red.txt`. An earlier sandbox-only attempt failed with EPERM and is not database red evidence.

## explicit-database

Command: `EVAL_TEST_DATABASE_ADMIN_URL=<dedicated-disposable-admin> pnpm exec vitest run src/evals/database.test.ts -t "requires explicit database names"`
Red exit: 1; restored green exit: 0.
Outputs: `task-1a-fix-explicit-database-red.txt`, `task-1a-fix-explicit-database-green.txt`.

```diff
--- database.ts
+++ database.ts (mutant)
@@ -43,7 +43,7 @@
     if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search) {
       throw new Error('Eval URLs require PostgreSQL URLs without connection overrides');
     }
-    if (!decodeURIComponent(url.pathname).replace(/^\//, '')) {
+    if (false) {
       throw new Error('Eval URLs require an explicit database name');
     }
   }
```

## normal-overrides

Command: `EVAL_TEST_DATABASE_ADMIN_URL=<dedicated-disposable-admin> pnpm exec vitest run src/evals/database.test.ts -t "rejects connection overrides"`
Red exit: 1; restored green exit: 0.
Outputs: `task-1a-fix-normal-overrides-red.txt`, `task-1a-fix-normal-overrides-green.txt`.

```diff
--- database.ts
+++ database.ts (mutant)
@@ -40,7 +40,7 @@
   const admin = new URL(adminUrl);
   const normal = new URL(normalUrl);
   for (const url of [admin, normal]) {
-    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search) {
+    if (!['postgres:', 'postgresql:'].includes(url.protocol) || (url === admin && url.search)) {
       throw new Error('Eval URLs require PostgreSQL URLs without connection overrides');
     }
     if (!decodeURIComponent(url.pathname).replace(/^\//, '')) {
```

## normalized-identity

Command: `EVAL_TEST_DATABASE_ADMIN_URL=<dedicated-disposable-admin> pnpm exec vitest run src/evals/database.test.ts -t "normalizes the default port"`
Red exit: 1; restored green exit: 0.
Outputs: `task-1a-fix-normalized-identity-red.txt`, `task-1a-fix-normalized-identity-green.txt`.

```diff
--- database.ts
+++ database.ts (mutant)
@@ -49,7 +49,7 @@
   }
   if (
     hostIdentity(admin) === hostIdentity(normal) &&
-    (admin.port || '5432') === (normal.port || '5432') &&
+    admin.port === (normal.port || '5432') &&
     decodeURIComponent(admin.pathname) === decodeURIComponent(normal.pathname)
   ) {
     throw new Error('Eval admin must not target the normal database');
```

## unmarked-database

Command: `EVAL_TEST_DATABASE_ADMIN_URL=<dedicated-disposable-admin> pnpm exec vitest run src/evals/database.test.ts -t "after comment provisioning failure"`
Red exit: 1; restored green exit: 0.
Outputs: `task-1a-fix-unmarked-database-red.txt`, `task-1a-fix-unmarked-database-green.txt`.

```diff
--- database.ts
+++ database.ts (mutant)
@@ -165,7 +165,7 @@
       if (
         (database &&
           ((database.marker !== owned.ownerToken &&
-            !(freshDatabaseOid === database.oid && !databaseMarked && database.marker === null)) ||
+            !(false)) ||
             database.owner !== owned.role)) ||
         (role && role.marker !== owned.ownerToken)
       )
```

## rollback-cleanup

Command: `EVAL_TEST_DATABASE_ADMIN_URL=<dedicated-disposable-admin> pnpm exec vitest run src/evals/database.test.ts -t "after rollback provisioning failure"`
Red exit: 1; restored green exit: 0.
Outputs: `task-1a-fix-rollback-cleanup-red.txt`, `task-1a-fix-rollback-cleanup-green.txt`.

```diff
--- database.ts
+++ database.ts (mutant)
@@ -242,7 +242,7 @@
     try {
       await admin.query('ROLLBACK');
     } catch (rollbackError) {
-      failures.push(rollbackError);
+      throw rollbackError;
     }
     try {
       await cleanup();
```

## disk-ownership

Command: `EVAL_TEST_DATABASE_ADMIN_URL=<dedicated-disposable-admin> pnpm exec vitest run src/evals/database.test.ts -t "refuses on-disk manifest tampering"`
Red exit: 1; restored green exit: 0.
Outputs: `task-1a-fix-disk-ownership-red.txt`, `task-1a-fix-disk-ownership-green.txt`.

```diff
--- database.ts
+++ database.ts (mutant)
@@ -141,7 +141,7 @@
     try {
       const disk: SandboxManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
       for (const key of ['database', 'role', 'ownerToken'] as const) {
-        if (disk[key] !== owned[key]) throw new Error('Sandbox manifest ownership mismatch');
+        if (false) throw new Error('Sandbox manifest ownership mismatch');
       }
       diskVerified = true;
       client = new pg.Client({
```

## recovery-command

Command: `EVAL_TEST_DATABASE_ADMIN_URL=<dedicated-disposable-admin> pnpm exec vitest run src/evals/database.test.ts -t "preserves recovery identity and command"`
Red exit: 1; restored green exit: 0.
Outputs: `task-1a-fix-recovery-command-red.txt`, `task-1a-fix-recovery-command-green.txt`.

```diff
--- database.ts
+++ database.ts (mutant)
@@ -130,7 +130,7 @@
   });
   let freshDatabaseOid: number | undefined;
   let databaseMarked = false;
-  const recovery = `Manifest ${manifestPath}; after verifying ownership, run: DROP DATABASE ${identifier(owned.database)} WITH (FORCE); DROP ROLE ${identifier(owned.role)};`;
+  const recovery = `Manifest ${manifestPath}; manual recovery required`;
   const persist = async (state: SandboxManifest['state']) => {
     manifest.state = state;
     await saveManifest(manifestPath, { version: 1, ...owned, state });
```

## immutable-persistence

Command: `EVAL_TEST_DATABASE_ADMIN_URL=<dedicated-disposable-admin> pnpm exec vitest run src/evals/database.test.ts -t "uses captured identities"`
Red exit: 1; restored green exit: 0.
Outputs: `task-1a-fix-immutable-persistence-red.txt`, `task-1a-fix-immutable-persistence-green.txt`.

```diff
--- database.ts
+++ database.ts (mutant)
@@ -133,7 +133,7 @@
   const recovery = `Manifest ${manifestPath}; after verifying ownership, run: DROP DATABASE ${identifier(owned.database)} WITH (FORCE); DROP ROLE ${identifier(owned.role)};`;
   const persist = async (state: SandboxManifest['state']) => {
     manifest.state = state;
-    await saveManifest(manifestPath, { version: 1, ...owned, state });
+    await saveManifest(manifestPath, manifest);
   };
   const cleanup = async () => {
     let client: pg.Client | undefined;
```
