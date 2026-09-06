// Daily Shout-Out v2 — staging-only public enhancement.
// Rebuilds the existing homepage block with real responsive HTML/CSS while
// preserving the existing nomination modal/button behaviour.
(function installDailyShoutoutV2(){
  'use strict';
  if (window.UnplugDailyShoutoutV2) return;

  function apiBase(){
    try {
      if (window.UnplugAPI && typeof window.UnplugAPI.getApiBase === 'function') {
        return String(window.UnplugAPI.getApiBase() || '').replace(/\/+$/, '');
      }
    } catch (_) {}
    return String(window.UNPLUG_RUNTIME_API || '').replace(/\/+$/, '');
  }

  function escapeHtml(value){
    const d=document.createElement('div');d.textContent=value==null?'':String(value);return d.innerHTML;
  }

  function formatDate(value){
    try { return new Intl.DateTimeFormat('en-ZA',{day:'2-digit',month:'short',year:'numeric'}).format(new Date(String(value)+'T12:00:00')); }
    catch (_) { return String(value||''); }
  }

  function track(slug,eventType){
    const base=apiBase();
    if(!base||!slug||!eventType)return;
    try{fetch(base+'/shoutouts/'+encodeURIComponent(slug)+'/event',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({eventType:eventType}),keepalive:true}).catch(function(){});}catch(_){}
  }

  async function blobFile(url,name){
    const res=await fetch(url,{mode:'cors'});
    if(!res.ok)throw new Error('Image download failed.');
    const blob=await res.blob();
    return new File([blob],name,{type:blob.type||'image/png'});
  }

  async function download(url,filename,status){
    if(!url){status.textContent='The social image is still being prepared.';return false;}
    try{
      const res=await fetch(url,{mode:'cors'});
      if(!res.ok)throw new Error('download failed');
      const blob=await res.blob();
      const objectUrl=URL.createObjectURL(blob);
      const a=document.createElement('a');a.href=objectUrl;a.download=filename;document.body.appendChild(a);a.click();a.remove();
      setTimeout(function(){URL.revokeObjectURL(objectUrl);},1500);
      return true;
    }catch(_){
      // Cross-origin object stores can omit CORS even though the file is public.
      // Opening the immutable asset is a safe fallback rather than pretending
      // the browser successfully downloaded it.
      window.open(url,'_blank','noopener');
      status.textContent='The image opened in a new tab — save it from there.';
      return true;
    }
  }

  async function nativeShare(s,status){
    track(s.shareSlug,'shoutout_share_open');
    if(!navigator.share){status.textContent='Native sharing is not available in this browser.';return false;}
    let files=[];
    if(s.imagePortraitUrl && navigator.canShare){
      try{
        const file=await blobFile(s.imagePortraitUrl,'unplug-shoutout-'+s.shareSlug+'.png');
        if(navigator.canShare({files:[file]}))files=[file];
      }catch(_){}
    }
    try{
      const payload={title:'POWER ON! — '+s.recipientName,text:s.shareCaption,url:s.shareUrl};
      if(files.length)payload.files=files;
      await navigator.share(payload);
      status.textContent=files.length?'Shared with the shout-out image.':'Shared the shout-out link.';
      return true;
    }catch(err){
      if(err && err.name!=='AbortError')status.textContent='Sharing could not be completed.';
      return false;
    }
  }

  function actionButton(label,aria,handler,extraClass){
    const btn=document.createElement('button');
    btn.type='button';btn.className='unplug-ds-action'+(extraClass?' '+extraClass:'');btn.textContent=label;btn.setAttribute('aria-label',aria);
    btn.addEventListener('click',handler);return btn;
  }

  function openShare(url,slug,eventType){
    track(slug,eventType);
    window.open(url,'_blank','noopener,noreferrer,width=720,height=720');
  }

  function buildActions(container,s){
    const status=document.createElement('p');status.className='unplug-ds-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    const title=document.createElement('div');title.className='unplug-ds-actions-title';title.textContent='SHARE THIS SHOUT-OUT';
    const grid=document.createElement('div');grid.className='unplug-ds-share-grid';

    const encodedUrl=encodeURIComponent(s.shareUrl);
    const encodedCaption=encodeURIComponent(s.shareCaption);
    const ready=Boolean(s.assetsReady);

    grid.appendChild(actionButton('Share','Share this shout-out using your device',function(){nativeShare(s,status);},'primary'));
    grid.appendChild(actionButton('Facebook','Share this shout-out on Facebook',function(){openShare('https://www.facebook.com/sharer/sharer.php?u='+encodedUrl,s.shareSlug,'shoutout_share_facebook');}));
    grid.appendChild(actionButton('WhatsApp','Share this shout-out on WhatsApp',function(){openShare('https://wa.me/?text='+encodeURIComponent(s.shareCaption+' '+s.shareUrl),s.shareSlug,'shoutout_share_whatsapp');}));
    grid.appendChild(actionButton('LinkedIn','Share this shout-out on LinkedIn',function(){openShare('https://www.linkedin.com/sharing/share-offsite/?url='+encodedUrl,s.shareSlug,'shoutout_share_linkedin');}));
    grid.appendChild(actionButton('X','Share this shout-out on X',function(){openShare('https://twitter.com/intent/tweet?text='+encodedCaption+'&url='+encodedUrl,s.shareSlug,'shoutout_share_x');}));
    grid.appendChild(actionButton('Instagram','Share this shout-out on Instagram',async function(){
      if(navigator.share && ready){
        const shared=await nativeShare(s,status);
        if(shared){track(s.shareSlug,'shoutout_share_instagram_native');return;}
      }
      const ok=await download(s.imagePortraitUrl,'unplug-shoutout-'+s.shareSlug+'.png',status);
      if(ok)status.textContent='Portrait artwork ready — open Instagram and upload the saved image.';
    }));
    grid.appendChild(actionButton('Copy Link','Copy the permanent link for this shout-out',async function(){
      try{await navigator.clipboard.writeText(s.shareUrl);status.textContent='Link copied.';track(s.shareSlug,'shoutout_copy_link');}
      catch(_){status.textContent='Copy failed — select the address from your browser instead.';}
    }));
    const dl=actionButton('Download','Download the 1080 × 1350 shout-out artwork',async function(){
      const ok=await download(s.imagePortraitUrl,'unplug-shoutout-'+s.shareSlug+'-1080x1350.png',status);
      if(ok){status.textContent='1080 × 1350 shout-out downloaded.';track(s.shareSlug,'shoutout_download_portrait');}
    },'primary');
    if(!ready){dl.disabled=true;dl.title='Artwork is still being prepared';}
    grid.appendChild(dl);

    container.appendChild(title);container.appendChild(grid);container.appendChild(status);
    if(!ready){
      const note=document.createElement('div');note.className='unplug-ds-unavailable';note.textContent='The shout-out is live, but its downloadable social artwork is still being prepared. Refresh shortly to enable image sharing.';container.insertBefore(note,grid);
    }
  }

  function rebuild(root,s,mascotSrc,nominateBtn){
    root.id='daily-shout-out';root.classList.add('unplug-ds-v2');
    const dateText=formatDate(s.featureDate||s.date);
    root.innerHTML=`
      <div class="unplug-ds-shell">
        <div class="unplug-ds-grid">
          <section class="unplug-ds-editorial" aria-labelledby="unplugDailyTitle">
            <div class="unplug-ds-kicker">Daily Shout-Out</div>
            <h2 id="unplugDailyTitle">REAL PEOPLE.<br><em>REAL IMPACT.</em></h2>
            <p class="unplug-ds-editorial-copy">One person. One spark. One daily reminder that purpose deserves to be seen, celebrated and shared.</p>
            <div class="unplug-ds-mascot-stage" id="unplugDsMascotStage"></div>
          </section>
          <section class="unplug-ds-post-column" aria-label="Today’s Unplug Magazine Daily Shout-Out">
            <div class="unplug-ds-post-frame">
              <article class="unplug-ds-post">
                <header class="unplug-ds-post-head"><span class="unplug-ds-post-brand">THE GUY SAYS</span><span class="unplug-ds-post-date">${escapeHtml(dateText)}</span></header>
                <div class="unplug-ds-post-body">
                  <span class="unplug-ds-power">POWER ON!</span>
                  <h3 class="unplug-ds-recipient" id="shoutoutName">${escapeHtml(s.recipientName)}</h3>
                  <p class="unplug-ds-message">${escapeHtml(s.message)}</p>
                </div>
                <footer class="unplug-ds-post-foot">
                  <p class="unplug-ds-brand-line">${escapeHtml(s.brandLine)}</p>
                  <p class="unplug-ds-return-line">${escapeHtml(s.returnLine)}</p>
                  <span class="unplug-ds-site">${escapeHtml(s.website||'www.unplugnews.com')}</span>
                </footer>
              </article>
            </div>
            <div class="unplug-ds-actions" id="shoutoutShare"></div>
            <div class="unplug-ds-nominate" id="unplugDsNominate"><div class="unplug-ds-nominate-copy"><strong>Who should get the next POWER ON?</strong><span>Nominate someone whose purpose deserves a spark.</span></div></div>
          </section>
        </div>
      </div>`;

    const mascotStage=document.getElementById('unplugDsMascotStage');
    if(mascotSrc){
      const img=document.createElement('img');img.src=mascotSrc;img.alt='The Guy — Unplug Magazine mascot';img.loading='eager';mascotStage.appendChild(img);
    }else{
      const fallback=document.createElement('div');fallback.className='unplug-ds-mascot-fallback';fallback.setAttribute('aria-label','The Guy mascot');fallback.textContent='⚡';mascotStage.appendChild(fallback);
    }

    const actions=document.getElementById('shoutoutShare');buildActions(actions,s);
    if(nominateBtn){
      nominateBtn.classList.add('shoutout-nominate-btn');
      nominateBtn.textContent='Nominate the next shout-out →';
      document.getElementById('unplugDsNominate').appendChild(nominateBtn);
      nominateBtn.addEventListener('click',function(){track(s.shareSlug,'shoutout_nominate_click');});
    }
    track(s.shareSlug,'shoutout_view');
  }

  async function init(){
    const root=document.querySelector('.shoutout-banner');
    if(!root||root.classList.contains('unplug-ds-v2'))return;
    const mascot=root.querySelector('.shoutout-mascot img');
    const mascotSrc=mascot&&mascot.getAttribute('src');
    const nominateBtn=document.getElementById('shoutoutNominateBtn');
    const base=apiBase();
    if(!base)return;
    try{
      const res=await fetch(base+'/shoutouts/today',{headers:{Accept:'application/json'}});
      if(!res.ok)throw new Error('Could not load today’s shout-out.');
      const data=await res.json();
      if(!data||!data.shoutout){const section=root.closest('.home-section');if(section)section.style.display='none';return;}
      rebuild(root,data.shoutout,mascotSrc,nominateBtn);
    }catch(err){
      console.error('[Daily Shout-Out v2]',err);
      // Leave the existing production block intact rather than replacing a
      // working shout-out with an error panel if staging API is asleep.
    }
  }

  if(document.readyState==='complete')setTimeout(init,0);
  else window.addEventListener('load',function(){setTimeout(init,0);},{once:true});
  window.UnplugDailyShoutoutV2={refresh:init};
})();
