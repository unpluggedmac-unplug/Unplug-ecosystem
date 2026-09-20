(function(){
'use strict';
if(window.__unplugMemberControlCentreLoader)return;
if(!/unplug-member-dashboard/i.test(location.pathname))return;
window.__unplugMemberControlCentreLoader=true;

function css(href,attr){
  if(document.querySelector('link['+attr+']'))return;
  var link=document.createElement('link');
  link.rel='stylesheet';
  link.href=href;
  link.setAttribute(attr,'true');
  (document.head||document.documentElement).appendChild(link);
}

function script(src,attr,next){
  var existing=document.querySelector('script['+attr+']');
  if(existing){
    if(next)next();
    return;
  }
  var el=document.createElement('script');
  el.src=src;
  el.async=false;
  el.setAttribute(attr,'true');
  if(next){
    var done=false;
    var finish=function(){if(done)return;done=true;next()};
    el.addEventListener('load',finish,{once:true});
    el.addEventListener('error',finish,{once:true});
  }
  (document.head||document.documentElement).appendChild(el);
}

css('/media/styles/member-dashboard-control-centre.css?v=20260920-2','data-member-control-centre-css');
css('/media/styles/member-dashboard-control-centre-help.css?v=20260920-2','data-member-control-centre-help-css');

script('/media/scripts/member-dashboard-control-centre.js?v=20260920-2','data-unplug-member-control-centre',function(){
  script('/media/scripts/member-dashboard-control-centre-polish.js?v=20260920-2','data-unplug-member-control-centre-polish',function(){
    script('/media/scripts/member-dashboard-service-shortcuts.js?v=20260920-2','data-unplug-member-service-shortcuts');
  });
});
})();
