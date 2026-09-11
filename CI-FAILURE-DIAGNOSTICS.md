# Temporary CI failure diagnostics

Run: 34576165620
Commit: f8296e16f9cc5218b81bec5908c4ace01e3484a0

```text
ok 2180 - PER-VOTE RATE NEVER INCREASES AS THE TIER GETS BIGGER
  ---
  duration_ms: 0.925464
  ...
# Subtest: NO COMBINATION OF SMALLER TIERS BEATS A LARGER TIER FOR THE SAME OR FEWER VOTES
ok 2181 - NO COMBINATION OF SMALLER TIERS BEATS A LARGER TIER FOR THE SAME OR FEWER VOTES
  ---
  duration_ms: 1.230616
  ...
# Subtest: MIGRATION 169 SURVIVES BEING RE-RUN
ok 2182 - MIGRATION 169 SURVIVES BEING RE-RUN
  ---
  duration_ms: 1.656879
  ...
# 2026-09-11 07:57:06.773 UTC [7732] LOG:  received fast shutdown request
# 2026-09-11 07:57:06.775 UTC [7732] LOG:  aborting any active transactions
# 2026-09-11 07:57:06.777 UTC [7732] LOG:  background worker "logical replication launcher" (PID 7738) exited with exit code 1
# 2026-09-11 07:57:06.777 UTC [7733] LOG:  shutting down
# 2026-09-11 07:57:06.778 UTC [7733] LOG:  checkpoint starting: shutdown immediate
# 2026-09-11 07:57:07.073 UTC [7733] LOG:  checkpoint complete: wrote 1820 buffers (11.1%); 0 WAL file(s) added, 0 removed, 1 recycled; write=0.048 s, sync=0.247 s, total=0.297 s; sync files=1489, longest=0.004 s, average=0.001 s; distance=12597 kB, estimate=12597 kB; lsn=0/2126E00, redo lsn=0/2126E00
# 2026-09-11 07:57:07.081 UTC [7732] LOG:  database system is shut down
# The files belonging to this database system will be owned by user "runner".
# This user must also own the server process.
# The database cluster will be initialized with this locale configuration:
#   locale provider:   libc
#   LC_COLLATE:  C
#   LC_CTYPE:    C
#   LC_MESSAGES: en_US.UTF-8
#   LC_MONETARY: C
#   LC_NUMERIC:  C
#   LC_TIME:     C
# The default text search configuration will be set to "english".
# Data page checksums are disabled.
# fixing permissions on existing directory /tmp/unplug-votebundle-vG2Dfz ... ok
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
#     '/home/runner/work/Unplug-ecosystem/Unplug-ecosystem/unplug-backend/node_modules/@embedded-postgres/linux-x64/native/bin/pg_ctl' -D /tmp/unplug-votebundle-vG2Dfz -l logfile start
# 2026-09-11 07:57:07.831 UTC [7766] LOG:  starting PostgreSQL 17.5 on x86_64-pc-linux-gnu, compiled by gcc (Ubuntu 7.5.0-3ubuntu1~18.04) 7.5.0, 64-bit
# 2026-09-11 07:57:07.831 UTC [7766] LOG:  listening on IPv6 address "::1", port 21041
# 2026-09-11 07:57:07.831 UTC [7766] LOG:  listening on IPv4 address "127.0.0.1", port 21041
# 2026-09-11 07:57:07.832 UTC [7766] LOG:  listening on Unix socket "/tmp/.s.PGSQL.21041"
# 2026-09-11 07:57:07.834 UTC [7769] LOG:  database system was shut down at 2026-09-11 07:57:07 UTC
# 2026-09-11 07:57:07.836 UTC [7766] LOG:  database system is ready to accept connections
# Subtest: an approved entry gets a real 10-digit entry_code automatically
ok 2183 - an approved entry gets a real 10-digit entry_code automatically
  ---
  duration_ms: 1322.834443
  ...
# Subtest: GET /entries/search finds a contestant by (partial) name and reports photo/category/vote count
ok 2184 - GET /entries/search finds a contestant by (partial) name and reports photo/category/vote count
  ---
  duration_ms: 25.426875
  ...
# Subtest: GET /entries/search requires at least 2 characters
ok 2185 - GET /entries/search requires at least 2 characters
  ---
  duration_ms: 3.54438
  ...
# Subtest: GET /entries/by-code resolves the same enriched shape (photo/category/vote count)
ok 2186 - GET /entries/by-code resolves the same enriched shape (photo/category/vote count)
  ---
  duration_ms: 6.327411
  ...
# Subtest: a vote-bundle purchase works fully anonymously — no token, just a sessionId — and is refused without accepting Terms
ok 2187 - a vote-bundle purchase works fully anonymously — no token, just a sessionId — and is refused without accepting Terms
  ---
  duration_ms: 18.747563
  ...
# Subtest: a vote-bundle purchase never touches /payments/initiate or the payments table at all
ok 2188 - a vote-bundle purchase never touches /payments/initiate or the payments table at all
  ---
  duration_ms: 6.645833
  ...
# Subtest: admin approve allocates the votes; a re-approve or an approve of a non-existent status is refused
ok 2189 - admin approve allocates the votes; a re-approve or an approve of a non-existent status is refused
  ---
  duration_ms: 26.052954
  ...
# Subtest: a non-admin cannot approve, reject or reverse a bundle
ok 2190 - a non-admin cannot approve, reject or reverse a bundle
  ---
  duration_ms: 15.289441
  ...
# Subtest: admin reject leaves no votes allocated; admin reverse removes votes an approval already added
ok 2191 - admin reject leaves no votes allocated; admin reverse removes votes an approval already added
  ---
  duration_ms: 18.933578
  ...
# Subtest: the Reference Code IS the contestant entry code, and the buyer is told so
ok 2192 - the Reference Code IS the contestant entry code, and the buyer is told so
  ---
  duration_ms: 5.146548
  ...
# Subtest: two purchases for the SAME contestant share the Reference Code but stay separate orders
ok 2193 - two purchases for the SAME contestant share the Reference Code but stay separate orders
  ---
  duration_ms: 8.768133
  ...
# Subtest: the buyer resolves their own order through the public status lookup
ok 2194 - the buyer resolves their own order through the public status lookup
  ---
  duration_ms: 9.050517
  ...
# Subtest: GET /admin/vote-bundles searches by contestant name, reference and entry code, and filters by status
ok 2195 - GET /admin/vote-bundles searches by contestant name, reference and entry code, and filters by status
  ---
  duration_ms: 16.92658
  ...
# Subtest: re-running every migration is idempotent — vote_bundles reference/terms columns and status values survive
ok 2196 - re-running every migration is idempotent — vote_bundles reference/terms columns and status values survive
  ---
  duration_ms: 213.52362
  ...
# 2026-09-11 07:57:08.914 UTC [7766] LOG:  received fast shutdown request
# 2026-09-11 07:57:08.916 UTC [7766] LOG:  aborting any active transactions
# 2026-09-11 07:57:08.916 UTC [7775] FATAL:  terminating connection due to administrator command
# 2026-09-11 07:57:08.919 UTC [7766] LOG:  background worker "logical replication launcher" (PID 7772) exited with exit code 1
# 2026-09-11 07:57:08.919 UTC [7767] LOG:  shutting down
# 2026-09-11 07:57:08.920 UTC [7767] LOG:  checkpoint starting: shutdown immediate
# 2026-09-11 07:57:09.225 UTC [7767] LOG:  checkpoint complete: wrote 1918 buffers (11.7%); 0 WAL file(s) added, 0 removed, 1 recycled; write=0.050 s, sync=0.253 s, total=0.306 s; sync files=1505, longest=0.012 s, average=0.001 s; distance=13087 kB, estimate=13087 kB; lsn=0/21A1430, redo lsn=0/21A1430
# 2026-09-11 07:57:09.233 UTC [7766] LOG:  database system is shut down
# The files belonging to this database system will be owned by user "runner".
# This user must also own the server process.
# The database cluster will be initialized with this locale configuration:
#   locale provider:   libc
#   LC_COLLATE:  C
#   LC_CTYPE:    C
#   LC_MESSAGES: en_US.UTF-8
#   LC_MONETARY: C
#   LC_NUMERIC:  C
#   LC_TIME:     C
# The default text search configuration will be set to "english".
# Data page checksums are disabled.
# fixing permissions on existing directory /tmp/unplug-voteref-XdLSHi ... ok
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
#     '/home/runner/work/Unplug-ecosystem/Unplug-ecosystem/unplug-backend/node_modules/@embedded-postgres/linux-x64/native/bin/pg_ctl' -D /tmp/unplug-voteref-XdLSHi -l logfile start
# 2026-09-11 07:57:09.967 UTC [7800] LOG:  starting PostgreSQL 17.5 on x86_64-pc-linux-gnu, compiled by gcc (Ubuntu 7.5.0-3ubuntu1~18.04) 7.5.0, 64-bit
# 2026-09-11 07:57:09.967 UTC [7800] LOG:  listening on IPv6 address "::1", port 23876
# 2026-09-11 07:57:09.967 UTC [7800] LOG:  listening on IPv4 address "127.0.0.1", port 23876
# 2026-09-11 07:57:09.968 UTC [7800] LOG:  listening on Unix socket "/tmp/.s.PGSQL.23876"
# 2026-09-11 07:57:09.970 UTC [7803] LOG:  database system was shut down at 2026-09-11 07:57:09 UTC
# 2026-09-11 07:57:09.972 UTC [7800] LOG:  database system is ready to accept connections
# Subtest: the Reference Code is the entry code, exactly
ok 2197 - the Reference Code is the entry code, exactly
  ---
  duration_ms: 1334.925837
  ...
# Subtest: a second buyer for the same contestant can still check out
ok 2198 - a second buyer for the same contestant can still check out
  ---
  duration_ms: 7.260365
  ...
# Subtest: the buyer can check their own purchase with their lookup token
ok 2199 - the buyer can check their own purchase with their lookup token
  ---
  duration_ms: 7.175209
  ...
# Subtest: a bare entry code cannot be used to open someone else's purchase
ok 2200 - a bare entry code cannot be used to open someone else's purchase
  ---
  duration_ms: 5.664317
  ...
# Subtest: a bare entry code cannot be used to attach proof of payment
ok 2201 - a bare entry code cannot be used to attach proof of payment
  ---
  duration_ms: 3.460836
  ...
# Subtest: the buyer can attach proof with their lookup token
ok 2202 - the buyer can attach proof with their lookup token
  ---
  duration_ms: 3.348189
  ...
# Subtest: links already sent out with an old-style reference keep working
ok 2203 - links already sent out with an old-style reference keep working
  ---
  duration_ms: 3.379305
  ...
# Subtest: an admin can add votes, and the total really moves
ok 2204 - an admin can add votes, and the total really moves
  ---
  duration_ms: 10.634151
  ...
# Subtest: an admin can remove votes
ok 2205 - an admin can remove votes
  ---
  duration_ms: 6.884127
  ...
# Subtest: an adjustment cannot take a total below zero
ok 2206 - an adjustment cannot take a total below zero
  ---
  duration_ms: 4.855536
  ...
# Subtest: an adjustment requires a reason and a non-zero whole number
ok 2207 - an adjustment requires a reason and a non-zero whole number
  ---
  duration_ms: 7.13613
  ...
# Subtest: every adjustment is written to the audit log with both totals
ok 2208 - every adjustment is written to the audit log with both totals
  ---
  duration_ms: 5.820258
  ...
# Subtest: vote adjustment is admin-only
ok 2209 - vote adjustment is admin-only
  ---
  duration_ms: 5.117634
  ...
# Subtest: re-running every migration is idempotent
ok 2210 - re-running every migration is idempotent
  ---
  duration_ms: 219.160565
  ...
# 2026-09-11 07:57:10.991 UTC [7800] LOG:  received fast shutdown request
# 2026-09-11 07:57:10.992 UTC [7800] LOG:  aborting any active transactions
# 2026-09-11 07:57:10.992 UTC [7809] FATAL:  terminating connection due to administrator command
# 2026-09-11 07:57:10.993 UTC [7800] LOG:  background worker "logical replication launcher" (PID 7806) exited with exit code 1
# 2026-09-11 07:57:10.996 UTC [7801] LOG:  shutting down
# 2026-09-11 07:57:10.996 UTC [7801] LOG:  checkpoint starting: shutdown immediate
# 2026-09-11 07:57:11.280 UTC [7801] LOG:  checkpoint complete: wrote 1918 buffers (11.7%); 0 WAL file(s) added, 0 removed, 1 recycled; write=0.051 s, sync=0.231 s, total=0.285 s; sync files=1505, longest=0.002 s, average=0.001 s; distance=13050 kB, estimate=13050 kB; lsn=0/2198260, redo lsn=0/2198260
# 2026-09-11 07:57:11.289 UTC [7800] LOG:  database system is shut down
# The files belonging to this database system will be owned by user "runner".
# This user must also own the server process.
# The database cluster will be initialized with this locale configuration:
#   locale provider:   libc
#   LC_COLLATE:  C
#   LC_CTYPE:    C
#   LC_MESSAGES: en_US.UTF-8
#   LC_MONETARY: C
#   LC_NUMERIC:  C
#   LC_TIME:     C
# The default text search configuration will be set to "english".
# Data page checksums are disabled.
# fixing permissions on existing directory /tmp/unplug-vote92-B5KzR9 ... ok
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
#     '/home/runner/work/Unplug-ecosystem/Unplug-ecosystem/unplug-backend/node_modules/@embedded-postgres/linux-x64/native/bin/pg_ctl' -D /tmp/unplug-vote92-B5KzR9 -l logfile start
# 2026-09-11 07:57:12.079 UTC [7834] LOG:  starting PostgreSQL 17.5 on x86_64-pc-linux-gnu, compiled by gcc (Ubuntu 7.5.0-3ubuntu1~18.04) 7.5.0, 64-bit
# 2026-09-11 07:57:12.079 UTC [7834] LOG:  listening on IPv6 address "::1", port 54010
# 2026-09-11 07:57:12.079 UTC [7834] LOG:  listening on IPv4 address "127.0.0.1", port 54010
# 2026-09-11 07:57:12.080 UTC [7834] LOG:  listening on Unix socket "/tmp/.s.PGSQL.54010"
# 2026-09-11 07:57:12.082 UTC [7837] LOG:  database system was shut down at 2026-09-11 07:57:11 UTC
# 2026-09-11 07:57:12.084 UTC [7834] LOG:  database system is ready to accept connections
# Subtest: THE RULE SHIPS OFF
ok 2211 - THE RULE SHIPS OFF
  ---
  duration_ms: 1362.637171
  ...
# Subtest: a cap below one is refused by the database
ok 2212 - a cap below one is refused by the database
  ---
  duration_ms: 1.128375
  ...
# 2026-09-11 07:57:12.786 UTC [7842] ERROR:  new row for relation "competitions" violates check constraint "competitions_daily_vote_limit_check"
# 2026-09-11 07:57:12.786 UTC [7842] DETAIL:  Failing row contains (3, Capped Comp, capped-comp, null, 2026-09-10 07:57:12.774858+00, 2026-10-11 07:57:12.774858+00, open, 2026-09-11 07:57:12.774858+00, 50.00, t, 0, null, null, null, null).
# 2026-09-11 07:57:12.786 UTC [7842] STATEMENT:  UPDATE competitions SET daily_vote_limit = 0 WHERE id = $1
# Subtest: NOTHING CHANGES FOR A COMPETITION WITH NO CAP
ok 2213 - NOTHING CHANGES FOR A COMPETITION WITH NO CAP
  ---
  duration_ms: 114.914057
  ...
# 2026-09-11 07:57:12.906 UTC [7843] ERROR:  duplicate key value violates unique constraint "idx_votes_daily_user"
# 2026-09-11 07:57:12.906 UTC [7843] DETAIL:  Key (entry_id, voter_user_id, vote_day)=(9, 940501, 2026-09-11) already exists.
# 2026-09-11 07:57:12.906 UTC [7843] STATEMENT:  INSERT INTO votes (entry_id, voter_user_id, session_id, bundle_size, vote_day)
# \\t       VALUES ($1, $2, $3, 1,
# \\t               CASE WHEN $4::boolean
# \\t                    THEN (now() AT TIME ZONE 'Africa/Johannesburg')::date
# \\t                    ELSE NULL END)
# \\t       RETURNING *
# Subtest: ...and the same entry twice in a day is still refused
ok 2214 - ...and the same entry twice in a day is still refused
  ---
  duration_ms: 5.326925
  ...
# Subtest: §9.2: FIVE VOTES A DAY, THEN NO MORE
ok 2215 - §9.2: FIVE VOTES A DAY, THEN NO MORE
  ---
  duration_ms: 32.01949
  ...
# 2026-09-11 07:57:12.942 UTC [7846] ERROR:  duplicate key value violates unique constraint "idx_votes_daily_user"
# 2026-09-11 07:57:12.942 UTC [7846] DETAIL:  Key (entry_id, voter_user_id, vote_day)=(9, 940501, 2026-09-11) already exists.
# 2026-09-11 07:57:12.942 UTC [7846] STATEMENT:  INSERT INTO votes (entry_id, voter_user_id, session_id, bundle_size, vote_day)
# \\t       VALUES ($1, $2, $3, 1,
# \\t               CASE WHEN $4::boolean
# \\t                    THEN (now() AT TIME ZONE 'Africa/Johannesburg')::date
# \\t                    ELSE NULL END)
# \\t       RETURNING *
# Subtest: the cap is per COMPETITION, not per entry
ok 2216 - the cap is per COMPETITION, not per entry
  ---
  duration_ms: 3.300488
  ...
# Subtest: a voter is told what they have left, not only when they run out
ok 2217 - a voter is told what they have left, not only when they run out
  ---
  duration_ms: 6.35437
  ...
# 2026-09-11 07:57:12.961 UTC [7846] ERROR:  duplicate key value violates unique constraint "idx_votes_daily_user"
# 2026-09-11 07:57:12.961 UTC [7846] DETAIL:  Key (entry_id, voter_user_id, vote_day)=(1, 940503, 2026-09-11) already exists.
# 2026-09-11 07:57:12.961 UTC [7846] STATEMENT:  INSERT INTO votes (entry_id, voter_user_id, session_id, bundle_size, vote_day)
# \\t       VALUES ($1, $2, $3, 1,
# \\t               CASE WHEN $4::boolean
# \\t                    THEN (now() AT TIME ZONE 'Africa/Johannesburg')::date
# \\t                    ELSE NULL END)
# \\t       RETURNING *
# Subtest: §9.2 IS ALREADY SPREAD ACROSS CONTESTANTS
ok 2218 - §9.2 IS ALREADY SPREAD ACROSS CONTESTANTS
  ---
  duration_ms: 12.857633
  ...
# Subtest: concurrent votes do not exceed the cap
ok 2219 - concurrent votes do not exceed the cap
  ---
  duration_ms: 42.797596
  ...
# Subtest: PAID BULK VOTES ARE NEVER CAPPED
ok 2220 - PAID BULK VOTES ARE NEVER CAPPED
  ---
  duration_ms: 3.659
  ...
# Subtest: §8.5: A CONTESTANT SEES THEIR CODE AND EXACT VERIFIED VOTES
ok 2221 - §8.5: A CONTESTANT SEES THEIR CODE AND EXACT VERIFIED VOTES
  ---
  duration_ms: 8.273038
  ...
# Subtest: §8.5: ranking, closing date and competition status are all there
ok 2222 - §8.5: ranking, closing date and competition status are all there
  ---
  duration_ms: 1.404895
  ...
# Subtest: the ranking is over the whole competition, not just my entries
ok 2223 - the ranking is over the whole competition, not just my entries
  ---
  duration_ms: 1.36121
  ...
# Subtest: an unapproved entry has no code and no ranking
ok 2224 - an unapproved entry has no code and no ranking
  ---
  duration_ms: 2.228057
  ...
# Subtest: the endpoint still returns vote_count, so nothing already reading it breaks
ok 2225 - the endpoint still returns vote_count, so nothing already reading it breaks
  ---
  duration_ms: 3.678028
  ...
# Subtest: THE LOCK ACTUALLY SERIALISES ONE VOTER, WHICH IS WHAT MAKES THE CAP EXACT
ok 2226 - THE LOCK ACTUALLY SERIALISES ONE VOTER, WHICH IS WHAT MAKES THE CAP EXACT
  ---
  duration_ms: 305.742357
  ...
# Subtest: two different voters are never made to wait for each other
ok 2227 - two different voters are never made to wait for each other
  ---
  duration_ms: 1.26681
  ...
# 2026-09-11 07:57:13.334 UTC [7834] LOG:  received fast shutdown request
# 2026-09-11 07:57:13.335 UTC [7834] LOG:  aborting any active transactions
# 2026-09-11 07:57:13.335 UTC [7851] FATAL:  terminating connection due to administrator command
# 2026-09-11 07:57:13.335 UTC [7844] FATAL:  terminating connection due to administrator command
# 2026-09-11 07:57:13.335 UTC [7853] FATAL:  terminating connection due to administrator command
# 2026-09-11 07:57:13.335 UTC [7843] FATAL:  terminating connection due to administrator command
# 2026-09-11 07:57:13.337 UTC [7846] FATAL:  terminating connection due to administrator command
# 2026-09-11 07:57:13.337 UTC [7849] FATAL:  terminating connection due to administrator command
# 2026-09-11 07:57:13.337 UTC [7850] FATAL:  terminating connection due to administrator command
# 2026-09-11 07:57:13.338 UTC [7834] LOG:  background worker "logical replication launcher" (PID 7840) exited with exit code 1
# 2026-09-11 07:57:13.338 UTC [7845] FATAL:  terminating connection due to administrator command
# 2026-09-11 07:57:13.339 UTC [7848] FATAL:  terminating connection due to administrator command
# 2026-09-11 07:57:13.340 UTC [7852] FATAL:  terminating connection due to administrator command
# 2026-09-11 07:57:13.342 UTC [7835] LOG:  shutting down
# 2026-09-11 07:57:13.367 UTC [7835] LOG:  checkpoint starting: shutdown immediate
# 2026-09-11 07:57:13.677 UTC [7835] LOG:  checkpoint complete: wrote 1951 buffers (11.9%); 0 WAL file(s) added, 0 removed, 1 recycled; write=0.051 s, sync=0.258 s, total=0.336 s; sync files=1490, longest=0.031 s, average=0.001 s; distance=12680 kB, estimate=12680 kB; lsn=0/213B808, redo lsn=0/213B808
# 2026-09-11 07:57:13.685 UTC [7834] LOG:  database system is shut down
# The files belonging to this database system will be owned by user "runner".
# This user must also own the server process.
# The database cluster will be initialized with this locale configuration:
#   locale provider:   libc
#   LC_COLLATE:  C
#   LC_CTYPE:    C
#   LC_MESSAGES: en_US.UTF-8
#   LC_MONETARY: C
#   LC_NUMERIC:  C
#   LC_TIME:     C
# The default text search configuration will be set to "english".
# Data page checksums are disabled.
# fixing permissions on existing directory /tmp/unplug-weeklymissions-AtTlfX ... ok
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
#     '/home/runner/work/Unplug-ecosystem/Unplug-ecosystem/unplug-backend/node_modules/@embedded-postgres/linux-x64/native/bin/pg_ctl' -D /tmp/unplug-weeklymissions-AtTlfX -l logfile start
# 2026-09-11 07:57:14.424 UTC [7879] LOG:  starting PostgreSQL 17.5 on x86_64-pc-linux-gnu, compiled by gcc (Ubuntu 7.5.0-3ubuntu1~18.04) 7.5.0, 64-bit
# 2026-09-11 07:57:14.425 UTC [7879] LOG:  listening on IPv6 address "::1", port 12855
# 2026-09-11 07:57:14.425 UTC [7879] LOG:  listening on IPv4 address "127.0.0.1", port 12855
# 2026-09-11 07:57:14.426 UTC [7879] LOG:  listening on Unix socket "/tmp/.s.PGSQL.12855"
# 2026-09-11 07:57:14.428 UTC [7882] LOG:  database system was shut down at 2026-09-11 07:57:14 UTC
# 2026-09-11 07:57:14.430 UTC [7879] LOG:  database system is ready to accept connections
# Subtest: get_current_weekly_mission auto-rotates on first read and is stable within the same call
ok 2228 - get_current_weekly_mission auto-rotates on first read and is stable within the same call
  ---
  duration_ms: 1284.10488
  ...
# Subtest: rotate_weekly_mission is idempotent for the same week
ok 2229 - rotate_weekly_mission is idempotent for the same week
  ---
  duration_ms: 1.461529
  ...
# Subtest: assign_weekly_mission gives a member exactly one row for the current week, even if called twice
ok 2230 - assign_weekly_mission gives a member exactly one row for the current week, even if called twice
  ---
  duration_ms: 3.54451
  ...
# Subtest: completing a weekly mission awards points and marks it done, independent of daily missions on the same action
ok 2231 - completing a weekly mission awards points and marks it done, independent of daily missions on the same action
  ---
  duration_ms: 45.282123
  ...
# Subtest: a weekly mission does not complete from a DAILY mission row on the same action code
ok 2232 - a weekly mission does not complete from a DAILY mission row on the same action code
  ---
  duration_ms: 8.978935
  ...
# Subtest: re-running every migration is idempotent — rotation history and mission seeds stay stable
ok 2233 - re-running every migration is idempotent — rotation history and mission seeds stay stable
  ---
  duration_ms: 217.675468
  ...
# 2026-09-11 07:57:15.379 UTC [7879] LOG:  received fast shutdown request
# 2026-09-11 07:57:15.380 UTC [7879] LOG:  aborting any active transactions
# 2026-09-11 07:57:15.381 UTC [7879] LOG:  background worker "logical replication launcher" (PID 7885) exited with exit code 1
# 2026-09-11 07:57:15.383 UTC [7880] LOG:  shutting down
# 2026-09-11 07:57:15.384 UTC [7880] LOG:  checkpoint starting: shutdown immediate
# 2026-09-11 07:57:15.691 UTC [7880] LOG:  checkpoint complete: wrote 1954 buffers (11.9%); 0 WAL file(s) added, 0 removed, 1 recycled; write=0.052 s, sync=0.253 s, total=0.308 s; sync files=1505, longest=0.011 s, average=0.001 s; distance=13123 kB, estimate=13123 kB; lsn=0/21AA350, redo lsn=0/21AA350
# 2026-09-11 07:57:15.700 UTC [7879] LOG:  database system is shut down
1..2233
# tests 2233
# suites 0
# pass 2232
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 458099.889128
```
