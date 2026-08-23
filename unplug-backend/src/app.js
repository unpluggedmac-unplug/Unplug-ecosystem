require('dotenv').config();
const express = require('express');
const { notifyAdminAsync, NOTIFY } = require('./utils/adminNotify');
const cors = require('cors');
const path = require('path');

const requestLogger = require('./middleware/requestLogger');
const securityHeaders = require('./middleware/securityHeaders');
const { attachUser } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const profileRoutes = require('./routes/profiles');
const galleryRoutes = require('./routes/gallery');
const paymentRoutes = require('./routes/payments');
const articleRoutes = require('./routes/articles');
const eventRoutes = require('./routes/events');
const birthdayRoutes = require('./routes/birthdays');
const competitionRoutes = require('./routes/competitions');
const investorRoutes = require('./routes/investors');
const projectRoutes = require('./routes/projects');
const adBannerRoutes = require('./routes/adBanners');
const marketplaceRoutes = require('./routes/marketplace');
const highlightRoutes = require('./routes/highlights');
const salesConsultantRoutes = require('./routes/salesConsultants');
const uploadRoutes = require('./routes/uploads');
const imageRoutes = require('./routes/images');
const maintenanceRoutes = require('./routes/maintenance');
const securityRoutes = require('./routes/security');
const spamRoutes = require('./routes/spam');
const backupRoutes = require('./routes/backups');
const crmRoutes = require('./routes/crm');
const emailRoutes = require('./routes/email');
const agreementRoutes = require('./routes/agreements');
const bulkEmailRoutes = require('./routes/bulkEmail');
const editionRoutes = require('./routes/editions');
const analyticsRoutes = require('./routes/analytics');
const inquiryRoutes = require('./routes/inquiries');
const shoutoutRoutes = require('./routes/shoutouts');
const searchRoutes = require('./routes/search');
const deafCommunityRoutes = require('./routes/deafCommunity');
const newsletterRoutes = require('./routes/newsletter');
const publicSettingsRoutes = require('./routes/publicSettings');
const { router: activityLogRoutes } = require('./routes/activityLog');
const adminPaymentQueueRoutes = require('./routes/adminPaymentQueue');
const savedArticleRoutes = require('./routes/savedArticles');
const commentRoutes = require('./routes/comments');
const pollRoutes = require('./routes/polls');
const feedRoutes = require('./routes/feed');
const reviewRoutes = require('./routes/reviews');
const claimRoutes = require('./routes/claims');
const directoryMapRoutes = require('./routes/directoryMap');
const pageCmsRoutes = require('./routes/pageContent');
const sitemapRoutes = require('./routes/sitemap');
const participationRoutes = require('./routes/participation');
const interactionRoutes = require('./routes/interactions');
const followRoutes = require('./routes/follows');
const memberRoutes = require('./routes/members');
const profileAnalyticsRoutes = require('./routes/profileAnalytics');
const badgeRoutes = require('./routes/badges');
const orderRoutes = require('./routes/orders');
const myUnplugRoutes = require('./routes/myUnplug');
const seoRoutes = require('./routes/seo');

const app = express();

// Behind Render's TLS proxy. Lets req.protocol / req.secure reflect the real
// https scheme (via x-forwarded-proto) so generated URLs aren't http://.
app.set('trust proxy', true);

// Makes the caller's address available to anything running during the request,
// without threading `req` through every function that might want it. The audit
// log reads it from here: logActivity is called from seventy-eight places, and
// editing all of them to pass an address is how some of them get missed — and
// a log with unexplained holes is worse than one with none.
app.use(require('./middleware/requestContext').middleware);

const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : true }));
// 512kb. The largest honest JSON payload is a long article with its gallery
// list; uploads are multipart and handled by multer, which has its own larger
// limits. Express defaults to 100kb, which a long article can exceed — so this
// is raised deliberately rather than left to chance, and bounded deliberately
// rather than left open.
app.use(express.json({ limit: require('./middleware/wafLite').MAX_JSON_BYTES }));
app.use(securityHeaders);
app.use(requestLogger);

// Reads the bearer token (if any) on every request and attaches req.user.
// Individual routes then use requireAuth / requireRole to enforce access.
app.use(attachUser);

// AFTER attachUser, so an account block follows the person rather than the
// machine they happen to be using, and BEFORE every route, so a refused
// request costs a cached lookup instead of a query.
//
// Order between these two matters as well: the access list is consulted first,
// so an address on the allow list is never refused by a pattern. Somebody
// exempted has been exempted deliberately, and a filter second-guessing that
// is how an admin gets locked out mid-incident.
app.use(require('./middleware/accessControl').middleware);
app.use(require('./middleware/wafLite').middleware);

