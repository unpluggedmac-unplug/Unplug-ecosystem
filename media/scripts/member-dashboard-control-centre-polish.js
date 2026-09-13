(function(){
'use strict';
if(window.__unplugMemberCCPolish)return;
if(!/unplug-member-dashboard/i.test(location.pathname))return;
window.__unplugMemberCCPolish=true;

var observer=null;
var scheduled=0;

function q(sel,root){return (root||document).querySelector(sel)}
function qa(sel,root){return Array.prototype.slice.call((root||document).querySelectorAll(sel))}

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
  if(count){count.textContent=text;count.hidden=!visible}

  var sourceStar=q('[data-node="g-community"] [data-star="notifications"]',tree);
  var quickStar=q('[data-polish-notification-star]',existing);
  if(sourceStar&&quickStar){
    quickStar.textContent=sourceStar.textContent||'☆';
    quickStar.setAttribute('aria-label',(sourceStar.textContent==='★'?'Remove Notifications from favourites':'Favourite Notifications'));
  }

  var quick=q('[data-id="notifications-quick"]',existing);
  if(quick){
    var isActive=source.classList.contains('active');
    quick.classList.toggle('active',isActive);
    if(isActive)quick.setAttribute('aria-current','page');else quick.removeAttribute('aria-current');
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

function patchSearch(){
  var search=q('#ccMemberSearch');
  var results=q('#ccMemberSearchResults');
  if(!search||search.dataset.ccA11yBound)return;
  search.dataset.ccA11yBound='true';
  search.setAttribute('aria-label','Find something in My Unplug');
  search.setAttribute('aria-controls','ccMemberSearchResults');
  if(results){results.setAttribute('role','region');results.setAttribute('aria-label','Dashboard search results')}
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
  patchNavigationA11y();
  patchHomeA11y();
  patchSearch();
  patchModal();
}

function schedule(){
  if(scheduled)return;
  scheduled=setTimeout(apply,30);
}

function init(){
  apply();
  observer=new MutationObserver(schedule);
  observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['class','hidden','style']});
  document.addEventListener('click',schedule,true);
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
