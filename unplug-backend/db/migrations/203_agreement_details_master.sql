-- Agreement Details — reusable master preset for the standalone Agreement Generator.
-- This is product configuration, not test/demo data. It is intentionally
-- additive and uses ON CONFLICT DO NOTHING so an administrator's later edits
-- are never overwritten by a deploy.

INSERT INTO agreement_templates
  (name,category,title,description,signer_type,rules,terms,post_signing_requirements,
   payment_mode,require_witness,require_company_stamp,is_builtin)
VALUES
  ('Agreement Details — Master','Master','Agreement Details',
   'Reusable master containing identification, Party A, Party B, scope, financial, rights/IP, privacy, legal, agreement-specific and signature sections.',
   'choice','','','','none',false,false,true)
ON CONFLICT ((LOWER(name))) DO NOTHING;

DO $$
DECLARE
  master_id INTEGER;
BEGIN
  SELECT id INTO master_id FROM agreement_templates
   WHERE LOWER(name)=LOWER('Agreement Details — Master') LIMIT 1;
  IF master_id IS NULL THEN RETURN; END IF;

  INSERT INTO template_fields
    (template_id,position,kind,field_key,label,placeholder,help,required,options,max_length,
     section_key,party_scope,condition_json,config,sensitive_type,popia_enabled,
     popia_purpose,popia_retention,popia_access,popia_ack_required)
  VALUES
    -- 1. Agreement identification
    (master_id,10,'date','effective_date','Effective / start date',NULL,NULL,true,'[]',NULL,'agreement_identification','agreement','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,20,'date','end_date','End / expiry date',NULL,'Leave blank where the agreement has no fixed expiry.',false,'[]',NULL,'agreement_identification','agreement','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,30,'select','renewal_type','Renewal type',NULL,NULL,true,'["None","Automatic","By mutual agreement"]',NULL,'agreement_identification','agreement','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,40,'text','project_campaign_service_name','Project, campaign, event or service name',NULL,NULL,false,'[]',220,'agreement_identification','agreement','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,50,'textarea','agreement_purpose','Short description / purpose of the agreement',NULL,NULL,true,'[]',5000,'agreement_identification','agreement','{}','{}',NULL,false,NULL,NULL,NULL,false),

    -- 2. Party A — Unplug / business. Party B never edits these fields.
    (master_id,110,'text','party_a_registered_name','Party A — registered company name',NULL,NULL,true,'[]',240,'party_a_business','party_a','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,120,'text','party_a_trading_name','Party A — trading name',NULL,NULL,false,'[]',240,'party_a_business','party_a','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,130,'text','party_a_registration_number','Party A — company registration number',NULL,NULL,false,'[]',120,'party_a_business','party_a','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,140,'textarea','party_a_address','Party A — registered / business address',NULL,NULL,false,'[]',1000,'party_a_business','party_a','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,150,'email','party_a_email','Party A — email address',NULL,NULL,true,'[]',255,'party_a_business','party_a','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,160,'phone','party_a_phone','Party A — telephone number',NULL,NULL,false,'[]',80,'party_a_business','party_a','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,170,'text','party_a_website','Party A — website',NULL,NULL,false,'[]',300,'party_a_business','party_a','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,180,'text','party_a_vat_number','Party A — VAT number',NULL,NULL,false,'[]',120,'party_a_business','party_a','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,190,'text','party_a_representative_name','Party A — authorised representative name',NULL,NULL,true,'[]',220,'party_a_business','party_a','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,200,'text','party_a_representative_capacity','Party A — representative job title / capacity',NULL,NULL,true,'[]',180,'party_a_business','party_a','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,210,'email','party_a_representative_email','Party A — representative email',NULL,NULL,false,'[]',255,'party_a_business','party_a','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,220,'phone','party_a_representative_phone','Party A — representative telephone',NULL,NULL,false,'[]',80,'party_a_business','party_a','{}','{}',NULL,false,NULL,NULL,NULL,false),

    -- 3. Party B — Individual
    (master_id,310,'text','party_b_individual_legal_name','Full legal name and surname',NULL,NULL,true,'[]',240,'party_b_individual','party_b_individual','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,320,'text','party_b_individual_display_name','Preferred / display name',NULL,NULL,false,'[]',220,'party_b_individual','party_b_individual','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,330,'text','party_b_individual_id_passport','South African ID or passport number',NULL,'Disabled by default. Admin may enable only where genuinely required and after configuring POPIA controls.',false,'[]',120,'party_b_individual','party_b_individual','{}','{}','identity_document',false,NULL,NULL,NULL,false),
    (master_id,340,'textarea','party_b_individual_address','Residential or business address',NULL,NULL,false,'[]',1000,'party_b_individual','party_b_individual','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,350,'email','party_b_individual_email','Email address',NULL,NULL,true,'[]',255,'party_b_individual','party_b_individual','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,360,'phone','party_b_individual_mobile','Mobile number',NULL,NULL,true,'[]',80,'party_b_individual','party_b_individual','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,370,'text','party_b_individual_country','Country',NULL,NULL,true,'[]',120,'party_b_individual','party_b_individual','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,380,'text','party_b_individual_capacity','Capacity / role',NULL,'For example model, contributor, contractor, sponsor representative or participant.',false,'[]',180,'party_b_individual','party_b_individual','{}','{}',NULL,false,NULL,NULL,NULL,false),

    -- 4. Party B — Business
    (master_id,410,'text','party_b_business_registered_name','Registered company / business name',NULL,NULL,true,'[]',240,'party_b_business','party_b_business','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,420,'text','party_b_business_trading_name','Trading name',NULL,NULL,false,'[]',240,'party_b_business','party_b_business','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,430,'text','party_b_business_registration_number','Company / registration number',NULL,NULL,false,'[]',120,'party_b_business','party_b_business','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,440,'text','party_b_business_vat_number','VAT number',NULL,NULL,false,'[]',120,'party_b_business','party_b_business','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,450,'textarea','party_b_business_address','Registered / business address',NULL,NULL,true,'[]',1000,'party_b_business','party_b_business','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,460,'email','party_b_business_email','Business email',NULL,NULL,true,'[]',255,'party_b_business','party_b_business','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,470,'phone','party_b_business_phone','Business telephone',NULL,NULL,false,'[]',80,'party_b_business','party_b_business','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,480,'text','party_b_business_website','Website',NULL,NULL,false,'[]',300,'party_b_business','party_b_business','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,490,'text','party_b_business_representative_name','Authorised representative name',NULL,NULL,true,'[]',220,'party_b_business','party_b_business','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,500,'text','party_b_business_representative_capacity','Representative job title / capacity',NULL,NULL,true,'[]',180,'party_b_business','party_b_business','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,510,'email','party_b_business_representative_email','Representative email',NULL,NULL,true,'[]',255,'party_b_business','party_b_business','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,520,'phone','party_b_business_representative_mobile','Representative mobile / telephone',NULL,NULL,false,'[]',80,'party_b_business','party_b_business','{}','{}',NULL,false,NULL,NULL,NULL,false),

    -- 5. Scope of agreement
    (master_id,610,'textarea','scope_description','Scope of agreement',NULL,'Describe what the agreement covers.',true,'[]',10000,'scope','agreement','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,620,'textarea','deliverables','Deliverables / outputs',NULL,NULL,false,'[]',10000,'scope','agreement','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,630,'textarea','party_a_responsibilities','Party A responsibilities',NULL,NULL,false,'[]',10000,'scope','agreement','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,640,'textarea','party_b_responsibilities','Party B responsibilities',NULL,NULL,false,'[]',10000,'scope','agreement','{}','{}',NULL,false,NULL,NULL,NULL,false),

    -- 6. Financial information
    (master_id,710,'number','agreement_fee_amount','Fee / agreement amount (ZAR)',NULL,NULL,false,'[]',NULL,'financial_information','agreement','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,720,'textarea','payment_terms','Payment terms / schedule',NULL,NULL,false,'[]',5000,'financial_information','agreement','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,730,'textarea','expenses_costs','Expenses, costs or reimbursements',NULL,NULL,false,'[]',5000,'financial_information','agreement','{}','{}',NULL,false,NULL,NULL,NULL,false),

    -- 7. Rights, content and intellectual property
    (master_id,810,'textarea','intellectual_property_ownership','Intellectual property / ownership',NULL,NULL,false,'[]',10000,'rights_content_ip','agreement','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,820,'textarea','content_usage_rights','Content / image / likeness usage rights',NULL,NULL,false,'[]',10000,'rights_content_ip','agreement','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,830,'textarea','licence_permissions','Licences and permissions',NULL,NULL,false,'[]',10000,'rights_content_ip','agreement','{}','{}',NULL,false,NULL,NULL,NULL,false),

    -- 8. Privacy and confidentiality
    (master_id,910,'textarea','confidentiality_requirements','Confidentiality requirements',NULL,NULL,false,'[]',10000,'privacy_confidentiality','agreement','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,920,'textarea','personal_information_processing','Personal-information processing / POPIA notes',NULL,NULL,false,'[]',10000,'privacy_confidentiality','agreement','{}','{}',NULL,false,NULL,NULL,NULL,false),

    -- 9. Risk, warranties and legal provisions
    (master_id,1010,'textarea','warranties_representations','Warranties and representations',NULL,NULL,false,'[]',10000,'risk_warranties_legal','agreement','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,1020,'textarea','risk_indemnity_liability','Risk, indemnity and liability',NULL,NULL,false,'[]',10000,'risk_warranties_legal','agreement','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,1030,'textarea','termination_breach','Termination and breach',NULL,NULL,false,'[]',10000,'risk_warranties_legal','agreement','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,1040,'textarea','dispute_resolution','Dispute resolution',NULL,NULL,false,'[]',10000,'risk_warranties_legal','agreement','{}','{}',NULL,false,NULL,NULL,NULL,false),
    (master_id,1050,'text','governing_law','Governing law / jurisdiction',NULL,'For example: Republic of South Africa.',false,'[]',300,'risk_warranties_legal','agreement','{}','{}',NULL,false,NULL,NULL,NULL,false),

    -- 10. Agreement-specific questions
    (master_id,1110,'textarea','special_conditions','Agreement-specific questions / special conditions',NULL,'Add or replace with questions unique to this agreement type.',false,'[]',10000,'agreement_specific_questions','agreement','{}','{}',NULL,false,NULL,NULL,NULL,false),

    -- 11. Declarations and signatures. The signature itself is captured by the
    -- signing workflow; this checkbox is an explicit declaration.
    (master_id,1210,'checkbox','information_declaration','I declare that the information supplied is true and complete.',NULL,NULL,true,'[]',NULL,'declarations_signatures','agreement','{}','{}',NULL,false,NULL,NULL,NULL,false)
  ON CONFLICT DO NOTHING;
END $$;
