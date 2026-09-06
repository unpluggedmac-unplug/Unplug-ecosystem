# Unplug Control Centre — Phase 8

## Analytics, Business Reporting & Export

Phase 8 adds a unified business report to the existing Analytics area. It is read-only and uses the existing source-of-truth tables rather than copying business data into a second reporting database.

### New backend route

`src/routes/adminBusinessReports.js`, mounted at `/admin/business-reports`.

Endpoints:
- `GET /admin/business-reports/summary?from=&to=` — unified KPI/report payload.
- `GET /admin/business-reports/export.csv?from=&to=` — UTF-8 CSV suitable for Google Sheets/Excel.
- `GET /admin/business-reports/export.xls?from=&to=` — dependency-free Excel-compatible workbook download.

### Report coverage

The report currently includes:
- confirmed revenue and payment count;
- current pending payment count/value;
- failed payments;
- new members;
- submissions across articles, events, Directory profiles, Gallery, competition entries, forms and banner advertising;
- pending approval workload;
- page views/visitors;
- competition votes;
- inquiries/forms;
- active advertising banners;
- admin/audit activity;
- revenue split by purchased service;
- daily history for revenue, members, payments, articles, page views and votes;
- comparison against the immediately preceding equal-length period.

Optional newer tables are checked before querying so an environment missing a later optional feature does not make the entire report fail.

### Admin UI

The Site Analytics screen now begins with **Unplug Business Report**.

Ranges:
- Today
- 7 Days
- 30 Days
- This Month
- This Year
- Custom date range

Exports are visible only when the signed-in account has `reports.export`.

### Permissions

`analytics.view` grants read access to the business report.

`reports.export` grants CSV/Excel download access.

Super Admin automatically has both.

### Database migration

No Phase 8 migration is required. Reporting reads existing operational/analytics tables so historical data already present remains available.

### Validation completed

- `node --check src/routes/adminBusinessReports.js`
- `node --check src/app.js`
- `node --check src/utils/staffPermissions.js`
- extracted main admin inline JavaScript passes `node --check`
- representative permission routing verified:
  - summary -> `analytics.view`
  - CSV/XLS export -> `reports.export`

### Known environment limitation

The downloaded repository still has an incomplete frontend dependency installation: `node_modules/esbuild/bin/esbuild` is absent. Full build/integration testing therefore remains a staging/deployment prerequisite and is not represented as complete here.
