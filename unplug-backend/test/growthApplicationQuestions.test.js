'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bank, QUESTION_BANK_VERSION } = require('../src/data/growthApplicationQuestions');
const { publicQuestionBank, validateDeepDiscovery, isYesNoPrompt } = require('../src/routes/growthApplication');

function count(groups) {
  return groups.reduce((sum, group) => sum + group.questions.length, 0);
}

function completedPayload(type) {
  const spec = publicQuestionBank(type);
  const answers = {};
  for (const group of spec.groups) {
    for (const q of group.questions) {
      if (q.type === 'checklist') answers[q.id] = [q.options[0]];
      else if (q.type === 'yes_no_with_context') answers[q.id] = { answer: 'yes', context: 'Context supplied for validation.' };
      else answers[q.id] = 'A complete answer.';
    }
  }
  for (const q of spec.closing) answers[q.id] = 'A complete closing answer.';
  return answers;
}

test('question bank version is the recovered owner-verbatim source', () => {
  assert.equal(QUESTION_BANK_VERSION, '2026-09-11-owner-verbatim-v1');
  assert.equal(bank.version, QUESTION_BANK_VERSION);
});

test('individual bank preserves all recovered categories and questions', () => {
  assert.deepEqual(bank.individual.map((g) => g.category), [
    'Identity', 'Direction', 'Skills', 'Experience', 'Credibility', 'Visibility',
    'Opportunity', 'Barriers', 'Growth', 'Contribution', 'Personal story',
  ]);
  assert.equal(count(bank.individual), 83);
  assert.equal(bank.individual[0].questions[0].text, 'What is your name and surname?');
  assert.equal(bank.individual.at(-1).questions.at(-1).text, 'If Unplug could help the world discover one thing about you, what should it be?');
});

test('business bank preserves all recovered categories and questions', () => {
  assert.deepEqual(bank.business.map((g) => g.category), [
    'Business identity', 'Founder', 'Customers', 'Offering', 'Business stage',
    'Credibility', 'Marketing', 'Sales', 'Growth', 'Funding', 'Market access',
    'Talent', 'Partnerships', 'Challenges', 'Unplug',
  ]);
  assert.equal(count(bank.business), 108);
  assert.equal(bank.business[0].questions[0].text, 'What is your business name?');
  assert.equal(bank.business.at(-1).questions.at(-1).text, 'If Unplug successfully helped your business over the next 12 months, what measurable result would make you say "this worked"?');
});

test('NEED/OFFER closing questions remain separate and prominent', () => {
  assert.equal(bank.closing.length, 2);
  assert.equal(bank.closing[0].key, 'need_now');
  assert.equal(bank.closing[0].text, 'What do you need right now that nobody seems to be helping you with?');
  assert.equal(bank.closing[1].key, 'offer_now');
  assert.equal(bank.closing[1].text, 'What can you offer that somebody else might currently need?');
  assert.ok(bank.closing.every((q) => q.prominence === 'primary'));
});

test('checklist options are preserved for critical multi-select questions', () => {
  const individualOpportunity = bank.individual.find((g) => g.category === 'Opportunity').questions[0];
  assert.equal(individualOpportunity.type, 'checklist');
  assert.ok(individualOpportunity.options.includes('International opportunities'));
  assert.equal(individualOpportunity.options.length, 17);

  const businessGrowth = bank.business.find((g) => g.category === 'Growth').questions[0];
  assert.equal(businessGrowth.type, 'checklist');
  assert.ok(businessGrowth.options.includes('Government contracts'));
  assert.ok(businessGrowth.options.includes('Franchising'));
});

test('yes/no-shaped questions receive a required Tell us more companion without rewriting source text', () => {
  assert.equal(isYesNoPrompt('Do you have a portfolio?'), true);
  assert.equal(isYesNoPrompt('Would you like mentorship?'), true);
  assert.equal(isYesNoPrompt('Are you studying, employed, self-employed, freelancing, looking for work, or exploring opportunities?'), false);
  assert.equal(isYesNoPrompt('Are your customers individuals, businesses, government, or organisations?'), false);

  const spec = publicQuestionBank('individual');
  const q = spec.groups.find((g) => g.category === 'Credibility').questions.find((item) => item.text === 'Do you have a portfolio?');
  assert.equal(q.type, 'yes_no_with_context');
  assert.equal(q.context_required, true);
  assert.equal(q.context_label, 'Tell us more');
  assert.equal(q.text, 'Do you have a portfolio?');
});

test('individual Deep Discovery validator requires every question and both closing answers', () => {
  const complete = completedPayload('individual');
  const valid = validateDeepDiscovery('individual', complete);
  assert.equal(valid.ok, true);
  assert.equal(valid.total, 85);

  delete complete['closing-q01'];
  const invalid = validateDeepDiscovery('individual', complete);
  assert.equal(invalid.ok, false);
  assert.ok(invalid.missing.some((q) => q.id === 'closing-q01'));
});

test('business Deep Discovery validator requires every question and both closing answers', () => {
  const complete = completedPayload('business');
  const valid = validateDeepDiscovery('business', complete);
  assert.equal(valid.ok, true);
  assert.equal(valid.total, 110);
});

test('explicit unavailable answer counts as complete', () => {
  const complete = completedPayload('individual');
  complete['individual-c05-q10'] = { unavailable: true };
  assert.equal(validateDeepDiscovery('individual', complete).ok, true);
});

test('yes/no answer without Tell us more context cannot pass final validation', () => {
  const complete = completedPayload('individual');
  complete['individual-c05-q04'] = { answer: 'no', context: '' };
  const result = validateDeepDiscovery('individual', complete);
  assert.equal(result.ok, false);
  assert.ok(result.missing.some((q) => q.id === 'individual-c05-q04'));
});
