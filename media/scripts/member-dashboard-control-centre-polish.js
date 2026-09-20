(function(){
'use strict';
if(window.__unplugMemberCCPolish)return;
if(!/unplug-member-dashboard/i.test(location.pathname))return;
window.__unplugMemberCCPolish=true;

var observer=null;
var scheduled=0;
var accountShortcut='';

function q(sel,root){return (root||document).querySelector(sel)}
function qa(sel,root){return Array.prototype.slice.call((root||document).querySelectorAll(sel))}
function txt(el,value){value=String(value==null?'':value);if(el&&el.textContent!==value)el.textContent=value}
function clickNav(id){var el=q('#ccMemberNav [data-id="'+id+'"]');if(el)el.click()}
function focusSelector(selector){setTimeout(function(){var el=q(selector);if(!el)return;try{el.scrollIntoView({behavior:'smooth',block:'center'})}catch(_){el.scrollIntoView()}},120)}

function loadCss(){
  if(q('link[data-member-control-centre-polish-css]'))return;
  var link=document.createElement('link');
  link.rel='stylesheet';
  link.href='/media/styles/member-dashboard-control-centre-polish.css?v=20260913-1';
  link.setAttribute('data-member-control-centre-polish-css','true');
  (document.head||document.documentElement).appendChild(link);
}

function accountLeaf(id,label,icon){
  var wrap=document.createElement('div');
  wrap.className='cc-member-node cc-member-leaf';
  wrap.dataset.node=id;
  wrap.style.setProperty('--cc-depth',1);
  wrap.innerHTML='<div class="cc-member-leaf-row"><button type="button" class="cc-member-nav-action" data-id="'+id+'" data-account-shortcut="'+id+'"><span class="cc-member-icon">'+icon+'</span><span class="cc-member-label">'+label+'</span></button></div>';
  return wrap;
}

function setAccountContext(label){
  var crumb=q('#ccMemberContext .cc-member-crumb');
  var strong=crumb&&q('strong',crumb);
  if(strong)txt(strong,label);
}

function clearAccountShortcut(){
  qa('#ccMemberNav [data-account-shortcut]').forEach(function(button){button.classList.remove('active');button.removeAttribute('aria-current')});
}

function openAccountShortcut(id,label,selector){
  var base=q('#ccMemberNav [data-id="account-settings"]');
  if(base)base.click();
  setTimeout(function(){
    accountShortcut=id;
    clearAccountShortcut();
    if(base){base.classList.remove('active');base.removeAttribute('aria-current')}
    var custom=q('#ccMemberNav [data-account-shortcut="'+id+'"]');
    if(custom){custom.classList.add('active');custom.setAttribute('aria-current','page')}
    setAccountContext(label);
    focusSelector(selector);
  },70);
}

function syncAccountShortcuts(){
  var account=q('#ccMemberTree [data-node="g-account"]');
  var children=account&&q(':scope > .cc-member-children',account);
  if(!children)return;
  var baseNode=q('[data-node="account-settings"]',children);
  if(!q('[data-node="login-security"]',children)){
    var security=accountLeaf('login-security','Login & Security','◆');
    if(baseNode&&baseNode.nextSibling)children.insertBefore(security,baseNode.nextSibling);else children.appendChild(security);
    q('[data-account-shortcut="login-security"]',security).addEventListener('click',function(){openAccountShortcut('login-security','Login & Security','#twoFactorContent')});
  }
  if(!q('[data-node="communication-preferences"]',children)){
    var prefs=accountLeaf('communication-preferences','Notification Preferences','●');
    var securityNode=q('[data-node="login-security"]',children);
    if(securityNode&&securityNode.nextSibling)children.insertBefore(prefs,securityNode.nextSibling);else children.appendChild(prefs);
    q('[data-account-shortcut="communication-preferences"]',prefs).addEventListener('click',function(){openAccountShortcut('communication-preferences','Notification Preferences','#notifPrefsContent')});
  }
  if(accountShortcut){
    var active=q('[data-account-shortcut="'+accountShortcut+'"]',children);
    if(active){active.classList.add('active');active.setAttribute('aria-current','page')}
  }
}

var PAGE_META={
  'directory-profile':['My Directory Profile','Manage the public professional or business profile people see in the Unplug Directory.'],
  'directory-performance':['Directory Performance','Review the existing analytics connected to your public Directory presence and published work.'],
  'community-profile':['My Profile','Manage your personal Unplug profile, identity details and community visibility.'],
  'profile-completion':['Profile Completion','See what is complete and exactly what still needs attention on your personal profile.'],
  'public-profile':['Preview My Unplug Profile','Open the existing public-profile preview for your personal Unplug identity.'],
  'growth-overview':['My Growth Journey','Continue your existing Growth Application, assigned tasks and development progress.'],
  'my-submissions':['My Submissions','View content and entries you have submitted and check their current status.'],
  'my-articles':['My Articles','View your article submissions and their current approval or publishing status.'],
  'my-events':['My Events','View your event submissions and their current approval or publishing status.'],
  'my-listings':['My Listings','View your listing submissions and their current approval or publishing status.'],
  'reading-list':['Reading List','Return to articles you saved so you can read them again later.'],
  'my-editions':['My Editions','View magazine editions connected to your member account.'],
  'journey-referral':['Referral Progress','Track the existing referral activity connected to your Unplug participation.'],
  'my-referrals':['My Referrals','View members connected to your existing referral or representative activity.'],
  'my-clients':['My Clients','View members connected to your existing representative or consultant role.'],
  'journey-status':['My Score & Level','See your current Unplug Score, status level, streak and recognition progress.'],
  'journey-today':['Missions','View the current missions already available through your My Unplug participation.'],
  'journey-week':["This Week's Mission",'View the current weekly mission and your existing progress.'],
  'journey-month':["This Month's Challenge",'View the current monthly challenge and your existing progress.'],
  'journey-achievements':['My Achievements','Review achievements already awarded through your Unplug participation.'],
  'journey-passport':['Unplug Passport','Review the passport stamps and milestones already earned on your journey.'],
  'leaderboard':['Leaderboard','View the existing Unplug rankings and participation leaderboard.'],
  'my-competitions':['My Competitions','View competition entries connected to your account and their status.'],
  'my-votes':['My Votes','Review votes and vote packages already connected to your account.'],
  'browse-competitions':['Browse Competitions','Explore competition opportunities currently available on UnplugNews.'],
  'browse-services':['Browse Services','Explore the existing UnplugNews services available to members.'],
  'my-services':['My Services','View services already connected to your account and their current state.'],
  'my-advertising':['My Advertising','View advertising submissions connected to your account and their current status.'],
  'my-orders':['My Orders','Review your existing orders, references and current payment or approval state.'],
  'payments':['Payments','Review payment records already connected to your member account.'],
  'my-credits':['Unplug Credits','Review your available Unplug Credit and existing credit history.'],
  'my-invoices':['My Invoices','Open invoices already issued for your member purchases.'],
  'notifications':['All Notifications','Review important member, account and activity notifications in one place.'],
  'my-agreements':['My Agreements','Review agreements currently connected to your member account.'],
  'available-agreements':['Available Agreements','View agreement templates currently available for you to complete.'],
  'contact-support':['Contact Support','Use the existing UnplugNews contact channel when you need help.'],
  'account-settings':['Account Details','Manage the account controls already available in your member workspace.'],
  'login-security':['Login & Security','Manage your password and existing two-step sign-in controls.'],
  'communication-preferences':['Notification Preferences','Choose which non-essential account notifications UnplugNews sends you.'],
  'your-data':['Privacy & Your Data','Review privacy controls and the data tools available to your account.'],
  'download-data':['Download My Data','Use the existing privacy export tool to download your account data.']
};
function pageActive(){return q('#ccMemberNav .cc-member-nav-action.active')||q('#ccMemberNav [aria-current="page"]')}
function pageLabel(button){var x=button&&q('.cc-member-label',button);return String((x&&x.textContent)||(button&&button.textContent)||'Member Dashboard').replace(/\s+/g,' ').trim()}
function pageStatus(id,section){
  var label='',note='';
  if(id==='community-profile'||id==='profile-completion'||id==='public-profile'){
    var p=q('#muCompletionPct'),pub=q('#muPublishLabel');
    label=String((pub&&pub.textContent)||(p&&p.textContent)||'In progress').trim();
    note=p&&p.textContent?'Profile completion '+String(p.textContent).trim():'Personal profile status';
  }else if(id==='directory-profile'||id==='directory-performance'){
    var pill=section&&q('.status-pill',section);
    label=String((pill&&pill.textContent)||'Current profile').trim();
    note='Directory status';
  }else if(id==='notifications'){
    var badge=q('#notifCountBadge'),n=String(badge&&badge.textContent||'').trim();
    label=n?(n+' unread'):'Up to date';note='Notification status';
  }else if(id==='my-submissions'||/^my-(articles|events|listings|advertising|competitions)$/.test(id)){
    var rows=section?qa('.subs-row',section).length:0;
    label=rows+' item'+(rows===1?'':'s');note='Current submission view';
  }else{
    label='Ready';note='This area is available to use.';
  }
  return {label:label,note:note};
}
function syncPageHeader(){
  var home=q('#ccMemberHome');
  if(home&&!home.classList.contains('section-hidden'))return;
  var section=qa('.ms-section[data-ms-section]').find(function(x){return !x.classList.contains('section-hidden')&&!x.hidden});
  if(!section)return;
  var active=pageActive(),id=active&&active.dataset&&(active.dataset.id||active.dataset.accountShortcut)||'',label=pageLabel(active);
  var meta=PAGE_META[id]||[label,'View and manage this part of your UnplugNews member account.'];
  var status=pageStatus(id,section),sig=[id,meta[0],meta[1],status.label,status.note].join('|');
  var head=q('[data-cc-page-head]',section);
  if(!head){head=document.createElement('div');head.className='cc-member-page-head';head.dataset.ccPageHead='true';section.insertBefore(head,section.firstChild)}
  if(head.dataset.signature===sig)return;
  head.dataset.signature=sig;
  head.innerHTML='<div class="cc-member-page-head-copy"><span>MEMBER DASHBOARD</span><h1>'+meta[0]+'</h1><p>'+meta[1]+'</p></div><div class="cc-member-page-status '+(/^Ready$/.test(status.label)?'is-neutral':'')+'"><small>'+status.note+'</small><strong>'+status.label+'</strong></div>';
}

function patchMobileMenuA11y(){
  var button=q('#msMenuBtn'),side=q('#msSidebar');
  if(!button||!side)return;
  button.setAttribute('aria-controls','msSidebar');
  button.setAttribute('aria-expanded',side.classList.contains('open')?'true':'false');
  if(button.dataset.ccMobileBound)return;
  button.dataset.ccMobileBound='true';
  button.addEventListener('click',function(){setTimeout(function(){button.setAttribute('aria-expanded',side.classList.contains('open')?'true':'false')},0)});
  document.addEventListener('keydown',function(ev){
    if(ev.key!=='Escape'||!matchMedia('(max-width:820px)').matches||!side.classList.contains('open'))return;
    side.classList.remove('open');
    button.setAttribute('aria-expanded','false');
    button.focus();
  });
}

function patchNavigationA11y(){
  var nav=q('#ccMemberNav');
  if(nav){nav.setAttribute('role','navigation');nav.setAttribute('aria-label','Member Dashboard navigation')}
  qa('#ccMemberNav .cc-member-icon').forEach(function(icon){icon.setAttribute('aria-hidden','true')});
  qa('#ccMemberNav .cc-member-branch').forEach(function(branch){
    var toggle=q(':scope > .cc-member-branch-head > .cc-member-toggle',branch);
    var children=q(':scope > .cc-member-children',branch);
    var action=q(':scope > .cc-member-branch-head > .cc-member-nav-action',branch);
    if(!toggle||!children)return;
    if(!children.id)children.id='cc-member-children-'+Math.random().toString(36).slice(2,9);
    var open=branch.classList.contains('open'),label=String((action&&q('.cc-member-label',action)&&q('.cc-member-label',action).textContent)||'section').replace(/\s+/g,' ').trim();
    toggle.setAttribute('aria-controls',children.id);
    toggle.setAttribute('aria-expanded',open?'true':'false');
    toggle.setAttribute('aria-label',(open?'Collapse ':'Expand ')+label);
    if(!toggle.dataset.ccA11yBound){
      toggle.dataset.ccA11yBound='true';
      toggle.addEventListener('click',function(){setTimeout(patchNavigationA11y,0)});
    }
  });

  qa('#ccMemberNav .cc-member-nav-action').forEach(function(button){
    if(button.classList.contains('active'))button.setAttribute('aria-current','page');
    else button.removeAttribute('aria-current');
  });
  qa('#ccMemberNav .cc-member-star').forEach(function(star){
    var row=star.closest('.cc-member-leaf-row'),button=row&&q('.cc-member-nav-action',row),label=String((button&&q('.cc-member-label',button)&&q('.cc-member-label',button).textContent)||'item').replace(/\s+/g,' ').trim();
    star.setAttribute('aria-label',(star.textContent==='★'?'Remove ':'Add ')+label+(star.textContent==='★'?' from favourites':' to favourites'));
  });
}
function patchHomeA11y(){
  qa('#ccMemberHome [data-panel]').forEach(function(panel){
    var button=q('.cc-home-panel-toggle',panel);
    var body=q('.cc-home-panel-body',panel);
    if(!button||!body)return;
    if(!body.id)body.id='cc-home-panel-'+String(panel.dataset.panel||Math.random().toString(36).slice(2,8));
    button.setAttribute('aria-controls',body.id);
    button.setAttribute('aria-expanded',panel.classList.contains('collapsed')?'false':'true');
    button.setAttribute('aria-label',(panel.classList.contains('collapsed')?'Expand ':'Collapse ')+(q('h2',panel)?q('h2',panel).textContent:'dashboard panel'));
    if(!button.dataset.ccA11yBound){
      button.dataset.ccA11yBound='true';
      button.addEventListener('click',function(){setTimeout(patchHomeA11y,0)});
    }
  });
}

function profilePercent(){
  var el=q('#muCompletionPct');
  var match=el&&String(el.textContent||'').match(/\d+/);
  return match?Math.max(0,Math.min(100,+match[0])):0;
}

function syncProfileChecklist(){
  var cards=q('#ccHomeUnplug');
  if(!cards)return;
  var host=q('#ccHomeProfileChecklist');
  if(!host){
    host=document.createElement('div');
    host.id='ccHomeProfileChecklist';
    host.className='cc-home-profile-checklist';
    cards.appendChild(host);
  }
  var pct=profilePercent();
  var todo=q('#muCompletionTodo');
  var raw=String(todo&&todo.textContent||'').trim();
  var items=[];
  if(/^Still to do:/i.test(raw)){
    items=raw.replace(/^Still to do:\s*/i,'').split(/\s*·\s*/).filter(Boolean).map(function(item){return item.replace(/\s*\(\+\d+%\)\s*$/,'').trim()});
  }
  var signature=pct+'|'+items.join('|')+'|'+raw;
  if(host.dataset.signature===signature)return;
  host.dataset.signature=signature;
  var rows=['<div class="cc-home-profile-item done"><b>✓</b><span>'+pct+'% of your My Unplug profile is complete.</span></div>'];
  if(!items.length&&pct>=100)rows.push('<div class="cc-home-profile-item done"><b>✓</b><span>Your profile checklist is complete.</span></div>');
  else items.slice(0,6).forEach(function(item){rows.push('<div class="cc-home-profile-item"><b>×</b><span>'+item.replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})+'</span></div>')});
  host.innerHTML='<div class="cc-home-profile-checklist-head"><strong>Profile checklist</strong><button type="button">Open profile →</button></div><div class="cc-home-profile-list">'+rows.join('')+'</div>';
  q('button',host).addEventListener('click',function(){clickNav('profile-completion')});
}

