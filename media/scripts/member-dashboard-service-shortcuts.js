(function(){
'use strict';
if(window.__unplugMemberServiceShortcuts)return;
if(!/unplug-member-dashboard/i.test(location.pathname))return;
window.__unplugMemberServiceShortcuts=true;

var KEY_FAV='unplug_member_cc_service_favourites_v1';
var KEY_RECENT='unplug_member_cc_service_recent_v1';
var scheduled=0;
var observer=null;

function q(sel,root){return (root||document).querySelector(sel)}
function qa(sel,root){return Array.prototype.slice.call((root||document).querySelectorAll(sel))}
function get(key,fallback){try{var raw=localStorage.getItem(key);return raw?JSON.parse(raw):fallback}catch(_){return fallback}}
function put(key,value){try{localStorage.setItem(key,JSON.stringify(value))}catch(_){}}
function cleanLabel(value){return String(value||'').replace(/\s+/g,' ').trim().slice(0,90)}
function escapeHtml(value){return String(value==null?'':value).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}

function loadCss(){
  if(q('link[data-member-service-shortcuts-css]'))return;
  var link=document.createElement('link');
  link.rel='stylesheet';
  link.href='/media/styles/member-dashboard-service-shortcuts.css?v=20260913-1';
  link.setAttribute('data-member-service-shortcuts-css','true');
  (document.head||document.documentElement).appendChild(link);
}

function serviceCards(){
  return qa('#msServicesGrid .ms-service').map(function(card){
    var title=q('.t',card);
    return {label:cleanLabel(title?title.textContent:card.textContent),card:card};
  }).filter(function(item){return !!item.label});
}

function serviceNames(){
  var seen={};
  return serviceCards().map(function(item){return item.label}).filter(function(label){
    var key=label.toLowerCase();if(seen[key])return false;seen[key]=true;return true;
  });
}

function browseButton(){return q('#ccMemberNav [data-id="browse-services"]')}
function openBrowse(){var button=browseButton();if(button)button.click()}

function activateService(label){
  label=cleanLabel(label);if(!label)return;
  openBrowse();
  setTimeout(function(){
    var item=serviceCards().find(function(x){return x.label.toLowerCase()===label.toLowerCase()});
    if(item&&item.card)item.card.click();
  },140);
}

function recent(){return get(KEY_RECENT,[]).filter(function(x){return typeof x==='string'&&x.trim()}).slice(0,5)}
function favourites(){return get(KEY_FAV,[]).filter(function(x){return typeof x==='string'&&x.trim()}).slice(0,8)}
function recordRecent(label){
  label=cleanLabel(label);if(!label)return;
  var list=recent().filter(function(x){return x.toLowerCase()!==label.toLowerCase()});
  list.unshift(label);put(KEY_RECENT,list.slice(0,5));schedule();
}

function navLeaf(id,label,icon,count){
  var wrap=document.createElement('div');
  wrap.className='cc-member-node cc-member-leaf';
  wrap.style.setProperty('--cc-depth',1);
  wrap.dataset.node=id;
  wrap.innerHTML='<div class="cc-member-leaf-row"><button type="button" class="cc-member-nav-action" data-service-shortcut="'+id+'"><span class="cc-member-icon">'+icon+'</span><span class="cc-member-label">'+escapeHtml(label)+'</span>'+(count?'<span class="cc-member-count">'+count+'</span>':'')+'</button></div>';
  return wrap;
}

function closeModal(modal){
  if(!modal)return;
  if(modal.__ccEscapeHandler){
    document.removeEventListener('keydown',modal.__ccEscapeHandler,true);
    modal.__ccEscapeHandler=null;
  }
  if(modal.isConnected)modal.remove();
}
function modalShell(id,kicker,title,description){
  var old=q('#'+id);if(old)closeModal(old);
  var modal=document.createElement('div');
  modal.id=id;modal.className='cc-member-modal cc-service-modal';
  modal.innerHTML='<div class="cc-member-modal-card" role="dialog" aria-modal="true" aria-labelledby="'+id+'Title"><div class="cc-member-modal-head"><div><span>'+escapeHtml(kicker)+'</span><h2 id="'+id+'Title">'+escapeHtml(title)+'</h2></div><button type="button" data-close aria-label="Close">×</button></div><p>'+escapeHtml(description)+'</p><div class="cc-service-modal-body"></div></div>';
  document.body.appendChild(modal);
  var close=q('[data-close]',modal);close.addEventListener('click',function(){closeModal(modal)});
  modal.addEventListener('click',function(ev){if(ev.target===modal)closeModal(modal)});
  modal.__ccEscapeHandler=function(ev){if(ev.key==='Escape')closeModal(modal)};
  document.addEventListener('keydown',modal.__ccEscapeHandler,true);
  setTimeout(function(){try{close.focus()}catch(_){}},0);
  return modal;
}

function serviceButton(label){
  return '<button type="button" class="cc-service-modal-service" data-open-service="'+escapeHtml(label)+'"><strong>'+escapeHtml(label)+'</strong><span>Open service →</span></button>';
}

function bindOpenServices(root){
  qa('[data-open-service]',root).forEach(function(button){button.addEventListener('click',function(){var label=button.dataset.openService;closeModal(button.closest('.cc-service-modal'));activateService(label)})});
}

function ensureCatalog(callback){
  var names=serviceNames();
  if(names.length){callback(names);return}
  openBrowse();
  setTimeout(function(){callback(serviceNames())},180);
}

function showFavourites(){
  ensureCatalog(function(names){
    var fav=favourites().filter(function(label){return !names.length||names.some(function(x){return x.toLowerCase()===label.toLowerCase()})});
    var modal=modalShell('ccMemberServiceFavourites','SERVICES','Favourite Services','Keep the services you use most often close at hand.');
    var body=q('.cc-service-modal-body',modal);
    body.innerHTML=(fav.length?'<div class="cc-service-modal-list">'+fav.map(serviceButton).join('')+'</div>':'<div class="cc-service-modal-empty">No favourite services yet.</div>')+'<button type="button" class="cc-service-manage-btn" data-manage-favourites>Manage favourite services</button>';
    bindOpenServices(body);
    q('[data-manage-favourites]',body).addEventListener('click',function(){closeModal(modal);showFavouriteManager()});
  });
}

function showRecent(){
  var list=recent();
  var modal=modalShell('ccMemberServiceRecent','SERVICES','Recent Services','Your most recently opened Unplug services.');
  var body=q('.cc-service-modal-body',modal);
  body.innerHTML=list.length?'<div class="cc-service-modal-list">'+list.map(serviceButton).join('')+'</div><button type="button" class="cc-service-manage-btn" data-clear-recent>Clear recent services</button>':'<div class="cc-service-modal-empty">Open a service and it will appear here.</div><button type="button" class="cc-service-manage-btn" data-view-all>View all services</button>';
  bindOpenServices(body);
  var clear=q('[data-clear-recent]',body);if(clear)clear.addEventListener('click',function(){put(KEY_RECENT,[]);closeModal(modal);schedule()});
  var view=q('[data-view-all]',body);if(view)view.addEventListener('click',function(){closeModal(modal);openBrowse()});
}

function showFavouriteManager(){
  ensureCatalog(function(names){
    var selected=favourites();
    var modal=modalShell('ccMemberServiceFavouriteManager','SERVICES','Manage Favourite Services','Choose the services you want available from your Member Dashboard shortcuts.');
    var body=q('.cc-service-modal-body',modal);
    if(!names.length){body.innerHTML='<div class="cc-service-modal-empty">The service catalogue is not available right now.</div>';return}
    body.innerHTML='<div class="cc-service-check-list">'+names.map(function(label){var checked=selected.some(function(x){return x.toLowerCase()===label.toLowerCase()});return '<label class="cc-service-check"><input type="checkbox" value="'+escapeHtml(label)+'" '+(checked?'checked':'')+'><span><strong>'+escapeHtml(label)+'</strong><small>'+(checked?'Favourite':'Add to favourites')+'</small></span></label>'}).join('')+'</div><button type="button" class="cc-service-manage-btn cc-service-save" data-save-favourites>Save favourites</button>';
    q('[data-save-favourites]',body).addEventListener('click',function(){
      var values=qa('input[type="checkbox"]:checked',body).map(function(input){return cleanLabel(input.value)}).filter(Boolean).slice(0,8);
      put(KEY_FAV,values);closeModal(modal);schedule();
    });
  });
}

function syncNav(){
  var services=q('#ccMemberTree [data-node="g-services"]');
  var children=services&&q(':scope > .cc-member-children',services);
  if(!children)return;

  var viewAll=q('[data-id="browse-services"] .cc-member-label',children);
  if(viewAll&&viewAll.textContent!=='View All Services')viewAll.textContent='View All Services';

  var fav=favourites(),rec=recent();
  var signature=fav.join('|')+'::'+rec.join('|');
  var host=q('#ccMemberServiceShortcuts',children);
  if(host&&host.dataset.signature===signature)return;
  if(host)host.remove();
  host=document.createElement('div');
  host.id='ccMemberServiceShortcuts';
  host.dataset.signature=signature;
  host.className='cc-service-shortcut-nav';
  var favNode=navLeaf('service-favourites','Favourite Services','★',fav.length);
  var recentNode=navLeaf('service-recent','Recent Services','↻',rec.length);
  host.appendChild(favNode);host.appendChild(recentNode);
  var myServices=q('[data-node="my-services"]',children);
  if(myServices&&myServices.nextSibling)children.insertBefore(host,myServices.nextSibling);else children.appendChild(host);
  q('[data-service-shortcut="service-favourites"]',host).addEventListener('click',showFavourites);
  q('[data-service-shortcut="service-recent"]',host).addEventListener('click',showRecent);
}

function schedule(){if(scheduled)return;scheduled=setTimeout(function(){scheduled=0;syncNav()},45)}

function init(){
  loadCss();
  syncNav();
  document.addEventListener('click',function(ev){
    var card=ev.target&&ev.target.closest?ev.target.closest('#msServicesGrid .ms-service'):null;
    if(card){var title=q('.t',card);recordRecent(title?title.textContent:card.textContent)}
  },true);
  observer=new MutationObserver(schedule);
  observer.observe(document.body,{childList:true,subtree:true});
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