// Health stays reachable regardless — an uptime check must not be able to trip
// a filter and report the site down when it is fine.
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/auth', authRoutes);
app.use('/admin', adminRoutes);
app.use('/', profileRoutes); // exposes /directory and /profiles/*
app.use('/gallery', galleryRoutes);
app.use('/payments', paymentRoutes);
app.use('/articles', articleRoutes);
app.use('/contributors', require('./routes/contributors'));
app.use('/analytics-reports', require('./routes/analyticsReports'));
app.use('/admin/tags', require('./routes/adminTags'));
app.use('/share-cards', require('./routes/shareCards'));
app.use('/events', eventRoutes);
app.use('/birthdays', birthdayRoutes);
app.use('/', competitionRoutes); // exposes /competitions, /entries/:id/vote, /top10
app.use('/investors', investorRoutes);
app.use('/projects', projectRoutes);
app.use('/ad-banners', adBannerRoutes);
app.use('/marketplace', marketplaceRoutes);
app.use('/highlights', highlightRoutes);
app.use('/sales-consultants', salesConsultantRoutes);
app.use('/uploads', uploadRoutes);
// Which stored images have responsive versions. Public and cacheable — the
// frontend asks once and treats a late or missing answer as "originals only".
app.use('/images', imageRoutes);
app.use('/maintenance', maintenanceRoutes);
app.use('/security', securityRoutes);
app.use('/spam', spamRoutes);
app.use('/backups', backupRoutes);
app.use('/crm', crmRoutes);
// Public and unauthenticated on purpose: somebody unsubscribing is holding a
// link from an email, not a password.
app.use('/email', emailRoutes);
// Serves the actual uploaded files back out (GET /uploads/<filename>).
// Mounting static alongside the POST-only uploadRoutes above is safe —
// express.static only ever handles GET/HEAD, so it never intercepts the
// POST / route registered just above it.
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
app.use('/agreements', agreementRoutes);
app.use('/admin/content', require('./routes/adminContent'));
app.use('/admin/bulk-email', bulkEmailRoutes);
app.use('/editions', editionRoutes);
app.use('/analytics', analyticsRoutes);
app.use('/inquiries', inquiryRoutes);
app.use('/shoutouts', shoutoutRoutes);
app.use('/search', searchRoutes);
app.use('/deaf-community', deafCommunityRoutes);
app.use('/newsletter', newsletterRoutes);
app.use('/public-settings', publicSettingsRoutes);
app.use('/admin/activity-log', activityLogRoutes);
app.use('/admin/payment-queue', adminPaymentQueueRoutes);
app.use('/admin/approval-queue', require('./routes/adminApprovalQueue'));
app.use('/admin/links', require('./routes/adminProfileLinks'));
app.use('/cancellations', require('./routes/cancellations'));
app.use('/acquisition', require('./routes/acquisition'));
app.use('/admin/my-unplug', require('./routes/adminMyUnplug'));
app.use('/saved', savedArticleRoutes);
app.use('/comments', commentRoutes);
app.use('/polls', pollRoutes);
app.use('/feed', feedRoutes);
app.use('/reviews', reviewRoutes);
app.use('/claims', claimRoutes);
app.use('/directory', directoryMapRoutes);
app.use('/page-cms', pageCmsRoutes);
app.use('/', sitemapRoutes); // exposes /sitemap.xml and /robots.txt
app.use('/participation', participationRoutes);
app.use('/interactions', interactionRoutes);
app.use('/follows', followRoutes);
app.use('/members', memberRoutes);
app.use('/profile-analytics', profileAnalyticsRoutes);
app.use('/badges', badgeRoutes);
app.use('/orders', orderRoutes);
app.use('/my-unplug', myUnplugRoutes);

// SEO: sitemaps, robots.txt, redirect lookup and the 404 log.
//
// Mounted at the ROOT rather than under a prefix, because /sitemap.xml and
// /robots.txt are addresses crawlers ask for by name — they cannot be moved
// under /seo/. The admin and lookup endpoints inside carry their own paths.
app.use('/', seoRoutes);

// Catches any request that didn't match a route above, so the API always
// responds with clean JSON — never Express's default HTML error page,
// which would be confusing for a frontend to handle.
app.use((req, res) => {
  res.status(404).json({ error: `No route matches ${req.method} ${req.path}.` });
});

