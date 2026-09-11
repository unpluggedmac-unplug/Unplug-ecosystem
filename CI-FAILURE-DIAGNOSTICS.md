# Temporary CI failure diagnostics

Run: 34578137037
Commit: 1fd5c8149e4d9bc41cb17c71a54b64e474f99b97

## Failure markers
```text
627-ok 80 - THE HIGH-RISK FILTER SHOWS ONLY WHAT IT PROMISES
628-  ---
629-  duration_ms: 3.446976
630-  ...
631-# 2026-09-11 08:14:01.466 UTC [2352] ERROR:  invalid input syntax for type timestamp with time zone: "not-a-date"
632-# 2026-09-11 08:14:01.466 UTC [2352] CONTEXT:  unnamed portal parameter $1 = '...'
633-# 2026-09-11 08:14:01.466 UTC [2352] STATEMENT:  SELECT count(*)::int AS n FROM admin_activity_log l WHERE l.created_at >= $1::timestamptz
634-# 2026-09-11 08:14:01.466 UTC [2353] ERROR:  invalid input syntax for type timestamp with time zone: "not-a-date"
635-# 2026-09-11 08:14:01.466 UTC [2353] CONTEXT:  unnamed portal parameter $1 = '...'
636-# 2026-09-11 08:14:01.466 UTC [2353] STATEMENT:  SELECT l.id, l.admin_user_id, l.action, l.details, l.created_at,
637-# \\t                l.ip_address, l.user_agent, l.high_risk,
638-# \\t                -- Joined so the screen can say who, by name. It showed a dash
639-# \\t                -- in the "By" column before this, because the query returned
640-# \\t                -- an id and the page was reading an email that was never sent.
641-# \\t                u.email AS admin_email, u.full_name AS admin_name
642-# \\t           FROM admin_activity_log l
643-# \\t           LEFT JOIN users u ON u.id = l.admin_user_id
644-# \\t           WHERE l.created_at >= $1::timestamptz
645-# \\t          ORDER BY l.created_at DESC
646-# \\t          LIMIT $2 OFFSET $3
647:# [activity log] query failed: error: invalid input syntax for type timestamp with time zone: "not-a-date"
648-#     at /home/runner/work/Unplug-ecosystem/Unplug-ecosystem/unplug-backend/node_modules/pg-pool/index.js:45:11
649-#     at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
650-#     at async Promise.all (index 0)
651-#     at async /home/runner/work/Unplug-ecosystem/Unplug-ecosystem/unplug-backend/src/routes/activityLog.js:171:27 {
652-#   length: 171,
653-#   severity: 'ERROR',
654-#   code: '22007',
655-#   detail: undefined,
656-#   hint: undefined,
657-#   position: undefined,
658-#   internalPosition: undefined,
659-#   internalQuery: undefined,
660-#   where: "unnamed portal parameter $1 = '...'",
661-#   schema: undefined,
662-#   table: undefined,
663-#   column: undefined,
664-#   dataType: undefined,
665-#   constraint: undefined,
666-#   file: 'datetime.c',
667-#   line: '4143',
668-#   routine: 'DateTimeParseError'
669-# }
670-# Subtest: A DATE FILTER THAT CANNOT BE PARSED FAILS, RATHER THAN MATCHING EVERYTHING
671-ok 81 - A DATE FILTER THAT CANNOT BE PARSED FAILS, RATHER THAN MATCHING EVERYTHING
672-  ---
673-  duration_ms: 20.592551
674-  ...
675-# Subtest: a future date range returns nothing at all
676-ok 82 - a future date range returns nothing at all
677-  ---
678-  duration_ms: 3.653107
679-  ...
680-# Subtest: paging reports a total that matches the filter, not the table
681-ok 83 - paging reports a total that matches the filter, not the table
682-  ---
683-  duration_ms: 5.764101
684-  ...
685-# Subtest: the action list is built from what has actually happened
686-ok 84 - the action list is built from what has actually happened
687-  ---
688-  duration_ms: 3.527496
689-  ...
690-# Subtest: THE WHOLE LOG IS ADMIN-ONLY
691-ok 85 - THE WHOLE LOG IS ADMIN-ONLY
692-  ---
693-  duration_ms: 5.771666
694-  ...
695-# 2026-09-11 08:14:01.504 UTC [2342] LOG:  received fast shutdown request
696-# 2026-09-11 08:14:01.506 UTC [2342] LOG:  aborting any active transactions
697-# 2026-09-11 08:14:01.506 UTC [2354] FATAL:  terminating connection due to administrator command
698-# 2026-09-11 08:14:01.506 UTC [2355] FATAL:  terminating connection due to administrator command
699-# 2026-09-11 08:14:01.508 UTC [2342] LOG:  background worker "logical replication launcher" (PID 2348) exited with exit code 1
700-# 2026-09-11 08:14:01.509 UTC [2343] LOG:  shutting down
701-# 2026-09-11 08:14:01.510 UTC [2343] LOG:  checkpoint starting: shutdown immediate
702-# 2026-09-11 08:14:01.846 UTC [2343] LOG:  checkpoint complete: wrote 1851 buffers (11.3%); 0 WAL file(s) added, 0 removed, 1 recycled; write=0.048 s, sync=0.286 s, total=0.337 s; sync files=1489, longest=0.004 s, average=0.001 s; distance=12605 kB, estimate=12605 kB; lsn=0/2128C38, redo lsn=0/2128C38
703-# 2026-09-11 08:14:01.850 UTC [2342] LOG:  database system is shut down
704-# The files belonging to this database system will be owned by user "runner".
705-# This user must also own the server process.
706-# The database cluster will be initialized with this locale configuration:
707-#   locale provider:   libc
--
15524-  duration_ms: 10.20819
15525-  ...
15526-# Subtest: re-running every migration is idempotent
15527-ok 1774 - re-running every migration is idempotent
15528-  ---
15529-  duration_ms: 208.033853
15530-  ...
15531-# 2026-09-11 08:18:43.116 UTC [7390] LOG:  received fast shutdown request
15532-# 2026-09-11 08:18:43.117 UTC [7390] LOG:  aborting any active transactions
15533-# 2026-09-11 08:18:43.118 UTC [7390] LOG:  background worker "logical replication launcher" (PID 7396) exited with exit code 1
15534-# 2026-09-11 08:18:43.120 UTC [7391] LOG:  shutting down
15535-# 2026-09-11 08:18:43.120 UTC [7391] LOG:  checkpoint starting: shutdown immediate
15536-# 2026-09-11 08:18:43.605 UTC [7391] LOG:  checkpoint complete: wrote 1975 buffers (12.1%); 0 WAL file(s) added, 0 removed, 1 recycled; write=0.048 s, sync=0.435 s, total=0.486 s; sync files=1506, longest=0.081 s, average=0.001 s; distance=13200 kB, estimate=13200 kB; lsn=0/21BD780, redo lsn=0/21BD780
15537-# 2026-09-11 08:18:43.610 UTC [7390] LOG:  database system is shut down
15538-# Subtest: staging readiness refuses missing R2 instead of allowing ephemeral uploads
15539-ok 1775 - staging readiness refuses missing R2 instead of allowing ephemeral uploads
15540-  ---
15541-  duration_ms: 24.620357
15542-  ...
15543-# Subtest: staging readiness catches the actual rate-limit disable value used by middleware
15544:not ok 1776 - staging readiness catches the actual rate-limit disable value used by middleware
15545-  ---
15546-  duration_ms: 24.637249
15547-  location: '/home/runner/work/Unplug-ecosystem/Unplug-ecosystem/unplug-backend/test/readinessGuards.test.js:42:1'
15548:  failureType: 'testCodeFailure'
15549:  error: |-
15550-    The input did not match the regular expression /rate limiting/i. Input:
15551-    
15552-    'Unplug staging readiness check\n' +
15553-      '\n' +
15554-      'OK   UNPLUG_ENV=staging\n' +
15555-      'OK   NODE_ENV=production\n' +
15556-      'OK   JWT_SECRET is set\n' +
15557-      'OK   DATABASE_URL is set\n' +
15558-      'OK   STAGING_DATABASE_URL is set\n' +
15559-      'OK   CORS_ORIGINS is set\n' +
15560-      'OK   SITE_URL is set\n' +
15561-      'OK   PUBLIC_API_URL is set\n' +
15562-      'OK   R2_ACCOUNT_ID is set\n' +
15563-      'OK   R2_ACCESS_KEY_ID is set\n' +
15564-      'OK   R2_SECRET_ACCESS_KEY is set\n' +
15565-      'OK   R2_BUCKET is set\n' +
15566-      'OK   R2_PUBLIC_URL is set\n' +
15567-      'OK   DATABASE_URL matches STAGING_DATABASE_URL guard\n' +
15568-      'OK   SITE_URL is not production\n' +
15569-      'OK   PUBLIC_API_URL is not production\n' +
15570-      'OK   ADMIN_PASSWORD_RESET is off\n' +
15571-      'OK   CORS_ORIGINS has explicit non-local origins\n' +
15572-      '\n' +
15573-      'FAIL UNPLUG_DISABLE_RATE_LIMITS must not be enabled\n' +
15574-      'Staging readiness FAILED. Fix the items above before deploying.\n'
15575-    
15576:  code: 'ERR_ASSERTION'
15577:  name: 'AssertionError'
15578:  expected:
15579:  actual: |-
15580-    Unplug staging readiness check
15581-    
15582-    OK   UNPLUG_ENV=staging
15583-    OK   NODE_ENV=production
15584-    OK   JWT_SECRET is set
15585-    OK   DATABASE_URL is set
15586-    OK   STAGING_DATABASE_URL is set
15587-    OK   CORS_ORIGINS is set
15588-    OK   SITE_URL is set
15589-    OK   PUBLIC_API_URL is set
15590-    OK   R2_ACCOUNT_ID is set
15591-    OK   R2_ACCESS_KEY_ID is set
15592-    OK   R2_SECRET_ACCESS_KEY is set
15593-    OK   R2_BUCKET is set
15594-    OK   R2_PUBLIC_URL is set
15595-    OK   DATABASE_URL matches STAGING_DATABASE_URL guard
15596-    OK   SITE_URL is not production
15597-    OK   PUBLIC_API_URL is not production
15598-    OK   ADMIN_PASSWORD_RESET is off
15599-    OK   CORS_ORIGINS has explicit non-local origins
15600-    
15601-    FAIL UNPLUG_DISABLE_RATE_LIMITS must not be enabled
15602-    Staging readiness FAILED. Fix the items above before deploying.
15603-    
15604-  operator: 'match'
15605-  stack: |-
15606-    TestContext.<anonymous> (/home/runner/work/Unplug-ecosystem/Unplug-ecosystem/unplug-backend/test/readinessGuards.test.js:45:10)
15607-    Test.runInAsyncScope (node:async_hooks:206:9)
15608-    Test.run (node:internal/test_runner/test:796:25)
15609-    Test.processPendingSubtests (node:internal/test_runner/test:526:18)
15610-    Test.postRun (node:internal/test_runner/test:889:19)
15611-    Test.run (node:internal/test_runner/test:835:12)
15612-    async Test.processPendingSubtests (node:internal/test_runner/test:526:7)
15613-  ...
15614-# Subtest: production readiness does not accept legacy Supabase as a substitute for active R2 storage
15615-ok 1777 - production readiness does not accept legacy Supabase as a substitute for active R2 storage
15616-  ---
15617-  duration_ms: 25.123788
15618-  ...
15619-# Subtest: production readiness catches UNPLUG_DISABLE_RATE_LIMITS=1
15620-ok 1778 - production readiness catches UNPLUG_DISABLE_RATE_LIMITS=1
15621-  ---
15622-  duration_ms: 23.954721
15623-  ...
15624-# The files belonging to this database system will be owned by user "runner".
15625-# This user must also own the server process.
15626-# The database cluster will be initialized with this locale configuration:
15627-#   locale provider:   libc
15628-#   LC_COLLATE:  C
15629-#   LC_CTYPE:    C
15630-#   LC_MESSAGES: en_US.UTF-8
15631-#   LC_MONETARY: C
15632-#   LC_NUMERIC:  C
15633-#   LC_TIME:     C
15634-# The default text search configuration will be set to "english".
15635-# Data page checksums are disabled.
15636-# fixing permissions on existing directory /tmp/unplug-recognition-dAP30D ... ok
15637-# creating subdirectories ... ok
15638-# selecting dynamic shared memory implementation ... posix
15639-# selecting default "max_connections" ... 
```

