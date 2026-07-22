require('dotenv').config();
const express = require('express');
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
const marketplaceRoutes = require('./routes/marketplace');
const highlightRoutes = require('./routes/highlights');
const salesConsultantRoutes = require('./routes/salesConsultants');
const uploadRoutes = require('./routes/uploads');
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
const savedArticleRoutes = require('./routes/savedArticles');
const commentRoutes = require('./routes/comments');
const pollRoutes = require('./routes/polls');
const feedRoutes = require('./routes/feed');
const reviewRoutes = require('./routes/reviews');
const claimRoutes = require('./routes/claims');
const directoryMapRoutes = require('./routes/directoryMap');
const pageCmsRoutes = require('./routes/pageContent');
const sitemapRoutes = require('./routes/sitemap');

const app = express();

const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : true }));
app.use(express.json());
app.use(securityHeaders);
app.use(requestLogger);

// Reads the bearer token (if any) on every request and attaches req.user.
// Individual routes then use requireAuth / requireRole to enforce access.
app.use(attachUser);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/auth', authRoutes);
app.use('/admin', adminRoutes);
app.use('/', profileRoutes); // exposes /directory and /profiles/*
app.use('/gallery', galleryRoutes);
app.use('/payments', paymentRoutes);
app.use('/articles', articleRoutes);
app.use('/events', eventRoutes);
app.use('/birthdays', birthdayRoutes);
app.use('/', competitionRoutes); // exposes /competitions, /entries/:id/vote, /top10
app.use('/investors', investorRoutes);
app.use('/marketplace', marketplaceRoutes);
app.use('/highlights', highlightRoutes);
app.use('/sales-consultants', salesConsultantRoutes);
app.use('/uploads', uploadRoutes);
// Serves the actual uploaded files back out (GET /uploads/<filename>).
// Mounting static alongside the POST-only uploadRoutes above is safe —
// express.static only ever handles GET/HEAD, so it never intercepts the
// POST / route registered just above it.
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
app.use('/agreements', agreementRoutes);
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
app.use('/saved', savedArticleRoutes);
app.use('/comments', commentRoutes);
app.use('/polls', pollRoutes);
app.use('/feed', feedRoutes);
app.use('/reviews', reviewRoutes);
app.use('/claims', claimRoutes);
app.use('/directory', directoryMapRoutes);
app.use('/page-cms', pageCmsRoutes);
app.use('/', sitemapRoutes); // exposes /sitemap.xml and /robots.txt

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
