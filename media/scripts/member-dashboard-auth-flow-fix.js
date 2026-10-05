(function(){
'use strict';
if(window.__unplugMemberAuthFlowFix)return;
window.__unplugMemberAuthFlowFix=true;

function byId(id){return document.getElementById(id)}
function cleanEmailInput(el){
  if(!el)return;
  el.value=String(el.value||'').trim().toLowerCase();
}
function apiBase(){
  var fromField=byId('forgotApiBaseInput')||byId('apiBaseInput')||byId('registerApiBaseInput');
  var value=(fromField&&fromField.value)||window.UNPLUG_RUNTIME_API||'';
  if(!value){try{value=localStorage.getItem('unplug_api_base')||''}catch(_){} }
  return String(value||'https://unplug-ecosystem.onrender.com').replace(/\/$/,'');
}
function showError(el,msg){if(!el)return;el.textContent=msg;el.classList.add('show')}
function hideError(el){if(!el)return;el.textContent='';el.classList.remove('show')}
function showOnlyCard(id){
  document.querySelectorAll('.wrap > .card').forEach(function(card){card.classList.add('section-hidden')});
  var target=byId(id);if(target)target.classList.remove('section-hidden');
}
function navigateCard(id){
  if(typeof window.showCard==='function')window.showCard(id);else showOnlyCard(id);
}
function addPasswordToggle(inputId){
  var input=byId(inputId);if(!input||input.parentElement.classList.contains('pw-wrap'))return;
  var wrap=document.createElement('div');wrap.className='pw-wrap';
  input.parentNode.insertBefore(wrap,input);wrap.appendChild(input);
  var button=document.createElement('button');
  button.type='button';button.className='pw-toggle';button.setAttribute('data-target',inputId);button.setAttribute('aria-label','Show password');button.textContent='👁';
  wrap.appendChild(button);
}
function bindEnter(ids,buttonId){
  ids.forEach(function(id){var el=byId(id);if(!el)return;el.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();var b=byId(buttonId);if(b&&!b.disabled)b.click()}})})
}

var loginEmail=byId('loginEmail');
if(loginEmail){
  loginEmail.type='text';
  loginEmail.autocomplete='username';
  loginEmail.placeholder='Email address or cell number';
  var label=document.querySelector('label[for="loginEmail"]');
  if(label)label.textContent='Email or Cell Number';
}
var loginPassword=byId('loginPassword');
if(loginPassword)loginPassword.autocomplete='current-password';
addPasswordToggle('loginPassword');
addPasswordToggle('resetNewPassword');

['registerEmail','forgotEmail'].forEach(function(id){
  var el=byId(id);if(!el)return;
  el.autocomplete='email';
  el.autocapitalize='none';
  el.spellcheck=false;
  el.addEventListener('blur',function(){cleanEmailInput(el)});
});

var verifyCode=byId('verifyCode');
if(verifyCode){
  verifyCode.maxLength=6;verifyCode.inputMode='numeric';verifyCode.autocomplete='one-time-code';verifyCode.pattern='[0-9]{6}';
  verifyCode.addEventListener('input',function(){verifyCode.value=verifyCode.value.replace(/\D/g,'').slice(0,6)});
}
var resetCode=byId('resetToken');
if(resetCode){
  resetCode.maxLength=6;resetCode.inputMode='numeric';resetCode.autocomplete='one-time-code';resetCode.pattern='[0-9]{6}';resetCode.placeholder='000000';
  var resetLabel=document.querySelector('label[for="resetToken"]');if(resetLabel)resetLabel.textContent='6-Digit Reset Code';
  resetCode.addEventListener('input',function(){resetCode.value=resetCode.value.replace(/\D/g,'').slice(0,6)});
}

['registerBtn','requestResetBtn','magicLinkBtn'].forEach(function(id){
  var btn=byId(id);if(!btn)return;
  btn.addEventListener('click',function(){cleanEmailInput(byId(id==='registerBtn'?'registerEmail':id==='requestResetBtn'?'forgotEmail':'loginEmail'))},true);
});

// Keep the existing login flow, but remove developer-only wording from errors.
var loginError=byId('loginError');
if(loginError&&window.MutationObserver){
  new MutationObserver(function(){
    var suffix=' (Is the API running at that URL?)';
    if(loginError.textContent.indexOf(suffix)!==-1)loginError.textContent=loginError.textContent.replace(suffix,'');
  }).observe(loginError,{childList:true,characterData:true,subtree:true});
}