## Test summary
```text
#   locale provider:   libc
#   LC_COLLATE:  C
#   LC_CTYPE:    C
#   LC_MESSAGES: en_US.UTF-8
#   LC_MONETARY: C
#   LC_NUMERIC:  C
#   LC_TIME:     C
# The default text search configuration will be set to "english".
# Data page checksums are disabled.
# fixing permissions on existing directory /tmp/unplug-weeklymissions-B0gADy ... ok
# creating subdirectories ... ok
# selecting dynamic shared memory implementation ... posix
# selecting default "max_connections" ... 
# 100
# selecting default "shared_buffers" ... 
# 128MB
# selecting default time zone ... 
# Etc/UTC
# creating configuration files ... 
# ok
# running bootstrap script ... 
# ok
# performing post-bootstrap initialization ... 
# ok
# syncing data to disk ... 
# ok
# Success. You can now start the database server using:
#     '/home/runner/work/Unplug-ecosystem/Unplug-ecosystem/unplug-backend/node_modules/@embedded-postgres/linux-x64/native/bin/pg_ctl' -D /tmp/unplug-weeklymissions-B0gADy -l logfile start
# 2026-09-11 08:19:54.662 UTC [8523] LOG:  starting PostgreSQL 17.5 on x86_64-pc-linux-gnu, compiled by gcc (Ubuntu 7.5.0-3ubuntu1~18.04) 7.5.0, 64-bit
# 2026-09-11 08:19:54.663 UTC [8523] LOG:  listening on IPv6 address "::1", port 12899
# 2026-09-11 08:19:54.663 UTC [8523] LOG:  listening on IPv4 address "127.0.0.1", port 12899
# 2026-09-11 08:19:54.664 UTC [8523] LOG:  listening on Unix socket "/tmp/.s.PGSQL.12899"
# 2026-09-11 08:19:54.665 UTC [8526] LOG:  database system was shut down at 2026-09-11 08:19:54 UTC
# 2026-09-11 08:19:54.667 UTC [8523] LOG:  database system is ready to accept connections
# Subtest: get_current_weekly_mission auto-rotates on first read and is stable within the same call
ok 2228 - get_current_weekly_mission auto-rotates on first read and is stable within the same call
  ---
  duration_ms: 1161.827599
  ...
# Subtest: rotate_weekly_mission is idempotent for the same week
ok 2229 - rotate_weekly_mission is idempotent for the same week
  ---
  duration_ms: 1.82147
  ...
# Subtest: assign_weekly_mission gives a member exactly one row for the current week, even if called twice
ok 2230 - assign_weekly_mission gives a member exactly one row for the current week, even if called twice
  ---
  duration_ms: 3.864656
  ...
# Subtest: completing a weekly mission awards points and marks it done, independent of daily missions on the same action
ok 2231 - completing a weekly mission awards points and marks it done, independent of daily missions on the same action
  ---
  duration_ms: 42.860036
  ...
# Subtest: a weekly mission does not complete from a DAILY mission row on the same action code
ok 2232 - a weekly mission does not complete from a DAILY mission row on the same action code
  ---
  duration_ms: 8.660173
  ...
# Subtest: re-running every migration is idempotent — rotation history and mission seeds stay stable
ok 2233 - re-running every migration is idempotent — rotation history and mission seeds stay stable
  ---
  duration_ms: 242.644256
  ...
# 2026-09-11 08:19:55.542 UTC [8523] LOG:  received fast shutdown request
# 2026-09-11 08:19:55.542 UTC [8523] LOG:  aborting any active transactions
# 2026-09-11 08:19:55.543 UTC [8523] LOG:  background worker "logical replication launcher" (PID 8529) exited with exit code 1
# 2026-09-11 08:19:55.545 UTC [8524] LOG:  shutting down
# 2026-09-11 08:19:55.546 UTC [8524] LOG:  checkpoint starting: shutdown immediate
# 2026-09-11 08:19:55.878 UTC [8524] LOG:  checkpoint complete: wrote 1954 buffers (11.9%); 0 WAL file(s) added, 0 removed, 1 recycled; write=0.046 s, sync=0.286 s, total=0.334 s; sync files=1505, longest=0.010 s, average=0.001 s; distance=13123 kB, estimate=13123 kB; lsn=0/21AA350, redo lsn=0/21AA350
# 2026-09-11 08:19:55.883 UTC [8523] LOG:  database system is shut down
1..2233
# tests 2233
# suites 0
# pass 2232
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 365190.993654
```
