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

function syncTopNotification(){
  var tree=q('#ccMemberTree');
  if(!tree)return;
  var community=q('[data-node="g-community"]',tree);
  var source=community&&q('[data-id="notifications"]',community);
  if(!source)return;

  var existing=q('[data-node="notifications-quick"]',tree);
  if(!existing){
    var wrap=document.createElement('div');
    wrap.className='cc-member-node cc-member-leaf';
    wrap.dataset.node='notifications-quick';
    wrap.style.setProperty('--cc-depth',0);
    wrap.innerHTML='<div class="cc-member-leaf-row"><button type="button" class="cc-member-nav-action" data-id="notifications-quick" aria-label="Open notifications"><span class="cc-member-icon">●</span><span class="cc-member-label">Notifications</span><span class="cc-member-count" data-polish-notification-count hidden></span></button><button type="button" class="cc-member-star" data-polish-notification-star aria-label="Favourite Notifications">☆</button></div>';
    var home=q('[data-node="g-home"]',tree);
    if(home&&home.nextSibling)tree.insertBefore(wrap,home.nextSibling);else if(home)tree.appendChild(wrap);else tree.insertBefore(wrap,tree.firstChild);
    existing=wrap;

    q('[data-id="notifications-quick"]',wrap).addEventListener('click',function(){
      var current=q('[data-node="g-community"] [data-id="notifications"]',tree);
      if(current)current.click();
    });
    q('[data-polish-notification-star]',wrap).addEventListener('click',function(ev){
      ev.stopPropagation();
      var star=q('[data-node="g-community"] [data-star="notifications"]',tree);
      if(star)star.click();
      schedule();
    });
  }

  var nativeCount=q('#notifCountBadge');
  var count=q('[data-polish-notification-count]',existing);
  var text=nativeCount?String(nativeCount.textContent||'').trim():'';
  var visible=!!text && !(nativeCount&&nativeCount.style&&nativeCount.style.display==='none') && !(nativeCount&&nativeCount.hidden);
  if(count){txt(count,text);if(count.hidden===visible)count.hidden=!visible}

  var sourceStar=q('[data-node="g-community"] [data-star="notifications"]',tree);
  var quickStar=q('[data-polish-notification-star]',existing);
  if(sourceStar&&quickStar){
    txt(quickStar,sourceStar.textContent||'☆');
    quickStar.setAttribute('aria-label',(sourceStar.textContent==='★'?'Remove Notifications from favourites':'Favourite Notifications'));
  }

  var quick=q('[data-id="notifications-quick"]',existing);
  if(quick){
    var isActive=source.classList.contains('active');
    quick.classList.toggle('active',isActive);
    if(isActive)quick.setAttribute('aria-current','page');else quick.removeAttribute('aria-current');
  }
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
    var prefs=accountLeaf('communication-preferences','Communication Preferences','●');
    var securityNode=q('[data-node="login-security"]',children);
    if(securityNode&&securityNode.nextSibling)children.insertBefore(prefs,securityNode.nextSibling);else children.appendChild(prefs);
    q('[data-account-shortcut="communication-preferences"]',prefs).addEventListener('click',function(){openAccountShortcut('communication-preferences','Communication Preferences','#notifPrefsContent')});
  }
  if(accountShortcut){
    var active=q('[data-account-shortcut="'+accountShortcut+'"]',children);
    if(active){active.classList.add('active');active.setAttribute('aria-current','page')}
  }
}

function patchNavigationA11y(){
  qa('#ccMemberNav .cc-member-branch').forEach(function(branch){
    var toggle=q(':scope > .cc-member-branch-head > .cc-member-toggle',branch);
    var children=q(':scope > .cc-member-children',branch);
    if(!toggle||!children)return;
    if(!children.id)children.id='cc-member-children-'+Math.random().toString(36).slice(2,9);
    toggle.setAttribute('aria-controls',children.id);
    toggle.setAttribute('aria-expanded',branch.classList.contains('open')?'true':'false');
    if(!toggle.dataset.ccA11yBound){
      toggle.dataset.ccA11yBound='true';
      toggle.addEventListener('click',function(){setTimeout(function(){toggle.setAttribute('aria-expanded',branch.classList.contains('open')?'true':'false')},0)});
    }
  });

  qa('#ccMemberNav .cc-member-nav-action').forEach(function(button){
    if(button.classList.contains('active'))button.setAttribute('aria-current','page');
    else button.removeAttribute('aria-current');
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
  var cards=q('#ccHomeCards');
  if(!cards)return;
  var host=q('#ccHomeProfileChecklist');
  if(!host){
    host=document.createElement('div');
    host.id='ccHomeProfileChecklist';
    host.className='cc-home-profile-checklist';
    cards.insertAdjacentElement('afterend',host);
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
  var cards=q('#ccHomeCards');
  if(!cards)return;
  var host=q('#ccHomeGrowthBridge');
  if(!host){
    host=document.createElement('div');
    host.id='ccHomeGrowthBridge';
    host.className='cc-home-growth-bridge';
    var checklist=q('#ccHomeProfileChecklist');
    (checklist||cards).insertAdjacentElement('afterend',host);
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
  if(wantSecurity&&!security)addSearchShortcut(results,'login-security','Login & Security','Account & Privacy');
  else if(!wantSecurity&&security)security.remove();
  if(wantPrefs&&!prefs)addSearchShortcut(results,'communication-preferences','Communication Preferences','Account & Privacy');
  else if(!wantPrefs&&prefs)prefs.remove();
  if(wantSecurity||wantPrefs)results.hidden=false;
}

function patchSearch(){
  var search=q('#ccMemberSearch');
  var results=q('#ccMemberSearchResults');
  if(!search||search.dataset.ccA11yBound)return;
  search.dataset.ccA11yBound='true';
  search.setAttribute('aria-label','Find something in My Unplug');
  search.setAttribute('aria-controls','ccMemberSearchResults');
  if(results){results.setAttribute('role','region');results.setAttribute('aria-label','Dashboard search results')}
  search.addEventListener('input',function(){setTimeout(augmentSearch,0)});
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
  if(card){
    card.setAttribute('role','dialog');
    card.setAttribute('aria-modal','true');
    if(title){if(!title.id)title.id='ccMemberQuickCreateTitle';card.setAttribute('aria-labelledby',title.id)}
  }
  if(close){close.setAttribute('aria-label','Close quick create');setTimeout(function(){try{close.focus()}catch(_){}},0)}
  function esc(ev){if(ev.key==='Escape'){document.removeEventListener('keydown',esc,true);if(modal.isConnected)modal.remove()}}
  document.addEventListener('keydown',esc,true);
}

function apply(){
  scheduled=0;
  if(!q('#ccMemberNav'))return;
  syncTopNotification();
  syncAccountShortcuts();
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