// Centralized error handler — keeps error responses consistent and avoids
// leaking stack traces to clients.
app.use((err, req, res, next) => {
  console.error(err);

  // The admin is told about it as well as the log. A 500 that only reaches
  // the server log is a fault nobody finds until a reader reports it.
  //
  // RATE LIMITED BY THE DEDUPE KEY, and that is the important part. A broken
  // endpoint can throw thousands of times a minute; without rolling the same
  // fault into one row, the error would flood the notification list and hide
  // everything else — the outage would erase the very screen you would use to
  // notice it. The key is the route plus the message, so a genuinely
  // different fault still gets its own row.
  const where = (req.method || 'GET') + ' ' + (req.route && req.route.path
    ? (req.baseUrl || '') + req.route.path
    : (req.originalUrl || '').split('?')[0]);
  const reason = String((err && err.message) || 'unknown error');
  notifyAdminAsync({
    type: NOTIFY.SYSTEM_ERROR,
    message: `Something failed on ${where}`,
    plural: `Something failed on ${where} (%n times)`,
    detail: reason,
    link: 'notifications',
    // Same route + same message = same problem, however many times it fires.
    dedupeKey: 'err:' + where + ':' + reason.slice(0, 60),
  });

  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

// Birthday greetings.
//
// Checked hourly rather than once a day: on a free instance the process is
// restarted often and sleeps when idle, so a once-daily timer would simply
// miss most days. The send is idempotent (one greeting per person per year),
// so checking often costs a cheap query and sends nothing extra.
//
// This still only fires while the instance is awake. For a guarantee, point
// an external scheduler at POST /birthdays/send-greetings with
// BIRTHDAY_CRON_SECRET — see OPERATIONS.md.
const { sendDueBirthdayEmails } = require('./utils/birthdayMailer');
const BIRTHDAY_CHECK_MS = 60 * 60 * 1000;
setInterval(() => {
  sendDueBirthdayEmails()
    .then((r) => { if (r && r.sent) console.log(`[birthday] sent ${r.sent} greeting(s) for ${r.date}`); })
    .catch((err) => console.error('[birthday] check failed:', err.message));
}, BIRTHDAY_CHECK_MS);

// Database hygiene: expired tokens and analytics past their retention window,
// then VACUUM ANALYZE. Same shape as the birthday check above, and same
// caveat — this only fires while the instance is awake, so POST
// /maintenance/cleanup with UNPLUG_CLEANUP_SECRET is there for a scheduler
// that wants a guarantee. Running it twice in a day removes nothing extra.
const { runCleanup } = require('./utils/databaseCleanup');
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
setInterval(() => {
  runCleanup({})
    .then((r) => {
      if (r.rowsRemoved) {
        console.log(`[cleanup] removed ${r.rowsRemoved} expired row(s) in ${r.ms}ms`);
      }
    })
    .catch((err) => console.error('[cleanup] failed:', err.message));
}, CLEANUP_INTERVAL_MS);

// Nightly backup. Same in-process pattern as the others, with the same caveat:
// it only fires while the instance is awake, so POST /backups/run with
// UNPLUG_CLEANUP_SECRET is there for a scheduler that wants a guarantee.
//
// SILENT UNLESS CONFIGURED. With no passphrase set this logs once and stops
// trying, rather than writing an error every night that everybody learns to
// scroll past. A backup system nobody trusts the logs of is not one anybody
// checks.
const backupRunner = require('./utils/backupRunner');
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
let backupWarned = false;
setInterval(() => {
  if (!process.env.UNPLUG_BACKUP_PASSPHRASE) {
    if (!backupWarned) {
      console.warn('[backup] UNPLUG_BACKUP_PASSPHRASE is not set — no backups are being taken.');
      backupWarned = true;
    }
    return;
  }
  backupRunner.run()
    .then((r) => console.log(`[backup] ${r.filename}: ${r.rows} rows, `
      + `${(r.encryptedBytes / 1024).toFixed(0)}KB to `
      + r.destinations.filter((d) => d.ok).map((d) => d.provider).join(', ')))
    .catch((err) => console.error('[backup] failed:', err.message));
}, BACKUP_INTERVAL_MS);

// Participation engine: rankings + daily homepage recalculation. No
// pg_cron on this Postgres, so this runs the same way the birthday
// check above does — an in-process interval, not a database job.
require('./utils/participationScheduler').start();

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Unplug backend listening on port ${port}`);
  // Also run shortly after boot, so a restart during the day still catches
  // anyone whose birthday it is.
  setTimeout(() => {
    sendDueBirthdayEmails()
      .then((r) => { if (r && r.sent) console.log(`[birthday] sent ${r.sent} greeting(s) for ${r.date}`); })
      .catch((err) => console.error('[birthday] startup check failed:', err.message));
  }, 20000);
});

module.exports = app;