function syncGrowthBridge(){
  var cards=q('#ccHomeUnplug');
  if(!cards)return;
  var host=q('#ccHomeGrowthBridge');
  if(!host){
    host=document.createElement('div');
    host.id='ccHomeGrowthBridge';
    host.className='cc-home-growth-bridge';
    var checklist=q('#ccHomeProfileChecklist');
    if(checklist)checklist.insertAdjacentElement('afterend',host);else cards.appendChild(host);
  }
  var pct=profilePercent();
  var score=String((q('#unplugScore')&&q('#unplugScore').textContent)||'—').trim();
  var status=String((q('#unplugStatusBadge')&&q('#unplugStatusBadge').textContent)||'Your journey').trim();
  var growthAvailable=!!q('#ccMemberNav [data-node="g-growth"]');
  var signature=[pct,score,status,growthAvailable].join('|');
  if(host.dataset.signature===signature)return;
  host.dataset.signature=signature;
  host.innerHTML='<div class="cc-home-growth-bridge-title"><strong>Your Unplug path</strong><span>Your identity, participation and growth work together.</span></div><div class="cc-home-path">'
    +'<button type="button" class="cc-home-path-step '+(pct>=100?'is-complete':'')+'" data-polish-go="profile-completion"><small>1 · Identity</small><strong>'+pct+'% profile</strong><span>Build how people discover you.</span></button>'
    +'<button type="button" class="cc-home-path-step '+(score!=='—'&&score!=='0'?'is-complete':'')+'" data-polish-go="journey-status"><small>2 · Participate</small><strong>'+status+'</strong><span>Score '+score+' · missions, badges and recognition.</span></button>'
    +'<button type="button" class="cc-home-path-step '+(growthAvailable?'is-complete':'')+'" data-polish-go="'+(growthAvailable?'growth-overview':'browse-services')+'"><small>3 · Grow</small><strong>'+(growthAvailable?'Growth Journey':'Growth tools')+'</strong><span>'+(growthAvailable?'Continue your development journey.':'Explore what can help you grow.')+'</span></button>'
    +'<button type="button" class="cc-home-path-step" data-polish-go="browse-services"><small>4 · Opportunities</small><strong>Take your next step</strong><span>Use Unplug services and opportunities.</span></button>'
    +'</div>';
  qa('[data-polish-go]',host).forEach(function(button){button.addEventListener('click',function(){clickNav(button.dataset.polishGo)})});
}

