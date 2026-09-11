'use strict';

// Quick Profile and Growth Assessment are the structured intake layers that
// precede the owner-verbatim Deep Discovery bank. The recovered handover locks
// their required content groups, but not exact field-by-field wording, so these
// fields are versioned separately from the Deep Discovery source.

const STAGE_SCHEMA_VERSION = '2026-09-11-intake-v1';

const socialFields = [
  ['facebook_url', 'Facebook profile/page'],
  ['instagram_url', 'Instagram'],
  ['tiktok_url', 'TikTok'],
  ['linkedin_url', 'LinkedIn'],
  ['youtube_url', 'YouTube'],
  ['x_url', 'X / Twitter'],
].map(([key, label]) => ({ key, label, type: 'url', required: true, allow_unavailable: true }));

const quickProfileCommon = [
  { key: 'phone', label: 'Phone number', type: 'tel', required: true, allow_unavailable: true },
  { key: 'location', label: 'Where are you based?', type: 'text', required: true },
  { key: 'website_url', label: 'Website', type: 'url', required: true, allow_unavailable: true },
  { key: 'portfolio_url', label: 'Portfolio / work examples', type: 'url', required: true, allow_unavailable: true },
  ...socialFields,
  {
    key: 'tone_brand_style_unique',
    label: 'Tell us about your tone, branding, style and what makes you unique.',
    type: 'textarea',
    required: true,
    nudge_short_answer: true,
  },
  {
    key: 'what_you_are_after',
    label: 'What are you hoping Unplug can help you move toward right now?',
    type: 'textarea',
    required: true,
    nudge_short_answer: true,
  },
];

const quickProfile = {
  individual: [
    { key: 'full_name', label: 'Name and surname', type: 'text', required: true },
    { key: 'public_name', label: 'Name you would like the public to know you by', type: 'text', required: true },
    ...quickProfileCommon,
  ],
  business: [
    { key: 'business_name', label: 'Business name', type: 'text', required: true },
    { key: 'contact_person', label: 'Primary contact person', type: 'text', required: true },
    ...quickProfileCommon,
  ],
};

const growthAssessment = [
  {
    key: 'your_story',
    label: 'Tell us your story — what has brought you or your business to this point?',
    type: 'textarea',
    required: true,
    nudge_short_answer: true,
  },
  {
    key: 'current_position',
    label: 'Where are you right now in your journey?',
    type: 'textarea',
    required: true,
    nudge_short_answer: true,
  },
  {
    key: 'main_goal',
    label: 'What is the most important goal you want to achieve next?',
    type: 'textarea',
    required: true,
    nudge_short_answer: true,
  },
  {
    key: 'biggest_barrier',
    label: 'What is currently getting in the way of that goal?',
    type: 'textarea',
    required: true,
    nudge_short_answer: true,
  },
  {
    key: 'support_needed',
    label: 'What kind of support would make the biggest difference right now?',
    type: 'textarea',
    required: true,
    nudge_short_answer: true,
  },
  {
    key: 'twelve_month_result',
    label: 'Twelve months from now, what result would make you feel this journey genuinely moved forward?',
    type: 'textarea',
    required: true,
    nudge_short_answer: true,
  },
];

function schemaFor(type) {
  return {
    version: STAGE_SCHEMA_VERSION,
    quick_profile: quickProfile[type] || [],
    growth_assessment: growthAssessment,
    galleries: [
      {
        key: 'brand_style_images',
        label: 'Brand / style imagery',
        help: 'Up to 10 images that show your brand, style, visual identity or inspiration.',
        max_images: 10,
        max_bytes_each: 10 * 1024 * 1024,
      },
      {
        key: 'applicant_team_images',
        label: 'You / team / space',
        help: 'Up to 10 photos of you, your team, workspace or business space.',
        max_images: 10,
        max_bytes_each: 10 * 1024 * 1024,
      },
    ],
  };
}

function isCompleteValue(field, value) {
  if (field.allow_unavailable && value && typeof value === 'object' && value.unavailable === true) return true;
  if (typeof value === 'string') return value.trim().length > 0;
  if (value && typeof value === 'object') return String(value.value || value.answer || '').trim().length > 0;
  return false;
}

function validateStage(type, stage, payload) {
  const schema = schemaFor(type);
  const fields = schema[stage] || [];
  const missing = fields.filter((field) => !isCompleteValue(field, payload ? payload[field.key] : undefined));
  return { ok: missing.length === 0, missing: missing.map((field) => ({ key: field.key, label: field.label })) };
}

module.exports = {
  STAGE_SCHEMA_VERSION,
  schemaFor,
  validateStage,
};
