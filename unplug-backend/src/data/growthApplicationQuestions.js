'use strict';

// Canonical Growth Application Deep Discovery question bank.
// Source supplied verbatim by the site owner on 2026-09-11.
// Do not rewrite, shorten, merge or paraphrase question text without an explicit
// documented product decision. The NEED/OFFER closing questions are deliberately
// separate and are not a matching-engine implementation.

const QUESTION_BANK_VERSION = '2026-09-11-owner-verbatim-v1';

const individual = [
  {
    category: 'Identity',
    questions: [
      { text: 'What is your name and surname?' },
      { text: 'What name would you like the public to know you by?' },
      { text: 'Where are you based?' },
      { text: 'What industry or industries are you interested in?' },
      { text: 'How would you describe yourself in one sentence?' },
      { text: 'What do you currently do?' },
      { text: 'Are you studying, employed, self-employed, freelancing, looking for work, or exploring opportunities?' },
      { text: 'What languages do you speak?' },
      { text: 'Which languages are you comfortable working in?' },
      { text: 'What makes you different from other people doing similar work?' },
    ],
  },
  {
    category: 'Direction',
    questions: [
      { text: 'What do you ultimately want to become?' },
      { text: 'Where would you like to be professionally within the next 12 months?' },
      { text: 'Where would you like to be in five years?' },
      { text: 'What would success look like to you?' },
      { text: 'What is the biggest dream you are currently working toward?' },
      { text: "Is there something you have always wanted to try but haven't had the opportunity to do?" },
      { text: 'If the right opportunity appeared tomorrow, what would you want it to be?' },
    ],
  },
  {
    category: 'Skills',
    questions: [
      { text: 'What are your strongest skills?' },
      { text: 'Which skills do other people regularly ask you for help with?' },
      { text: 'Which skills have you learned through work?' },
      { text: 'Which skills have you taught yourself?' },
      { text: 'What qualifications or certificates do you have?' },
      { text: 'Which skills can you demonstrate through previous work?' },
      { text: 'Do you have examples of your work?' },
      { text: 'Which skills would you like to improve?' },
      { text: 'Which new skills would you like to learn?' },
    ],
  },
  {
    category: 'Experience',
    questions: [
      { text: 'What work or projects are you most proud of?' },
      { text: 'What organisations or clients have you worked with?' },
      { text: 'Have you volunteered?' },
      { text: 'Have you led a team or project?' },
      { text: 'Have you started something yourself?' },
      { text: 'Have you won competitions or awards?' },
      { text: 'Have you been featured by media?' },
      { text: 'Have you spoken publicly?' },
      { text: 'Have you participated in community projects?' },
      { text: 'What achievement means the most to you?' },
    ],
  },
  {
    category: 'Credibility',
    questions: [
      { text: 'Do you currently have a professional biography?' },
      { text: 'Do you have a professional photograph?' },
      { text: 'Do you have a CV?' },
      { text: 'Do you have a portfolio?' },
      { text: 'Do you have references?' },
      { text: 'Do you have testimonials?' },
      { text: 'Can previous clients or employers verify your work?' },
      { text: 'Are your qualifications available for verification?' },
      { text: 'Do you have a LinkedIn profile?' },
      { text: 'Do you have a website?' },
      { text: 'Which social-media platforms represent your professional work?' },
      { text: 'What would you like people to immediately understand about you when they discover you online?' },
    ],
  },
  {
    category: 'Visibility',
    questions: [
      { text: 'How easy do you think it is for someone to discover you online?' },
      { text: 'What do you currently do to promote yourself?' },
      { text: 'Have you ever been featured in an article?' },
      { text: 'Have you ever been interviewed?' },
      { text: 'Would you be comfortable speaking on camera?' },
      { text: 'Would you be interested in telling your story through Unplug?' },
      { text: 'What topics could you confidently speak about?' },
      { text: 'What would you like to become known for?' },
      { text: 'Who would you most like to reach?' },
    ],
  },
  {
    category: 'Opportunity',
    questions: [
      {
        text: 'What opportunities are you currently looking for?',
        type: 'checklist',
        options: ['Employment', 'Freelance work', 'Clients', 'Collaborations', 'Speaking opportunities', 'Modelling opportunities', 'Sponsorship', 'Investment', 'Brand partnerships', 'Media appearances', 'Mentorship', 'Training', 'Internships', 'Volunteer experience', 'Competitions', 'Networking', 'International opportunities'],
      },
      { text: 'Are you willing to travel for opportunities?' },
      { text: 'Are you available for remote opportunities?' },
    ],
  },
  {
    category: 'Barriers',
    questions: [
      {
        text: 'What is currently stopping you from reaching your next level?',
        type: 'checklist',
        options: ['Lack of money', 'Lack of experience', 'Lack of confidence', 'Lack of exposure', 'Lack of contacts/network', 'Lack of skills', 'Location', 'Transportation', 'Technology or internet access', 'Lack of information about opportunities'],
      },
      { text: 'What support would make the biggest difference to you right now?' },
    ],
  },
  {
    category: 'Growth',
    questions: [
      { text: 'Would you like mentorship?' },
      { text: 'What would you want mentorship in?' },
      { text: 'Would you participate in workshops?' },
      { text: 'Would you take short online courses?' },
      { text: 'Would you complete development missions?' },
      { text: 'Would you participate in challenges that improve your portfolio?' },
      { text: 'Would you like Unplug to recommend actions to help you grow?' },
      { text: 'How much time could you realistically invest in personal development each week?' },
    ],
  },
  {
    category: 'Contribution',
    questions: [
      { text: 'What could you teach someone else?' },
      { text: 'Would you mentor another member?' },
      { text: 'Would you collaborate with other members?' },
      { text: 'Would you volunteer your skills for selected community projects?' },
      { text: 'Which causes matter to you?' },
      { text: 'What type of people would you like to connect with?' },
    ],
  },
  {
    category: 'Personal story',
    questions: [
      { text: 'What challenge have you overcome?' },
      { text: 'What has shaped who you are today?' },
      { text: 'What accomplishment are you most proud of?' },
      { text: 'What lesson have you learned that could help someone else?' },
      { text: 'Who inspires you?' },
      { text: 'What do you want your legacy to be?' },
      { text: 'If Unplug could help the world discover one thing about you, what should it be?' },
    ],
  },
];