function addSearchShortcut(results,id,label,parent){
  if(q('[data-polish-search="'+id+'"]',results))return;
  var empty=q('.cc-member-search-empty',results);if(empty)empty.remove();
  var button=document.createElement('button');
  button.type='button';
  button.className='cc-member-search-result';
  button.dataset.polishSearch=id;
  button.innerHTML='<strong>'+label+'</strong><span>'+parent+'</span>';
  button.addEventListener('click',function(){
    results.hidden=true;
    var target=q('#ccMemberNav [data-account-shortcut="'+id+'"]');
    if(target)target.click();
  });
  results.appendChild(button);
}

function augmentSearch(){
  var search=q('#ccMemberSearch');
  var results=q('#ccMemberSearchResults');
  if(!search||!results)return;
  var term=String(search.value||'').trim().toLowerCase();
  var security=q('[data-polish-search="login-security"]',results);
  var prefs=q('[data-polish-search="communication-preferences"]',results);
  var wantSecurity=!!term&&/login|security|password|two[- ]?factor|2fa/.test(term);
  var wantPrefs=!!term&&/communication|preference|notifications?|email/.test(term);
  if(wantSecurity&&!security)addSearchShortcut(results,'login-security','Login & Security','Account & Settings');
  else if(!wantSecurity&&security)security.remove();
  if(wantPrefs&&!prefs)addSearchShortcut(results,'communication-preferences','Notification Preferences','Account & Settings');
  else if(!wantPrefs&&prefs)prefs.remove();
  if(wantSecurity||wantPrefs)results.hidden=false;
}