// If somebody registered before but never verified, the backend now sends a
// fresh code instead of creating a duplicate. The old inline registration
// handler sees the 409; this observer converts that known recovery response
// into the verification step automatically.
var registerError=byId('registerError');
if(registerError&&window.MutationObserver){
  var recovering=false;
  new MutationObserver(function(){
    if(recovering)return;
    var message=String(registerError.textContent||'');
    if(message.indexOf('still needs email verification')===-1)return;
    recovering=true;
    var email=String((byId('registerEmail')||{}).value||'').trim().toLowerCase();
    try{PENDING_VERIFY_EMAIL=email}catch(_){}
    var verifySub=byId('verifySub');
    if(verifySub)verifySub.textContent='We sent a fresh 6-digit code to '+email+'. Enter it below to activate your account.';
    hideError(registerError);
    setTimeout(function(){navigateCard('verifyCard');recovering=false},0);
  }).observe(registerError,{childList:true,characterData:true,subtree:true});
}

// Replace only the reset submission step so a 6-digit code is paired with the
// email address that requested it. The old inline handler is stopped before it
// can submit a code without its email identifier.
var submitResetBtn=byId('submitResetBtn');
if(submitResetBtn){
  submitResetBtn.addEventListener('click',async function(e){
    e.preventDefault();e.stopImmediatePropagation();
    var err=byId('forgotError');hideError(err);
    var email=String((byId('forgotEmail')||{}).value||'').trim().toLowerCase();
    var code=String((byId('resetToken')||{}).value||'').replace(/\D/g,'').slice(0,6);
    var password=String((byId('resetNewPassword')||{}).value||'');
    if(!email)return showError(err,'Enter the email address you used to request the reset code.');
    if(!/^\d{6}$/.test(code))return showError(err,'Enter the 6-digit reset code from your email.');
    if(password.length<8)return showError(err,'New password must be at least 8 characters.');
    submitResetBtn.disabled=true;submitResetBtn.textContent='Updating...';
    try{
      var response=await fetch(apiBase()+'/auth/reset-password',{
        method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},
        body:JSON.stringify({email:email,code:code,newPassword:password})
      });
      var body={};try{body=await response.json()}catch(_){body={}}
      if(!response.ok)throw new Error(body.error||'We could not reset your password. Please request a new code and try again.');
      var login=byId('loginEmail');if(login)login.value=email;
      var loginPw=byId('loginPassword');if(loginPw)loginPw.value='';
      var step=byId('resetStep2');if(step)step.classList.add('section-hidden');
      var sub=byId('forgotSub');if(sub)sub.textContent='Password updated successfully. You can sign in with your new password.';
      if(typeof window.showToast==='function')window.showToast('Password updated — sign in with your new password.');
      navigateCard('loginCard');
    }catch(ex){showError(err,ex.message)}
    finally{submitResetBtn.disabled=false;submitResetBtn.textContent='Set New Password'}
  },true);
}

bindEnter(['loginEmail','loginPassword'],'loginBtn');
bindEnter(['registerName','registerEmail','registerPhone','registerPassword','registerPassword2'],'registerBtn');
bindEnter(['verifyCode'],'verifyBtn');
bindEnter(['forgotEmail'],'requestResetBtn');
bindEnter(['resetToken','resetNewPassword'],'submitResetBtn');

var loginCard=byId('loginCard');
if(loginCard&&!byId('authCreateAccountShortcut')){
  var create=document.createElement('button');create.type='button';create.id='authCreateAccountShortcut';create.className='btn btn-line';create.style.marginTop='10px';create.textContent='Create a Free Account';
  create.addEventListener('click',function(){navigateCard('typeCard')});
  loginCard.appendChild(create);
}
var registerCard=byId('registerCard');
if(registerCard&&!byId('authSignInShortcut')){
  var signin=document.createElement('button');signin.type='button';signin.id='authSignInShortcut';signin.className='btn btn-line';signin.style.marginTop='10px';signin.textContent='Already a Member? Sign In';
  signin.addEventListener('click',function(){navigateCard('loginCard')});
  registerCard.appendChild(signin);
}
})();