const business = [
  {
    category: 'Business identity',
    questions: [
      { text: 'What is your business name?' },
      { text: 'What does your business do?' },
      { text: 'What industry are you in?' },
      { text: 'Where are you based?' },
      { text: 'When did the business start?' },
      { text: 'Is the business registered?' },
      { text: 'What problem do you solve?' },
      { text: 'Who do you solve it for?' },
      { text: 'What is your main product or service?' },
      { text: 'What makes your business different?' },
    ],
  },
  {
    category: 'Founder',
    questions: [
      { text: 'Who founded the business?' },
      { text: 'Why was the business started?' },
      { text: 'What experience does the founder/team have?' },
      { text: "What is the founder's long-term vision?" },
      { text: 'What is the biggest lesson learned since starting?' },
    ],
  },
  {
    category: 'Customers',
    questions: [
      { text: 'Who is your ideal customer?' },
      { text: 'Are your customers individuals, businesses, government, or organisations?' },
      { text: 'Where are your customers located?' },
      { text: 'What problem causes customers to seek your solution?' },
      { text: 'How do customers currently discover you?' },
      { text: 'Why do customers choose you?' },
      { text: 'Why do potential customers sometimes choose competitors instead?' },
    ],
  },
  {
    category: 'Offering',
    questions: [
      { text: 'What products or services do you offer?' },
      { text: 'Which produces the most revenue?' },
      { text: 'Which has the highest potential?' },
      { text: 'What are your prices?' },
      { text: 'How frequently do customers buy?' },
      { text: 'Do you offer online purchasing?' },
      { text: 'Do you deliver?' },
      { text: 'What geographical area can you serve?' },
    ],
  },
  {
    category: 'Business stage',
    questions: [
      { text: 'Which best describes you: idea, startup, early revenue, established, growing, or scaling?' },
      { text: 'Approximately how many customers do you currently serve?' },
      { text: 'How many employees or contractors do you have?' },
      { text: 'Is the business generating revenue?' },
      { text: 'Is revenue increasing, stable, or declining?' },
      { text: 'What is your biggest business expense?' },
      { text: 'What is your biggest operational challenge?' },
    ],
  },
  {
    category: 'Credibility',
    questions: [
      { text: 'Do you have a registered company?' },
      { text: 'Do you have a business bank account?' },
      { text: 'Do you have a website?' },
      { text: 'Do you have professional email?' },
      { text: 'Do you have professional branding?' },
      { text: 'Do you have customer reviews?' },
      { text: 'Can previous customers verify your work?' },
      { text: 'Do you have case studies?' },
      { text: 'Do you have a portfolio?' },
      { text: 'Do you have certifications or industry accreditation?' },
      { text: 'Do you have company policies where required?' },
      { text: 'What proof would reassure a customer that your business can deliver?' },
    ],
  },
  {
    category: 'Marketing',
    questions: [
      { text: 'How do you currently market the business?' },
      { text: 'Which platform generates the most enquiries?' },
      { text: 'Approximately how many enquiries do you receive monthly?' },
      { text: 'Approximately how many become customers?' },
      { text: 'Do you know your customer acquisition cost?' },
      { text: 'Do you collect customer information with appropriate consent?' },
      { text: 'Do you have an email database?' },
      { text: 'Do you have a marketing strategy?' },
      { text: 'Do you regularly create content?' },
      { text: 'Have you received media coverage?' },
      { text: 'What would you like your business to become known for?' },
    ],
  },
  {
    category: 'Sales',
    questions: [
      { text: 'How do customers buy from you?' },
      { text: 'Do you have a documented sales process?' },
      { text: 'What prevents prospects from buying?' },
      { text: 'What is your average sale?' },
      { text: 'Do you receive repeat business?' },
      { text: 'Do you ask customers for referrals?' },
      { text: 'What would allow you to double sales?' },
    ],
  },
  {
    category: 'Growth',
    questions: [
      {
        text: 'What is your primary goal for the next 12 months?',
        type: 'checklist',
        options: ['More customers', 'Increased revenue', 'New locations', 'More employees', 'New products', 'Investment', 'Equipment', 'Technology', 'Exporting', 'Partnerships', 'Government contracts', 'Retail distribution', 'Franchising'],
      },
      { text: 'What would the business look like if everything went well over the next five years?' },
    ],
  },
  {
    category: 'Funding',
    questions: [
      { text: 'Are you currently looking for funding?' },
      { text: 'How much?' },
      { text: 'What would the funding be used for?' },
      { text: 'Have you applied previously?' },
      { text: 'What happened?' },
      { text: 'Do you have financial statements?' },
      { text: 'Do you maintain management accounts?' },
      { text: 'Do you know your monthly revenue?' },
      { text: 'Do you know your gross margin?' },
      { text: 'Do you understand your cash flow?' },
      { text: 'Would you like assistance becoming funding-ready?' },
    ],
  },
  {
    category: 'Market access',
    questions: [
      { text: 'What new market would you most like to enter?' },
      { text: 'What type of customer would transform your business?' },
      { text: 'Which companies would you like to supply?' },
      {
        text: 'Would you like:',
        type: 'checklist',
        options: ['Corporate procurement opportunities', 'Government opportunities', 'Export opportunities', 'Retail opportunities', 'Online marketplace opportunities'],
      },
      { text: 'What prevents you from entering those markets?' },
    ],
  },
  {
    category: 'Talent',
    questions: [
      { text: 'Are you currently hiring?' },
      { text: 'Which skills do you struggle to find?' },
      {
        text: 'Would you hire:',
        type: 'checklist',
        options: ['Freelancers', 'Interns', 'Graduates', 'Creators'],
      },
      { text: 'Would you offer workplace experience?' },
      { text: 'Would you mentor aspiring entrepreneurs?' },
      { text: 'Could your business provide opportunities to Unplug members?' },
    ],
  },
  {
    category: 'Partnerships',
    questions: [
      { text: 'What businesses would complement yours?' },
      { text: 'What type of partnership are you looking for?' },
      { text: 'Would you collaborate on campaigns?' },
      { text: 'Would you sponsor events or individuals?' },
      { text: 'Would you provide products for competitions?' },
      { text: 'Would you participate in community initiatives?' },
      { text: 'What could you provide another business?' },
      { text: 'What do you need another business to provide you?' },
    ],
  },
  {
    category: 'Challenges',
    questions: [
      { text: 'What is your single biggest business challenge?' },
      { text: 'What problem keeps appearing?' },
      { text: 'What takes too much of your time?' },
      { text: 'What expertise are you missing?' },
      { text: 'What is preventing the business from growing faster?' },
      { text: 'What have you tried already?' },
      { text: 'What kind of support would make the biggest difference?' },
    ],
  },
  {
    category: 'Unplug',
    questions: [
      {
        text: 'What would you want Unplug to help you achieve?',
        type: 'checklist',
        options: ['More visibility', 'Credibility', 'Leads', 'Customers', 'Partnerships', 'Employees', 'Media coverage', 'Funding readiness', 'Training', 'Mentorship', 'Networking', 'Market access'],
      },
      { text: 'If Unplug successfully helped your business over the next 12 months, what measurable result would make you say "this worked"?' },
    ],
  },
];

const closing = [
  {
    key: 'need_now',
    text: 'What do you need right now that nobody seems to be helping you with?',
    prominence: 'primary',
  },
  {
    key: 'offer_now',
    text: 'What can you offer that somebody else might currently need?',
    prominence: 'primary',
  },
];

function withStableIds(groups, prefix) {
  return groups.map((group, categoryIndex) => ({
    ...group,
    id: `${prefix}-c${String(categoryIndex + 1).padStart(2, '0')}`,
    questions: group.questions.map((question, questionIndex) => ({
      type: 'text',
      ...question,
      id: `${prefix}-c${String(categoryIndex + 1).padStart(2, '0')}-q${String(questionIndex + 1).padStart(2, '0')}`,
      required: true,
    })),
  }));
}

const bank = Object.freeze({
  version: QUESTION_BANK_VERSION,
  individual: withStableIds(individual, 'individual'),
  business: withStableIds(business, 'business'),
  closing: closing.map((question, index) => ({
    ...question,
    id: `closing-q${String(index + 1).padStart(2, '0')}`,
    type: 'text',
    required: true,
  })),
});

module.exports = { QUESTION_BANK_VERSION, bank };