function patchSearch(){
  var search=q('#ccMemberSearch');
  var results=q('#ccMemberSearchResults');
  if(!search)return;
  search.setAttribute('aria-expanded',results&&!results.hidden?'true':'false');
  if(search.dataset.ccA11yBound)return;
  search.dataset.ccA11yBound='true';
  search.setAttribute('aria-label','Find something in Member Dashboard');
  search.setAttribute('aria-controls','ccMemberSearchResults');
  search.setAttribute('aria-autocomplete','list');
  if(results){results.setAttribute('role','region');results.setAttribute('aria-label','Dashboard search results')}
  search.addEventListener('input',function(){setTimeout(function(){augmentSearch();patchSearch()},0)});
  search.addEventListener('keydown',function(ev){
    if(ev.key!=='Escape')return;
    search.value='';
    search.dispatchEvent(new Event('input',{bubbles:true}));
    search.focus();
  });
}
function patchModal(){
  var modal=q('#ccMemberQuickCreate');
  if(!modal||modal.dataset.ccA11yBound)return;
  modal.dataset.ccA11yBound='true';
  var card=q('.cc-member-modal-card',modal);
  var title=q('.cc-member-modal-head h2',modal);
  var close=q('[data-close]',modal);
  var returnFocus=document.activeElement;
  if(card){
    card.setAttribute('role','dialog');
    card.setAttribute('aria-modal','true');
    if(title){if(!title.id)title.id='ccMemberQuickCreateTitle';card.setAttribute('aria-labelledby',title.id)}
  }
  if(close){close.setAttribute('aria-label','Close quick create');setTimeout(function(){try{close.focus()}catch(_){}},0)}
  function restore(){if(returnFocus&&returnFocus.focus&&document.contains(returnFocus))try{returnFocus.focus()}catch(_){}}
  function keys(ev){
    if(!modal.isConnected){document.removeEventListener('keydown',keys,true);return}
    if(ev.key==='Escape'){
      ev.preventDefault();
      document.removeEventListener('keydown',keys,true);
      modal.remove();
      restore();
      return;
    }
    if(ev.key!=='Tab'||!card)return;
    var focusable=qa('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',card).filter(function(x){return !x.hidden&&x.offsetParent!==null});
    if(!focusable.length)return;
    var first=focusable[0],last=focusable[focusable.length-1];
    if(ev.shiftKey&&document.activeElement===first){ev.preventDefault();last.focus()}
    else if(!ev.shiftKey&&document.activeElement===last){ev.preventDefault();first.focus()}
  }
  document.addEventListener('keydown',keys,true);
  modal.addEventListener('click',function(ev){
    if(!(ev.target===modal||(ev.target&&ev.target.closest&&ev.target.closest('[data-close]'))))return;
    setTimeout(function(){document.removeEventListener('keydown',keys,true);restore()},0);
  },true);
}
function apply(){
  scheduled=0;
  if(!q('#ccMemberNav'))return;
  syncAccountShortcuts();
  syncPageHeader();
  patchMobileMenuA11y();
  patchNavigationA11y();
  patchHomeA11y();
  syncProfileChecklist();
  syncGrowthBridge();
  patchSearch();
  augmentSearch();
  patchModal();
}

function schedule(){
  if(scheduled)return;
  scheduled=setTimeout(apply,45);
}

function init(){
  loadCss();
  apply();
  observer=new MutationObserver(schedule);
  observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,characterData:true,attributeFilter:['class','hidden','style']});
  document.addEventListener('click',function(ev){
    var nav=ev.target&&ev.target.closest?ev.target.closest('#ccMemberNav .cc-member-nav-action'):null;
    var custom=ev.target&&ev.target.closest?ev.target.closest('[data-account-shortcut]'):null;
    if(nav&&!custom){accountShortcut='';clearAccountShortcut()}
    schedule();
  },true);
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
