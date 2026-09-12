require('dotenv').config();
require('./utils/validateEnv')();
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

// Render terminates TLS in front of this process. Trust only the nearest proxy hop.
app.set('trust proxy', 1);
app.use(require('./middleware/requestContext').middleware);

const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const corsOrigin = allowedOrigins.length ? allowedOrigins : (process.env.NODE_ENV === 'production' ? false : true);
app.use(cors({ origin: corsOrigin }));

// Mail webhooks verify signatures against raw bytes, so they bypass only the JSON parser.
const jsonParser = express.json({ limit: require('./middleware/wafLite').MAX_JSON_BYTES });
app.use((req, res, next) => {
  if (req.path.startsWith('/email/webhooks')) return next();
  return jsonParser(req, res, next);
});
app.use(securityHeaders);
app.use(requestLogger);
app.use(attachUser);
app.use(require('./middleware/accessControl').middleware);
app.use(require('./middleware/wafLite').middleware);

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/health/ready', async (req, res) => {
  try {
    const pool = require('./db');
    await pool.query('SELECT 1');
    return res.json({ status: 'ready', database: 'ok' });
  } catch (err) {
    console.error('[readiness] database check failed:', err.message);
    return res.status(503).json({ status: 'not_ready', database: 'unavailable' });
  }
});

app.use('/email/webhooks', require('./routes/emailWebhooks'));
app.use('/auth', authRoutes);
app.use('/admin', adminRoutes);
app.use('/admin/staff', require('./routes/adminStaff'));
app.use('/admin/business-reports', require('./routes/adminBusinessReports'));
app.use('/admin/checkout-health', require('./routes/adminCheckoutHealth'));
app.use('/', profileRoutes);
app.use('/gallery', galleryRoutes);
app.use('/payments', paymentRoutes);
app.use('/articles', articleRoutes);
app.use('/contributors', require('./routes/contributors'));
app.use('/analytics-reports', require('./routes/analyticsReports'));
app.use('/admin/tags', require('./routes/adminTags'));
app.use('/share-cards', require('./routes/shareCards'));
app.use('/events', eventRoutes);
app.use('/birthdays', birthdayRoutes);
app.use('/', competitionRoutes);
app.use('/investors', investorRoutes);
app.use('/projects', projectRoutes);
app.use('/ad-banners', adBannerRoutes);
app.use('/marketplace', marketplaceRoutes);
app.use('/highlights', highlightRoutes);
app.use('/sales-consultants', salesConsultantRoutes);
app.use('/uploads', uploadRoutes);
app.use('/images', imageRoutes);
app.use('/maintenance', maintenanceRoutes);
app.use('/security', securityRoutes);
app.use('/spam', spamRoutes);
app.use('/backups', backupRoutes);
app.use('/crm', crmRoutes);
app.use('/email', emailRoutes);
app.use('/admin/email', require('./routes/emailCampaigns'));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
app.use('/agreements', agreementRoutes);
app.use('/admin/content', require('./routes/adminContent'));
app.use('/admin/search', require('./routes/adminSearch'));
app.use('/admin/media', require('./routes/adminMedia'));
app.use('/admin/bulk-email', bulkEmailRoutes);
app.use('/editions', editionRoutes);
app.use('/analytics', analyticsRoutes);
app.use('/inquiries', inquiryRoutes);
app.use('/shoutouts', shoutoutRoutes);
app.use('/search', searchRoutes);
app.use('/deaf-community', deafCommunityRoutes);
app.use('/newsletter', newsletterRoutes);
app.use('/popups', require('./routes/popups'));
app.use('/site-buttons', require('./routes/siteButtons'));
app.use('/testimonials', require('./routes/testimonials'));
app.use('/impact-makers', require('./routes/impactMakers'));
app.use('/social', require('./routes/social'));
app.use('/forms', require('./routes/forms'));

// Agreement Forms remain a separate domain from Growth Applications.
const agreementFormsRoutes = require('./routes/agreementForms');
app.use('/agreement-forms', require('./middleware/agreementPaymentPolicy'));
app.use('/agreement-forms', agreementFormsRoutes.router);
app.use('/a', agreementFormsRoutes.shortLinkRouter);
app.use('/agreement-payments', require('./routes/agreementPayments'));

// Growth V2 is mounted before the legacy Growth router. This lets the new,
// versioned member/admin workflow coexist while staging validation is completed.
app.use('/growth-application/v2', require('./routes/growthApplicationV2'));
app.use('/growth-admin', require('./routes/growthAdmin'));
const growthApplicationRoutes = require('./routes/growthApplication');
app.use('/growth-application', growthApplicationRoutes.router);
app.use('/grow', growthApplicationRoutes.shortLinkRouter);

app.use('/privacy', require('./routes/privacy'));
app.use('/sasl', require('./routes/sasl'));
app.use('/public-settings', publicSettingsRoutes);
app.use('/admin/activity-log', activityLogRoutes);
app.use('/admin/payment-queue', adminPaymentQueueRoutes);
app.use('/admin/approval-queue', require('./routes/adminApprovalQueue'));
app.use('/change-requests', require('./routes/changeRequests'));
app.use('/admin/covers', require('./routes/adminCovers'));
app.use('/image-specs', require('./routes/imageSpecs'));
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
app.use('/', sitemapRoutes);
app.use('/participation', participationRoutes);
app.use('/interactions', interactionRoutes);
app.use('/follows', followRoutes);
app.use('/members', memberRoutes);
app.use('/profile-analytics', profileAnalyticsRoutes);
app.use('/badges', badgeRoutes);
app.use('/orders', orderRoutes);
app.use('/my-unplug', myUnplugRoutes);
app.use('/my', require('./routes/mySubmissions'));
app.use('/', seoRoutes);

app.use((req, res) => {
  res.status(404).json({ error: `No route matches ${req.method} ${req.path}.` });
});

app.use((err, req, res, next) => {
  console.error(err);
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
    dedupeKey: 'err:' + where + ':' + reason.slice(0, 60),
  });
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

const { sendDueBirthdayEmails } = require('./utils/birthdayMailer');
const BIRTHDAY_CHECK_MS = 60 * 60 * 1000;
setInterval(() => {
  sendDueBirthdayEmails()
    .then((r) => { if (r && r.sent) console.log(`[birthday] sent ${r.sent} greeting(s) for ${r.date}`); })
    .catch((err) => console.error('[birthday] check failed:', err.message));
}, BIRTHDAY_CHECK_MS);

const { runCleanup } = require('./utils/databaseCleanup');
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
setInterval(() => {
  runCleanup({})
    .then((r) => {
      if (r.rowsRemoved) console.log(`[cleanup] removed ${r.rowsRemoved} expired row(s) in ${r.ms}ms`);
    })
    .catch((err) => console.error('[cleanup] failed:', err.message));
}, CLEANUP_INTERVAL_MS);

require('./utils/activityReportScheduler').start();

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

require('./utils/participationScheduler').start();
require('./utils/emailScheduler').start();

if (process.env.UNPLUG_CHECKOUT_RECOVERY === 'on') {
  require('./utils/checkoutRecovery').start();
  console.log('[recovery] checkout reminders are ON');
}

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Unplug backend listening on port ${port}`);
  setTimeout(() => {
    sendDueBirthdayEmails()
      .then((r) => { if (r && r.sent) console.log(`[birthday] sent ${r.sent} greeting(s) for ${r.date}`); })
      .catch((err) => console.error('[birthday] startup check failed:', err.message));
  }, 20000);
});

module.exports = app;