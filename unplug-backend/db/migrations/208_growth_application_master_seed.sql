-- Growth Application V2 — initial published master questionnaire.
--
-- This migration is deliberately additive and idempotent. It gives a freshly
-- migrated environment a usable Growth Application immediately, while keeping
-- all future changes inside the versioned admin form builder.

ALTER TABLE growth_form_fields DROP CONSTRAINT IF EXISTS growth_form_fields_field_type_check;
ALTER TABLE growth_form_fields
  ADD CONSTRAINT growth_form_fields_field_type_check CHECK (field_type IN (
    'text','short_text','textarea','long_text','rich_text','number','currency','percentage',
    'email','tel','date','date_range','url','social_url','video_url','audio_url',
    'select','multiselect','radio','checkbox','yes_no','tags','rating','scale',
    'address','country','province','city','suburb','industry','category','skills','interests',
    'upload','image_upload','document_upload','portfolio_upload',
    'consent','declaration','heading','info','admin_only'
  ));

ALTER TABLE growth_form_fields
  ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'applicant'
  CHECK (audience IN ('applicant','admin','both'));

DO $$
DECLARE
  v_form_id BIGINT;
  v_version_id BIGINT;
BEGIN
  SELECT id INTO v_form_id
  FROM growth_forms
  WHERE slug = 'master-growth-application'
  LIMIT 1;

  IF v_form_id IS NULL THEN
    INSERT INTO growth_forms(slug,name,description,is_master,is_active)
    VALUES('master-growth-application','Master Growth Application',
           'The configurable master Growth Application used by Unplug members.',true,true)
    RETURNING id INTO v_form_id;
  END IF;

  SELECT id INTO v_version_id
  FROM growth_form_versions
  WHERE form_id=v_form_id AND status='published'
  ORDER BY version_number DESC
  LIMIT 1;

  IF v_version_id IS NULL THEN
    INSERT INTO growth_form_versions(
      form_id,version_number,status,title,intro_text,consent_text,published_at
    ) VALUES (
      v_form_id,1,'published','Unplug Growth Application',
      'Help us understand where you are now, where you want to go, what may be standing in the way, what you can offer, and how Unplug may potentially support your growth. Completing this application does not guarantee funding, work, sponsorship, media coverage, collaboration, sales, clients or any other outcome.',
      'By submitting, you confirm that the information is accurate to the best of your knowledge and that Unplug may assess it for the Growth Journey purpose. Any formal commercial, media, partnership or sponsorship relationship may require a separate agreement.',
      now()
    ) RETURNING id INTO v_version_id;

    INSERT INTO growth_form_steps(version_id,step_key,title,description,display_order) VALUES
      (v_version_id,'identity_profile','1. About you','Who are you, and how should Unplug understand your current identity or business?',10),
      (v_version_id,'current_situation','2. Where you are now','Tell us about your current stage, strengths and what is already working.',20),
      (v_version_id,'goals_priorities','3. Where you want to go','Your most important goals, priorities and target outcomes.',30),
      (v_version_id,'challenges_needs','4. What is getting in the way','Challenges, barriers, missing resources and support needs.',40),
      (v_version_id,'credibility_visibility','5. Credibility and visibility','What proof, audience and visibility assets do you already have or need?',50),
      (v_version_id,'portfolio_content','6. Portfolio and content','Help us understand what you can already show and what content support may help.',60),
      (v_version_id,'opportunities_collaboration','7. Opportunities and collaboration','What kinds of opportunities and collaborations are you open to?',70),
      (v_version_id,'partnerships_sponsorship','8. Partnerships, sponsorship and funding','Exploratory needs only. This section does not create or promise a deal.',80),
      (v_version_id,'commercial_readiness','9. Commercial readiness','Optional information that helps Unplug understand practical readiness and affordability.',90),
      (v_version_id,'contribution','10. What you can offer','Growth is two-way. Tell us what skills, knowledge or value you can contribute.',100),
      (v_version_id,'privacy_permissions','11. Privacy and permissions','Control contact, confidentiality and limited sharing choices.',110),
      (v_version_id,'declarations','12. Review and declaration','Final acknowledgements before you submit.',120);

    -- ---------------------------------------------------------------------
    -- 1. Identity / profile
    -- ---------------------------------------------------------------------
    INSERT INTO growth_form_fields(version_id,step_id,field_key,label,help_text,field_type,display_order,is_required,applicant_types)
    SELECT v_version_id,s.id,x.field_key,x.label,x.help_text,x.field_type,x.display_order,x.is_required,x.applicant_types::jsonb
    FROM growth_form_steps s
    JOIN (VALUES
      ('growth_display_name','Preferred/display name','How you would like us to address or identify you.','text',10,true,'["individual","business"]'),
      ('growth_legal_name','Full legal name','For individual applicants. Sensitive identity numbers are not requested by default.','text',20,true,'["individual"]'),
      ('growth_business_name','Business / organisation name','Trading or registered name, where applicable.','text',30,true,'["business"]'),
      ('growth_email','Email address','Prefilled from your member account where available.','email',40,true,'["individual","business"]'),
      ('growth_phone','Mobile / telephone number','Prefilled from your member account where available.','tel',50,false,'["individual","business"]'),
      ('growth_country','Country',NULL,'country',60,false,'["individual","business"]'),
      ('growth_province','Province / state / region',NULL,'province',70,false,'["individual","business"]'),
      ('growth_city','Town / city',NULL,'city',80,false,'["individual","business"]'),
      ('growth_role','Current role, occupation or title','For example founder, model, photographer, student, freelancer or manager.','text',90,false,'["individual","business"]'),
      ('growth_industry','Industry / category','Choose or describe the industry that best represents you.','industry',100,true,'["individual","business"]'),
      ('growth_bio','Short background / bio','Give us the human context behind where you are today.','textarea',110,false,'["individual","business"]'),
      ('growth_website','Website or portfolio link',NULL,'url',120,false,'["individual","business"]'),
      ('growth_social_links','Important social media links','Add the profiles that best show your current work or audience.','textarea',130,false,'["individual","business"]'),
      ('growth_skills','Skills and specialist strengths','Select or describe the skills you most want Unplug to understand.','skills',140,false,'["individual","business"]'),
      ('growth_interests','Interests and focus areas',NULL,'interests',150,false,'["individual","business"]')
    ) AS x(field_key,label,help_text,field_type,display_order,is_required,applicant_types)
      ON s.version_id=v_version_id AND s.step_key='identity_profile';

    -- ---------------------------------------------------------------------
    -- 2. Current situation
    -- ---------------------------------------------------------------------
    INSERT INTO growth_form_fields(version_id,step_id,field_key,label,help_text,field_type,display_order,is_required,applicant_types)
    SELECT v_version_id,s.id,x.field_key,x.label,x.help_text,x.field_type,x.display_order,x.is_required,'["individual","business"]'::jsonb
    FROM growth_form_steps s
    JOIN (VALUES
      ('growth_current_stage','What stage are you currently at?','Choose the answer that feels closest to your current position.','select',10,true),
      ('growth_current_activity','What are you currently doing or building?','Tell us what occupies most of your focus right now.','textarea',20,true),
      ('growth_strengths','What are your strongest qualities or advantages?','Skills, experience, relationships, reputation, assets or personal strengths all count.','textarea',30,true),
      ('growth_what_is_working','What is already working well?',NULL,'textarea',40,false),
      ('growth_achievements','What are you most proud of so far?','Include achievements, milestones, awards, projects or proof of progress.','textarea',50,false),
      ('growth_what_tried','What have you already tried to move forward?',NULL,'textarea',60,false),
      ('growth_differentiator','What makes you, your work or your business different?',NULL,'textarea',70,false)
    ) AS x(field_key,label,help_text,field_type,display_order,is_required)
      ON s.version_id=v_version_id AND s.step_key='current_situation';

    -- ---------------------------------------------------------------------
    -- 3. Goals / priorities
    -- ---------------------------------------------------------------------
    INSERT INTO growth_form_fields(version_id,step_id,field_key,label,help_text,field_type,display_order,is_required,applicant_types)
    SELECT v_version_id,s.id,x.field_key,x.label,x.help_text,x.field_type,x.display_order,x.is_required,'["individual","business"]'::jsonb
    FROM growth_form_steps s
    JOIN (VALUES
      ('growth_primary_goal','What is your most important growth goal right now?',NULL,'select',10,true),
      ('growth_secondary_goals','What other goals matter to you?','Select all that apply.','multiselect',20,false),
      ('growth_one_area_first','If Unplug could potentially help you make progress in one area first, what should it be?',NULL,'textarea',30,true),
      ('growth_target_outcome','What would meaningful progress look like to you?',NULL,'textarea',40,true),
      ('growth_goal_30d','What would you like to achieve in the next 30 days?',NULL,'textarea',50,false),
      ('growth_goal_3m','What would you like to achieve in the next 3 months?',NULL,'textarea',60,false),
      ('growth_goal_12m','What would you like to achieve in the next 12 months?',NULL,'textarea',70,false),
      ('growth_long_term','What is the bigger long-term vision?',NULL,'textarea',80,false)
    ) AS x(field_key,label,help_text,field_type,display_order,is_required)
      ON s.version_id=v_version_id AND s.step_key='goals_priorities';

    -- ---------------------------------------------------------------------
    -- 4. Challenges / needs
    -- ---------------------------------------------------------------------
    INSERT INTO growth_form_fields(version_id,step_id,field_key,label,help_text,field_type,display_order,is_required,applicant_types)
    SELECT v_version_id,s.id,x.field_key,x.label,x.help_text,x.field_type,x.display_order,x.is_required,'["individual","business"]'::jsonb
    FROM growth_form_steps s
    JOIN (VALUES
      ('growth_biggest_challenge','What is the biggest challenge slowing your growth?',NULL,'textarea',10,true),
      ('growth_barriers','Which barriers are affecting you?','Select all that apply.','multiselect',20,false),
      ('growth_missing_resources','What resources, knowledge, tools or connections are you missing?',NULL,'textarea',30,false),
      ('growth_support_needs','What kinds of support would help most?','This is exploratory and does not guarantee a service or opportunity.','multiselect',40,true),
      ('growth_accessibility_needs','Is there anything Unplug should know to make participation more accessible for you?',NULL,'textarea',50,false)
    ) AS x(field_key,label,help_text,field_type,display_order,is_required)
      ON s.version_id=v_version_id AND s.step_key='challenges_needs';

    -- ---------------------------------------------------------------------
    -- 5. Credibility / visibility
    -- ---------------------------------------------------------------------
    INSERT INTO growth_form_fields(version_id,step_id,field_key,label,help_text,field_type,display_order,is_required,applicant_types)
    SELECT v_version_id,s.id,x.field_key,x.label,x.help_text,x.field_type,x.display_order,x.is_required,'["individual","business"]'::jsonb
    FROM growth_form_steps s
    JOIN (VALUES
      ('growth_credibility_assets','Which credibility assets do you already have?','For example CV, profile, website, media, testimonials, awards, certifications or client history.','multiselect',10,false),
      ('growth_credibility_needed','What credibility or trust would you most like to strengthen?',NULL,'textarea',20,false),
      ('growth_target_audience','Who do you most want to reach or be known by?',NULL,'textarea',30,true),
      ('growth_known_for','What do you want people to know you for?',NULL,'textarea',40,true),
      ('growth_visibility_geography','Where would you like more visibility?','Local, provincial, national, international, online or specific markets.','textarea',50,false),
      ('growth_current_exposure','Briefly describe your current exposure or audience',NULL,'textarea',60,false)
    ) AS x(field_key,label,help_text,field_type,display_order,is_required)
      ON s.version_id=v_version_id AND s.step_key='credibility_visibility';

    -- ---------------------------------------------------------------------
    -- 6. Portfolio / content
    -- ---------------------------------------------------------------------
    INSERT INTO growth_form_fields(version_id,step_id,field_key,label,help_text,field_type,display_order,is_required,applicant_types,visibility_rules,confidential)
    SELECT v_version_id,s.id,x.field_key,x.label,x.help_text,x.field_type,x.display_order,x.is_required,'["individual","business"]'::jsonb,x.visibility_rules::jsonb,x.confidential
    FROM growth_form_steps s
    JOIN (VALUES
      ('growth_portfolio_exists','Do you currently have a portfolio, showreel or body of work?',NULL,'yes_no',10,true,'{}',false),
      ('growth_portfolio_url','Portfolio / showreel link',NULL,'url',20,false,'{"all":[{"field":"growth_portfolio_exists","operator":"equals","value":"yes"}]}',false),
      ('growth_portfolio_help','What would make your portfolio stronger?',NULL,'textarea',30,false,'{}',false),
      ('growth_profile_image','Portrait / profile image','Optional private image upload for assessment. Uploading does not grant publishing rights.','image_upload',40,false,'{}',true),
      ('growth_cv_or_profile_document','CV, company profile or supporting document','Optional private PDF or image. Uploading does not grant publishing rights.','document_upload',50,false,'{}',true),
      ('growth_content_support','Which content support would be useful?','Photography, video, copywriting, bio, media kit, company profile or other.','multiselect',60,false,'{}',false)
    ) AS x(field_key,label,help_text,field_type,display_order,is_required,visibility_rules,confidential)
      ON s.version_id=v_version_id AND s.step_key='portfolio_content';

    -- ---------------------------------------------------------------------
    -- 7. Opportunities / collaboration
    -- ---------------------------------------------------------------------
    INSERT INTO growth_form_fields(version_id,step_id,field_key,label,help_text,field_type,display_order,is_required,applicant_types)
    SELECT v_version_id,s.id,x.field_key,x.label,x.help_text,x.field_type,x.display_order,x.is_required,'["individual","business"]'::jsonb
    FROM growth_form_steps s
    JOIN (VALUES
      ('growth_opportunities_sought','Which opportunities are you interested in?','Select all that apply.','multiselect',10,true),
      ('growth_opportunity_location','Where are you open to opportunities?','Include remote, local, national or international preferences.','textarea',20,false),
      ('growth_collaboration_interest','Are you open to collaborations?',NULL,'yes_no',30,true),
      ('growth_collaboration_offer','What could you offer a collaborator?',NULL,'textarea',40,false),
      ('growth_collaboration_need','What would you ideally want from a collaborator?',NULL,'textarea',50,false),
      ('growth_availability','What does your availability currently look like?',NULL,'textarea',60,false)
    ) AS x(field_key,label,help_text,field_type,display_order,is_required)
      ON s.version_id=v_version_id AND s.step_key='opportunities_collaboration';

    -- ---------------------------------------------------------------------
    -- 8. Partnerships / sponsorship / funding
    -- ---------------------------------------------------------------------
    INSERT INTO growth_form_fields(version_id,step_id,field_key,label,help_text,field_type,display_order,is_required,applicant_types,visibility_rules)
    SELECT v_version_id,s.id,x.field_key,x.label,x.help_text,x.field_type,x.display_order,x.is_required,'["individual","business"]'::jsonb,x.visibility_rules::jsonb
    FROM growth_form_steps s
    JOIN (VALUES
      ('growth_partnership_interest','Are you currently looking for a partnership?',NULL,'yes_no',10,false,'{}'),
      ('growth_partnership_detail','What kind of partnership would be useful?',NULL,'textarea',20,false,'{"all":[{"field":"growth_partnership_interest","operator":"equals","value":"yes"}]}'),
      ('growth_sponsorship_interest','Are you looking for sponsorship?',NULL,'yes_no',30,false,'{}'),
      ('growth_sponsorship_detail','What is the sponsorship for, and what could you offer a sponsor?',NULL,'textarea',40,false,'{"all":[{"field":"growth_sponsorship_interest","operator":"equals","value":"yes"}]}'),
      ('growth_funding_interest','Are you looking for funding or investment?',NULL,'yes_no',50,false,'{}'),
      ('growth_funding_amount','Approximate amount sought (ZAR)','Optional. Do not provide bank-account details.','currency',60,false,'{"all":[{"field":"growth_funding_interest","operator":"equals","value":"yes"}]}'),
      ('growth_funding_purpose','What would the funding or investment be used for?',NULL,'textarea',70,false,'{"all":[{"field":"growth_funding_interest","operator":"equals","value":"yes"}]}')
    ) AS x(field_key,label,help_text,field_type,display_order,is_required,visibility_rules)
      ON s.version_id=v_version_id AND s.step_key='partnerships_sponsorship';

    -- ---------------------------------------------------------------------
    -- 9. Commercial readiness
    -- ---------------------------------------------------------------------
    INSERT INTO growth_form_fields(version_id,step_id,field_key,label,help_text,field_type,display_order,is_required,applicant_types)
    SELECT v_version_id,s.id,x.field_key,x.label,x.help_text,x.field_type,x.display_order,false,'["individual","business"]'::jsonb
    FROM growth_form_steps s
    JOIN (VALUES
      ('growth_budget_range','Current budget available for growth / marketing','Choose a broad range; exact finances are not required.','select',10),
      ('growth_revenue_range','Approximate monthly revenue / turnover range','Optional and only used as readiness context.','select',20),
      ('growth_pricing_model','How do you currently make money or price what you offer?',NULL,'textarea',30),
      ('growth_customers','Who currently pays for or uses what you offer?',NULL,'textarea',40)
    ) AS x(field_key,label,help_text,field_type,display_order)
      ON s.version_id=v_version_id AND s.step_key='commercial_readiness';

    -- ---------------------------------------------------------------------
    -- 10. Contribution
    -- ---------------------------------------------------------------------
    INSERT INTO growth_form_fields(version_id,step_id,field_key,label,help_text,field_type,display_order,is_required,applicant_types)
    SELECT v_version_id,s.id,x.field_key,x.label,x.help_text,x.field_type,x.display_order,x.is_required,'["individual","business"]'::jsonb
    FROM growth_form_steps s
    JOIN (VALUES
      ('growth_contribution_skills','What skills, knowledge, products or services could you contribute to the Unplug community?',NULL,'textarea',10,true),
      ('growth_contribution_willingness','Which kinds of participation are you open to?','For example collaborations, mentoring, events, interviews, campaigns or supporting other members.','multiselect',20,false),
      ('growth_community_value','What do you hope people experience or gain when they interact with you or your work?',NULL,'textarea',30,false)
    ) AS x(field_key,label,help_text,field_type,display_order,is_required)
      ON s.version_id=v_version_id AND s.step_key='contribution';

    -- ---------------------------------------------------------------------
    -- 11. Privacy / permissions
    -- ---------------------------------------------------------------------
    INSERT INTO growth_form_fields(version_id,step_id,field_key,label,help_text,field_type,display_order,is_required,applicant_types,confidential)
    SELECT v_version_id,s.id,x.field_key,x.label,x.help_text,x.field_type,x.display_order,x.is_required,'["individual","business"]'::jsonb,x.confidential
    FROM growth_form_steps s
    JOIN (VALUES
      ('growth_contact_permission','May Unplug contact you if a potentially suitable opportunity or support option is identified?',NULL,'yes_no',10,true,false),
      ('growth_external_partner_preference','If a potentially relevant external collaborator or provider is identified, what should Unplug do?','This is separate from the external-sharing consent switch.','select',20,true,false),
      ('growth_confidential_information','Is there anything in this application you specifically want treated as confidential?','Do not include passwords, banking credentials or unnecessary identity numbers.','textarea',30,false,true),
      ('growth_existing_restrictions','Do you have contracts, exclusivity, representation, sponsor, employer, confidentiality or other restrictions Unplug should know about?','Informational only; Unplug is not providing legal review.','textarea',40,false,true)
    ) AS x(field_key,label,help_text,field_type,display_order,is_required,confidential)
      ON s.version_id=v_version_id AND s.step_key='privacy_permissions';

    -- ---------------------------------------------------------------------
    -- 12. Declarations
    -- ---------------------------------------------------------------------
    INSERT INTO growth_form_fields(version_id,step_id,field_key,label,help_text,field_type,display_order,is_required,applicant_types)
    SELECT v_version_id,s.id,x.field_key,x.label,x.help_text,x.field_type,x.display_order,true,'["individual","business"]'::jsonb
    FROM growth_form_steps s
    JOIN (VALUES
      ('growth_accuracy_declaration','I confirm the information I provided is accurate to the best of my knowledge.',NULL,'declaration',10),
      ('growth_authority_declaration','I am authorised to provide the information and materials included in this application.',NULL,'declaration',20),
      ('growth_no_guarantee_declaration','I understand that submitting a Growth Application does not guarantee funding, employment, sponsorship, media coverage, collaboration, sales, clients or any other opportunity or outcome.',NULL,'declaration',30),
      ('growth_separate_agreement_declaration','I understand that a separate agreement may be required before any formal commercial, media, partnership or sponsorship relationship begins.',NULL,'declaration',40)
    ) AS x(field_key,label,help_text,field_type,display_order)
      ON s.version_id=v_version_id AND s.step_key='declarations';

    -- Shared configurable option libraries for the seeded master.
    INSERT INTO growth_form_field_options(field_id,option_value,option_label,display_order)
    SELECT f.id,o.value,o.label,o.ord
    FROM growth_form_fields f
    JOIN (VALUES
      ('idea','Idea / exploring',10),('starting','Starting',20),('early','Early stage',30),
      ('building','Building',40),('growing','Growing',50),('established','Established',60),
      ('scaling','Scaling',70),('repositioning','Repositioning',80),('restarting','Restarting',90),
      ('seeking_opportunities','Seeking opportunities',100),('not_sure','Not sure yet',110)
    ) AS o(value,label,ord) ON true
    WHERE f.version_id=v_version_id AND f.field_key='growth_current_stage';

    INSERT INTO growth_form_field_options(field_id,option_value,option_label,display_order)
    SELECT f.id,o.value,o.label,o.ord FROM growth_form_fields f JOIN (VALUES
      ('credibility','Build credibility',10),('exposure','Gain exposure / visibility',20),('brand','Strengthen my brand',30),
      ('portfolio','Build my portfolio',40),('media','Gain media opportunities',50),('collaboration','Find collaborations',60),
      ('partnership','Explore partnerships',70),('sponsorship','Explore sponsorship',80),('customers','Find customers / clients',90),
      ('work','Find work / freelance / contracts',100),('skills','Build skills / training',110),('funding','Explore funding / investment',120),
      ('network','Grow my network',130),('sales','Grow sales / revenue',140),('recognition','Gain recognition / trust',150),
      ('new_markets','Reach new markets',160),('other','Other',170)
    ) AS o(value,label,ord) ON true WHERE f.version_id=v_version_id AND f.field_key IN ('growth_primary_goal','growth_secondary_goals');

    INSERT INTO growth_form_field_options(field_id,option_value,option_label,display_order)
    SELECT f.id,o.value,o.label,o.ord FROM growth_form_fields f JOIN (VALUES
      ('credibility','Credibility / trust',10),('exposure','Exposure / visibility',20),('portfolio','Portfolio / profile',30),
      ('branding','Branding / positioning',40),('marketing','Marketing',50),('photo_video','Photography / video',60),
      ('written_content','Written content / copy',70),('website','Website / online presence',80),('media_kit','Media kit / company profile',90),
      ('networking','Networking / introductions',100),('mentorship','Mentorship / coaching',110),('skills_training','Skills / training',120),
      ('collaboration','Collaboration',130),('partnership','Partnership',140),('sponsorship','Sponsorship',150),
      ('funding','Funding / investment',160),('clients','Clients / customers / sales',170),('opportunities','Opportunities',180),
      ('events','Events / speaking',190),('media','Media / interviews',200),('strategy','Guidance / strategy',210),('other','Other',220)
    ) AS o(value,label,ord) ON true WHERE f.version_id=v_version_id AND f.field_key='growth_support_needs';

    INSERT INTO growth_form_field_options(field_id,option_value,option_label,display_order)
    SELECT f.id,o.value,o.label,o.ord FROM growth_form_fields f JOIN (VALUES
      ('finance','Financial constraints',10),('marketing','Marketing / visibility',20),('confidence','Confidence',30),
      ('experience','Experience',40),('connections','Connections / network',50),('skills','Skills / knowledge',60),
      ('equipment','Equipment / resources',70),('geography','Location / geography',80),('accessibility','Accessibility',90),
      ('technology','Technology',100),('time','Time / capacity',110),('business_systems','Business systems',120),
      ('industry_access','Industry access',130),('other','Other',140)
    ) AS o(value,label,ord) ON true WHERE f.version_id=v_version_id AND f.field_key='growth_barriers';

    INSERT INTO growth_form_field_options(field_id,option_value,option_label,display_order)
    SELECT f.id,o.value,o.label,o.ord FROM growth_form_fields f JOIN (VALUES
      ('cv','CV / resume',10),('profile','Professional profile',20),('portfolio','Portfolio / website',30),
      ('articles','Published articles',40),('media','Media / interviews',50),('testimonials','Testimonials / reviews',60),
      ('references','References',70),('qualifications','Qualifications / certifications',80),('awards','Awards / recognition',90),
      ('client_history','Client / collaboration history',100),('photos_videos','Professional photos / videos',110),
      ('media_kit','Media kit / company profile',120),('registration','Business registration / memberships',130),('socials','Established social channels',140)
    ) AS o(value,label,ord) ON true WHERE f.version_id=v_version_id AND f.field_key='growth_credibility_assets';

    INSERT INTO growth_form_field_options(field_id,option_value,option_label,display_order)
    SELECT f.id,o.value,o.label,o.ord FROM growth_form_fields f JOIN (VALUES
      ('photography','Photography',10),('video','Video / showreel',20),('copywriting','Copywriting / written bio',30),
      ('media_kit','Media kit',40),('company_profile','Company profile',50),('portfolio','Portfolio structure',60),('other','Other',70)
    ) AS o(value,label,ord) ON true WHERE f.version_id=v_version_id AND f.field_key='growth_content_support';

    INSERT INTO growth_form_field_options(field_id,option_value,option_label,display_order)
    SELECT f.id,o.value,o.label,o.ord FROM growth_form_fields f JOIN (VALUES
      ('employment','Employment',10),('freelance','Freelance',20),('contracts','Contracts',30),('modelling','Modelling',40),
      ('acting','Acting',50),('photo_video','Photo / video',60),('media','Media / interviews / editorial',70),
      ('speaking','Speaking',80),('events','Events',90),('brand_campaigns','Brand campaigns / influencer work',100),
      ('partnership','Partnership',110),('sponsorship','Sponsorship',120),('mentorship','Mentorship',130),
      ('training','Training',140),('competitions','Competitions',150),('networking','Networking',160),
      ('volunteer','Volunteer / community',170),('entrepreneurship','Entrepreneurship',180),('funding','Funding / investment',190),
      ('supplier','Supplier / procurement',200),('collaboration','Collaboration',210),('other','Other',220)
    ) AS o(value,label,ord) ON true WHERE f.version_id=v_version_id AND f.field_key='growth_opportunities_sought';

    INSERT INTO growth_form_field_options(field_id,option_value,option_label,display_order)
    SELECT f.id,o.value,o.label,o.ord FROM growth_form_fields f JOIN (VALUES
      ('none','No current budget',10),('under_500','Under R500',20),('500_1999','R500 – R1,999',30),
      ('2000_4999','R2,000 – R4,999',40),('5000_9999','R5,000 – R9,999',50),('10000_24999','R10,000 – R24,999',60),
      ('25000_plus','R25,000+',70),('prefer_not','Prefer not to say',80)
    ) AS o(value,label,ord) ON true WHERE f.version_id=v_version_id AND f.field_key='growth_budget_range';

    INSERT INTO growth_form_field_options(field_id,option_value,option_label,display_order)
    SELECT f.id,o.value,o.label,o.ord FROM growth_form_fields f JOIN (VALUES
      ('pre_revenue','Pre-revenue',10),('under_5000','Under R5,000',20),('5000_19999','R5,000 – R19,999',30),
      ('20000_49999','R20,000 – R49,999',40),('50000_99999','R50,000 – R99,999',50),
      ('100000_plus','R100,000+',60),('prefer_not','Prefer not to say',70)
    ) AS o(value,label,ord) ON true WHERE f.version_id=v_version_id AND f.field_key='growth_revenue_range';

    INSERT INTO growth_form_field_options(field_id,option_value,option_label,display_order)
    SELECT f.id,o.value,o.label,o.ord FROM growth_form_fields f JOIN (VALUES
      ('collaborate','Collaborate with members',10),('mentor','Mentor / help others',20),('events','Take part in events',30),
      ('campaigns','Take part in campaigns',40),('content','Contribute content / interviews',50),('community','Support community projects',60),('other','Other',70)
    ) AS o(value,label,ord) ON true WHERE f.version_id=v_version_id AND f.field_key='growth_contribution_willingness';

    INSERT INTO growth_form_field_options(field_id,option_value,option_label,display_order)
    SELECT f.id,o.value,o.label,o.ord FROM growth_form_fields f JOIN (VALUES
      ('yes','Yes — relevant profile information may be shared if I have also enabled external sharing',10),
      ('ask_first','Ask me first each time',20),('no','Do not share externally',30)
    ) AS o(value,label,ord) ON true WHERE f.version_id=v_version_id AND f.field_key='growth_external_partner_preference';
  END IF;
END $$;
