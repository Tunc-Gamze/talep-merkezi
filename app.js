const $=s=>document.querySelector(s);
const categories={
 integration:{title:'Entegrasyon',subtitle:'Bağlantı ve entegrasyon desteği',options:['Adisyon','TAM','Bilmiyorum'],asksDesk:true,desc:'Talebinizi veya yaşadığınız sorunu buraya yazabilirsiniz.'},
 printer:{title:'Yazıcı Kurulumu',subtitle:'Yazıcı bağlantı desteği',options:["80'lik","58'lik",'Bilmiyorum'],asksDesk:true,desc:'Kurulum ihtiyacınızı kısaca yazabilirsiniz.'},
 credit:{title:'Kontör Yükleme',subtitle:'Öncelikli ödeme talebi',options:["IBAN'a ödeme",'Karttan ödeme'],urgent:true,desc:'Varsa ek açıklamanızı yazabilirsiniz.'},
 caller:{title:'Caller ID Kurulumu',subtitle:'Arayan numara tanımlama',options:['Android','Sabit Hat','Bilmiyorum'],asksDesk:true,desc:'Talebinizi veya yaşadığınız sorunu buraya yazabilirsiniz.'},
 feature:{title:'Özellik Ekleme Talebi',subtitle:'Yeni özellik önerisi',asksDesk:true,desc:'Eklenmesini istediğiniz özelliği mümkün olduğunca detaylı açıklayabilirsiniz.'},
 other:{title:'Diğer',subtitle:'Başka bir konuda destek',asksDesk:true,desc:'Talebinizi buraya yazabilirsiniz.'}
};
const statuses=['Yeni Talep','Teslim Alındı','İşleme Alındı','Müşteriden Bilgi Bekleniyor','Tamamlandı','İptal Edildi'];
const transitions={'Yeni Talep':['Teslim Alındı'],'Teslim Alındı':['İşleme Alındı'],'İşleme Alındı':['Müşteriden Bilgi Bekleniyor','Tamamlandı'],'Müşteriden Bilgi Bekleniyor':['Tamamlandı','İptal Edildi'],'Tamamlandı':[],'İptal Edildi':[]};
const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const phoneDigits=v=>{let d=String(v||'').replace(/\D/g,'').slice(0,15);while(d.length>12&&d.startsWith('9'))d=d.slice(1);return d};
const phoneKey=v=>{let d=phoneDigits(v);return d.startsWith('0')?'90'+d.slice(1):d.startsWith('5')?'90'+d:d};
const formatDate=v=>v?new Date(String(v).replace(' ','T')+'Z').toLocaleString('tr-TR',{dateStyle:'short',timeStyle:'short'}):'—';
const dateKey=v=>String(v||'').slice(0,10);
const eventText=value=>String(value||'').replace(' talebi üstlendi.',' talebi devir aldı.');
let view='customer',selected='',form={},customerPhone='',currentToken='',rows=[],adminMembers=[],currentUser=null,lookupId=0,lookedUpPhone='',submitting=false,detailRequestId=0,detailController=null,handlingHistory=false,detailSyncTimer=null,detailSyncNumber='',detailRevision='',detailSyncBusy=false;
async function api(url,options={}){const response=await fetch(url,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});let data=await response.json();if(!response.ok){let exception=Error(data.error||'İşlem başarısız.');exception.status=response.status;throw exception}return data}
function error(e){alert(e.message||'Bağlantı hatası. Lütfen tekrar deneyin.')}
function stopDetailSync(){if(detailSyncTimer)clearTimeout(detailSyncTimer);detailSyncTimer=null;detailSyncNumber='';detailRevision='';detailSyncBusy=false}
function scheduleDetailSync(number,delay=4000){if(detailSyncTimer)clearTimeout(detailSyncTimer);detailSyncNumber=number;if(document.visibilityState!=='visible')return;detailSyncTimer=setTimeout(()=>pollDetail(number),delay)}
async function pollDetail(number){
 detailSyncTimer=null;if(document.visibilityState!=='visible'||view!==number||detailSyncNumber!==number||detailSyncBusy)return;
 detailSyncBusy=true;
 try{
  const {revision}=await api('/api/requests/'+encodeURIComponent(number)+'/revision');
  if(revision!==detailRevision){const customerDraft=$('#customerMsg')?.value||'',noteDraft=$('#internalNote')?.value||'';await detail(number,{history:false,sync:true});if($('#customerMsg'))$('#customerMsg').value=customerDraft;if($('#internalNote'))$('#internalNote').value=noteDraft}
 }catch(e){if(e.status===401){currentUser=null;go('login',{replace:true})}}
 finally{detailSyncBusy=false;if(view===number&&detailSyncNumber===number)scheduleDetailSync(number)}
}
const historyScreenPath=screen=>['login','team','team-detail','admin'].includes(screen)?'/personel':'/';
function setHistory(screen,data={},replace=false){
 if(handlingHistory)return;
 const state={talepApp:true,screen,...data};
 if(JSON.stringify(history.state)===JSON.stringify(state))return;
 history[replace?'replaceState':'pushState'](state,'',historyScreenPath(screen));
}
function abortDetail(){stopDetailSync();if(detailController){detailController.abort();detailController=null;detailRequestId++}}
async function showHistoryState(state){
 if(!state?.talepApp){const screen=currentUser?'team':location.pathname==='/personel'?'login':'customer';setHistory(screen,{},true);state=history.state}
 const protectedScreen=['team','team-detail','admin'].includes(state.screen);
 if(protectedScreen&&!currentUser){go('login',{replace:true});return}
 handlingHistory=true;abortDetail();
 try{
  if(state.screen==='customer-tickets')return await customerTickets(state.phone,state.start||'',state.end||'',{history:false});
  if(state.screen==='customer-ticket'){customerPhone=state.phone||customerPhone;return await customerTicket(state.number,state.token,{history:false})}
  if(state.screen==='team-detail')return await detail(state.number,{history:false});
  if(state.screen==='team')return await team({history:false});
  if(state.screen==='admin')return await admin({history:false});
  view=state.screen==='login'?'login':'customer';selected='';form={};return render();
 }finally{handlingHistory=false}
}
function layout(body){
 const nav=currentUser?`<button class="${view==='team'?'active':''}" onclick="go('team')">Ekip Paneli</button>${currentUser.role==='admin'?`<button class="${view==='admin'?'active':''}" onclick="go('admin')">Admin</button>`:''}<button onclick="logout()">Çıkış</button>`:`${view==='login'?'<button onclick="go(\'customer\')">Müşteri ekranı</button>':''}`;
 $('#app').innerHTML=`<div class="shell"><header class="top"><div class="brand"><i>✓</i>Talep Merkezi</div><div class="tabs">${nav}</div></header><main class="main">${body}</main></div>`;refreshPendingActions()
}function go(to,options={}){abortDetail();if((to==='team'||to==='admin')&&!currentUser)to='login';if(to==='admin'&&currentUser?.role!=='admin')to='team';setHistory(to,{},!!options.replace);view=to;selected='';form={};render()}
async function render(){if(view==='login')return login();if(view==='customer')return customer();if(view==='team')return team();if(view==='admin')return admin();if(view==='customer-tickets')return customerTickets(customerPhone);if(view==='customer-ticket')return customerTicket(form.currentNumber,currentToken);return detail(view)}
function login(){layout(`<section class="hero"><span class="eyebrow">PERSONEL</span><h1>Personel girişi</h1><p>Ekip ve admin işlemleri için hesabınızla giriş yapın.</p></section><section class="panel login-panel"><div class="field"><label>Kullanıcı adı</label><input id="loginUsername" maxlength="50" autocomplete="username" autocapitalize="none"></div><div class="field"><label>Parola</label><input id="loginPassword" type="password" autocomplete="current-password" onkeydown="if(event.key==='Enter')loginSubmit()"></div><div class="actions"><button class="primary" onclick="loginSubmit()">Giriş yap</button></div></section>`)}
async function loginSubmit(){let username=$('#loginUsername').value.trim(),password=$('#loginPassword').value;try{let data=await api('/api/auth/login',{method:'POST',body:JSON.stringify({username,password})});currentUser=data.user;go('team',{replace:true})}catch(e){error(e)}}
async function logout(){try{await api('/api/auth/logout',{method:'POST',body:'{}'})}catch{}currentUser=null;go('customer',{replace:true})}
async function boot(){try{currentUser=(await api('/api/auth/me')).user}catch{currentUser=null}if(!history.state?.talepApp){view=currentUser?'team':location.pathname==='/personel'?'login':'customer';setHistory(view,{},true);return render()}return showHistoryState(history.state)}function customer(){
 if(!selected){layout(`<section class="hero hero-glow"><span class="eyebrow">HIZLI DESTEK</span><h1>Nasıl yardımcı olabiliriz?</h1><p>Telefonunuzu yazın; kayıtlıysanız bilgileriniz otomatik gelir. Ardından konunuzu seçin.</p></section><section class="panel elevated"><div class="field"><label>Telefon numaranız</label><input id="phone" inputmode="numeric" maxlength="15" oninput="phoneChanged(this)" value="${escape(form.phone||new URLSearchParams(location.search).get('phone')||customerPhone)}" placeholder="05XX XXX XX XX"><div class="hint" id="customerHint">Telefon numarası sadece rakamlardan oluşur.</div></div><div class="split-actions"><button class="text-action" onclick="trackByPhone()">Mevcut taleplerimi görüntüle →</button></div><div class="label">Talep türünü seçin</div><div class="categories">${Object.entries(categories).map(([k,v])=>`<button class="choice" onclick="choose('${k}')"><strong>${v.title}</strong><small>${v.subtitle}</small><span>→</span></button>`).join('')}</div></section>`);phoneChanged($('#phone'));return}
 let c=categories[selected],priority=c.urgent?'Acil':form.priority||'Normal';
 layout(`<section class="hero"><span class="eyebrow">YENİ TALEP</span><h1>${c.title}</h1><p>Yalnızca gerekli bilgileri isteyeceğiz.</p></section><section class="panel elevated"><button class="secondary" onclick="selected='';render()">← Talep türünü değiştir</button>${c.urgent?'<div class="notice">Kontör talepleri otomatik olarak <b>Acil</b> önceliğindedir.</div>':''}<div class="field"><label>Telefon numaranız</label><input id="phone" inputmode="numeric" maxlength="15" oninput="phoneChanged(this)" value="${escape(form.phone||customerPhone)}" placeholder="05XX XXX XX XX"><div class="hint" id="customerHint"></div></div><div class="grid"><div class="field"><label>Adınız soyadınız</label><input id="name" maxlength="80" value="${escape(form.name)}" placeholder="Örn. Ayşe Yılmaz"></div><div class="field"><label>Firma adı <span class="hint">(opsiyonel)</span></label><input id="company" maxlength="120" value="${escape(form.company)}" placeholder="Örn. ABC Market"></div></div>${!c.urgent?`<div class="field"><label>Öncelik</label><div class="seg"><button class="${priority==='Normal'?'selected':''}" onclick="setPriority('Normal')">Normal</button><button class="${priority==='Acil'?'selected':''}" onclick="setPriority('Acil')">Acil</button></div></div>`:''}${c.options?`<div class="field"><label>${selected==='credit'?'Ödeme yöntemi':'Seçiminiz'} <span class="hint">(opsiyonel)</span></label><div class="seg">${c.options.map((x,i)=>`<button class="${form.option===x?'selected':''}" onclick="setOption(${i})">${escape(x)}</button>`).join('')}</div></div>`:''}${selected==='credit'?creditFields():''}<div class="field"><label>Açıklama <span class="hint">(opsiyonel)</span></label><textarea id="description" maxlength="1500" oninput="grow(this)" placeholder="${escape(c.desc)}">${escape(form.description)}</textarea></div>${c.asksDesk?`<div class="field"><label>AnyDesk kodu <span class="hint">(opsiyonel · 9–10 hane)</span></label><input id="desk" inputmode="numeric" maxlength="10" oninput="this.value=this.value.replace(/\\D/g,'').slice(0,10)" value="${escape(form.desk)}" placeholder="AnyDesk kodu"></div>`:''}${selected==='credit'&&form.option==="IBAN'a ödeme"?'<div class="field"><label>Dekont <span class="hint">(dosya yükleme henüz desteklenmiyor)</span></label></div>':''}<div class="actions"><button class="secondary" onclick="selected='';render()">Vazgeç</button><button class="primary" onclick="preview()">Önizle ve gönder →</button></div></section>`);phoneChanged($('#phone'))
}
function creditFields(){return `<div class="grid"><div class="field"><label>Tutar (TL)</label><input id="tl" type="number" min="0" step="0.01" ${form.credit?'disabled':''} value="${escape(form.tl)}" oninput="updateCredit('tl',this.value)" placeholder="Örn. 500"></div><div class="field"><label>Kontör miktarı</label><input id="credit" type="number" min="1" step="1" ${form.tl?'disabled':''} value="${escape(form.credit)}" oninput="updateCredit('credit',this.value)" placeholder="Örn. 100"></div></div><div class="hint">TL veya Kontör alanlarından yalnızca birini doldurun.</div>`}
async function phoneChanged(el){if(!el)return;el.value=phoneDigits(el.value);form.phone=el.value;if(lookedUpPhone&&lookedUpPhone!==phoneKey(el.value)){form.name='';form.company='';lookedUpPhone='';let name=document.querySelector('#name'),company=document.querySelector('#company');if(name)name.value='';if(company)company.value=''}let id=++lookupId,hint=$('#customerHint');if(phoneKey(el.value).length!==12){if(hint)hint.textContent='Telefon numarası sadece rakamlardan oluşur.';return}if(lookedUpPhone===phoneKey(el.value))return;if(hint)hint.innerHTML=loadingMarkup();try{let {customer}=await api('/api/customers/lookup?phone='+encodeURIComponent(el.value));if(id!==lookupId||!$('#phone')||$('#phone').value!==el.value)return;lookedUpPhone=phoneKey(el.value);if(customer){form.name=customer.name;form.company=customer.company;if($('#name'))$('#name').value=customer.name;if($('#company'))$('#company').value=customer.company;if(hint)hint.innerHTML=customer.name?`<b>✓ ${escape(customer.name)}</b> için kayıt bulundu; bilgiler otomatik dolduruldu.`:'Kayıt bulundu; adınız boş. Lütfen adınızı girin.'}else if(hint)hint.textContent='Bu numara için kayıt bulunamadı; bilgileri aşağıdan girebilirsiniz.'}catch(e){if(id===lookupId&&hint)hint.textContent='Müşteri bilgileri yüklenemedi.'}}
function choose(k){saveFields();selected=k;render()}
function setOption(i){saveFields();form.option=categories[selected].options[i];render()}
function setPriority(x){saveFields();form.priority=x;render()}
function updateCredit(field,value){form[field]=value;let other=field==='tl'?'credit':'tl';if(value){form[other]='';$('#'+other).value='';$('#'+other).disabled=true}else $('#'+other).disabled=false}
function grow(el){el.style.height='auto';el.style.height=el.scrollHeight+'px'}
function saveFields(){for(let k of ['phone','name','company','description','desk','tl','credit']){let el=$('#'+k);if(el)form[k]=el.value.trim()}if(form.name)form.name=form.name.replace(/[0-9]/g,'').slice(0,80)}
function preview(){saveFields();if(phoneKey(form.phone).length!==12)return alert('Lütfen geçerli bir telefon numarası girin.');if(!form.name)return alert('Lütfen adınızı soyadınızı girin.');if(form.desk&&![9,10].includes(form.desk.length))return alert('AnyDesk kodu 9 veya 10 hane olmalı.');if(selected==='credit'&&(!form.tl&&!form.credit||!!form.tl&&!!form.credit))return alert('Kontör talebi için TL veya Kontör miktarı girin.');let c=categories[selected];layout(`<section class="hero"><span class="eyebrow">KONTROL</span><h1>Talep özeti</h1><p>Bilgileri kontrol edip talebinizi gönderin.</p></section><section class="panel elevated">${[['Talep türü',c.title],['Öncelik',c.urgent?'Acil':form.priority||'Normal'],['Telefon',form.phone],['Müşteri',form.name],['Seçim',form.option],['Tutar',form.tl?form.tl+' TL':''],['Kontör',form.credit],['AnyDesk',form.desk],['Açıklama',form.description]].filter(x=>x[1]).map(x=>`<div class="kv"><b>${x[0]}</b><span>${escape(x[1])}</span></div>`).join('')}<div class="actions"><button class="secondary" onclick="render()">Düzenle</button><button class="primary" id="submit" onclick="submitRequest()">Talebi gönder</button></div></section>`)}
async function submitRequest(){if(submitting)return;submitting=true;if($('#submit'))$('#submit').disabled=true;try{let result=await api('/api/requests',{method:'POST',body:JSON.stringify({phone:form.phone,name:form.name,company:form.company,category:selected,option_value:form.option,priority:form.priority,description:form.description,anydesk_code:form.desk,amount_tl:form.tl,credit_amount:form.credit})});customerPhone=phoneKey(form.phone);currentToken=result.public_token;form.currentNumber=result.request_number;layout(`<section class="hero"><span class="eyebrow">BAŞARILI</span><h1>Talebiniz alındı ✓</h1><p>Ekibimiz en kısa sürede inceleyecek.</p></section><section class="panel elevated"><div class="notice success"><b>Talep numaranız: ${escape(result.request_number)}</b><br>Bu numarayı takip için saklayın.</div><div class="actions"><button class="secondary" onclick="go('customer')">← Ana sayfa</button><button class="primary" onclick="customerTicket('${escape(result.request_number)}','${escape(result.public_token)}')">Talebimi görüntüle</button></div></section>`)}catch(e){error(e)}finally{submitting=false;if($('#submit'))$('#submit').disabled=false}}
function trackByPhone(){let p=phoneKey($('#phone')?.value);if(p.length!==12)return alert('Önce telefon numaranızı girin.');customerTickets(p)}
async function customerTickets(phone,start='',end='',options={}){customerPhone=phone;if(options.history!==false)setHistory('customer-tickets',{phone,start,end},!!options.replace);view='customer-tickets';try{let data=await api('/api/customer/requests?phone='+encodeURIComponent(phone));let items=data.requests.filter(r=>(!start||dateKey(r.created_at)>=start)&&(!end||dateKey(r.created_at)<=end));layout(`<section class="detail customer-detail"><div class="headrow"><div><button class="secondary" onclick="go('customer')">← Ana sayfa</button><h1 style="margin-top:14px">Mevcut taleplerim</h1><p>Tüm açık ve geçmiş destek talepleriniz burada listelenir.</p></div></div><div class="card"><div class="filters customer-date-filters"><label class="date-filter"><span>Başlangıç</span><input id="customerStart" type="date" value="${start}"></label><label class="date-filter"><span>Bitiş</span><input id="customerEnd" type="date" value="${end}"></label><button class="secondary" onclick="filterCustomerTickets()">Tarihe göre filtrele</button><button class="text-action" onclick="customerTickets(customerPhone,'','',{replace:true})">Temizle</button></div>${items.length?`<table class="table"><thead><tr><th>Talep No</th><th>Tür</th><th>Durum</th><th>Öncelik</th><th>Tarih</th></tr></thead><tbody>${items.map(r=>`<tr onclick="customerTicket('${escape(r.request_number)}','${escape(r.public_token)}')"><td><b>${escape(r.request_number)}</b></td><td>${categories[r.category]?.title||escape(r.category)}</td><td><span class="badge ${r.status==='Tamamlandı'?'done':''}">${escape(r.status)}</span></td><td><span class="badge ${r.priority==='Acil'?'acil':''}">${escape(r.priority)}</span></td><td>${formatDate(r.created_at)}</td></tr>`).join('')}</tbody></table>`:'<div class="empty">Seçtiğiniz tarih aralığında talep bulunamadı.</div>'}</div></section>`)}catch(e){error(e)}}
function filterCustomerTickets(){customerTickets(customerPhone,$('#customerStart').value,$('#customerEnd').value,{replace:true})}
function returnToCustomerTickets(){if(history.state?.talepApp&&history.state.screen==='customer-ticket'&&history.state.from==='customer-tickets')history.back();else customerTickets(customerPhone,'','',{replace:true})}
async function customerTicket(number,token,options={}){const from=view==='customer-tickets'?'customer-tickets':view;if(options.history!==false)setHistory('customer-ticket',{number,token,phone:customerPhone,from},!!options.replace);view='customer-ticket';currentToken=token;form.currentNumber=number;try{let data=await api('/api/public/requests/'+encodeURIComponent(number)+'?token='+encodeURIComponent(token)),r=data.request;r.events=Array.isArray(r.events)?r.events:Array.isArray(data.events)?data.events:[];layout(`<section class="detail customer-detail"><div class="headrow"><div><button class="secondary" onclick="returnToCustomerTickets()">← Taleplerime dön</button><h1 style="margin-top:14px">Talebiniz takipte</h1><p>${escape(r.request_number)} · ${categories[r.category]?.title||escape(r.category)}</p></div><span class="badge ${r.status==='Tamamlandı'?'done':''}">${escape(r.status)}</span></div><div class="detail-grid"><section><div class="card"><h3>Güncellemeler</h3><div class="timeline">${r.events.map(e=>`<div class="event"><time>${formatDate(e.created_at)}</time>${escape(eventText(e.body))}</div>`).join('')}</div></div><div class="card"><h3>Ekibe mesaj gönder</h3><p class="hint">Yanıtınız talep geçmişine eklenir ve ekip tarafından görülür.</p><textarea id="reply" maxlength="1500" oninput="grow(this)" placeholder="Eklemek istediğiniz bilgiyi yazın..."></textarea><div class="actions"><button class="primary" onclick="customerReply()">Mesajı gönder</button></div></div></section><aside><div class="card"><h3>Talep özeti</h3><div class="kv"><b>Öncelik</b><span>${escape(r.priority)}</span></div><div class="kv"><b>Atanan personel</b><span>${escape(r.assigned_to||'Henüz atanmadı')}</span></div><div class="kv"><b>Son güncelleme</b><span>${formatDate(r.events.at(-1)?.created_at)}</span></div><div class="kv"><b>Açıklama</b><span>${escape(r.description||'—')}</span></div></div></aside></div></section>`)}catch(e){error(e)}}
async function customerReply(){let msg=$('#reply')?.value.trim();if(!msg)return;try{await api('/api/public/requests/'+encodeURIComponent(form.currentNumber),{method:'POST',body:JSON.stringify({token:currentToken,message:msg})});await customerTicket(form.currentNumber,currentToken,{history:false,loading:false})}catch(e){error(e)}}
async function team(options={}){
 if(!currentUser)return go('login');if(options.history!==false)setHistory('team',{},!!options.replace);view='team';
 try{let list=await api('/api/requests');rows=list.requests;let open=rows.filter(r=>!['Tamamlandı','İptal Edildi'].includes(r.status));layout(`<div class="headrow"><div><h1>Ekip paneli</h1><p>Açık talepleri takip edin ve yönetin.</p></div><div><div class="current-user">Giriş yapan: <b>${escape(currentUser.name)}</b> · ${currentUser.role==='admin'?'Admin':'Destek'}</div><div class="online" id="network"></div></div></div><div class="stats">${[['Yeni',rows.filter(r=>r.status==='Yeni Talep').length],['Açık talep',open.length],['İşlemde',rows.filter(r=>r.status==='İşleme Alındı').length],['Acil',rows.filter(r=>r.priority==='Acil').length],['Tamamlanan',rows.filter(r=>r.status==='Tamamlandı').length]].map(x=>`<div class="stat"><b>${x[1]}</b><span>${x[0]}</span></div>`).join('')}</div><div class="filters"><input id="search" maxlength="100" oninput="filterRows()" placeholder="No, müşteri veya telefon ara"><select id="status" onchange="filterRows()"><option value="">Tüm durumlar</option>${statuses.map(x=>`<option>${x}</option>`).join('')}</select><select id="priority" onchange="filterRows()"><option value="">Tüm öncelikler</option><option>Normal</option><option>Acil</option></select></div><div class="card" style="padding:0;overflow:auto"><table class="table"><thead><tr><th>Talep No</th><th>Müşteri</th><th>Tür</th><th>Öncelik</th><th>Durum</th><th>Atanan</th></tr></thead><tbody id="rows">${tableRows(rows)}</tbody></table></div>`);network()}catch(e){if(e.status===401){currentUser=null;go('login')}else error(e)}
}function tableRows(items){return items.length?items.map(r=>`<tr onclick="detail('${escape(r.request_number)}')"><td><b>${escape(r.request_number)}</b><br><small>${escape(r.company)}</small></td><td>${escape(r.customer)}<br><small>${escape(r.phone)}</small></td><td>${categories[r.category]?.title||escape(r.category)}</td><td><span class="badge ${r.priority==='Acil'?'acil':''}">${escape(r.priority)}</span></td><td><span class="badge ${r.status==='Tamamlandı'?'done':r.status.includes('Bekleniyor')?'wait':''}">${escape(r.status)}</span></td><td>${escape(r.assigned_to||'Henüz atanmadı')}</td></tr>`).join(''):'<tr><td colspan="6" class="empty">Bu filtreye uyan talep yok.</td></tr>'}
function returnToTeam(){if(history.state?.talepApp&&history.state.screen==='team-detail')history.back();else go('team',{replace:true})}
function filterRows(){let s=$('#search').value.toLocaleLowerCase('tr'),st=$('#status').value,p=$('#priority').value;$('#rows').innerHTML=tableRows(rows.filter(r=>(!s||[r.request_number,r.customer,r.company,r.phone].join(' ').toLocaleLowerCase('tr').includes(s))&&(!st||r.status===st)&&(!p||r.priority===p)))}
async function detail(number,options={}){if(options.history!==false)setHistory('team-detail',{number,from:'team'},!!options.replace);if(detailController)detailController.abort();const requestId=++detailRequestId,controller=new AbortController();detailController=controller;view=number;try{let {request:r}=await api('/api/requests/'+encodeURIComponent(number),{signal:controller.signal});if(requestId!==detailRequestId||view!==number)return;detailController=null;detailRevision=r.revision||'';let choices=[r.status,...(transitions[r.status]||[])];layout(`<div class="detail"><div class="headrow"><div><button class="secondary" onclick="returnToTeam()">← Taleplere dön</button><h1 style="margin-top:14px">${escape(r.request_number)}</h1><p>${categories[r.category]?.title||escape(r.category)} · ${formatDate(r.created_at)}</p></div><div class="actions">${!r.assigned_to&&!['Tamamlandı','İptal Edildi'].includes(r.status)?`<button class="primary" onclick="take('${escape(number)}')">Talebi Devir Al</button>`:''}</div></div><div class="detail-grid"><section><div class="card"><h3>Talep bilgileri</h3><div class="kv"><b>Tür</b><span>${categories[r.category]?.title||escape(r.category)}</span></div><div class="kv"><b>Seçim</b><span>${escape(r.option_value||'Belirtilmedi')}</span></div><div class="kv"><b>Öncelik</b><span class="badge ${r.priority==='Acil'?'acil':''}">${escape(r.priority)}</span></div><div class="kv"><b>Durum</b><select ${!r.assigned_to||choices.length===1?'disabled':''} onchange="setStatus('${escape(number)}',this.value)">${choices.map(x=>`<option ${r.status===x?'selected':''}>${x}</option>`).join('')}</select></div>${!r.assigned_to?'<p class="hint">Durumu değiştirmek için önce talebi devir alın.</p>':''}${r.anydesk_code?`<div class="kv"><b>AnyDesk</b><span>${escape(r.anydesk_code)}</span></div>`:''}${r.amount_tl?`<div class="kv"><b>Tutar</b><span>${escape(r.amount_tl)} TL</span></div>`:''}${r.credit_amount?`<div class="kv"><b>Kontör</b><span>${escape(r.credit_amount)}</span></div>`:''}<div class="field"><label>Açıklama</label><div>${escape(r.description||'Açıklama girilmedi.')}</div></div></div><div class="card"><h3>Aktivite geçmişi</h3><div class="timeline">${r.events.map(e=>`<div class="event ${e.visibility==='team'?'internal-event':''}"><time>${formatDate(e.created_at)}</time>${escape(eventText(e.body))}</div>`).join('')}</div></div><div class="card"><h3>Müşteriye mesaj gönder</h3><textarea id="customerMsg" maxlength="1500" placeholder="Müşterinin görebileceği güncelleme..."></textarea><div class="actions"><button class="primary" onclick="message('${escape(number)}',false)">Mesaj gönder</button></div></div><div class="card"><h3>Ekip içi not</h3><textarea id="internalNote" maxlength="1500" placeholder="Yalnızca ekip üyelerinin göreceği not..."></textarea><div class="actions"><button class="secondary" onclick="message('${escape(number)}',true)">Not ekle</button></div></div></section><aside><div class="card"><h3>Müşteri</h3><div class="kv"><b>Ad</b><span>${escape(r.customer)}</span></div><div class="kv"><b>Firma</b><span>${escape(r.company)}</span></div><div class="kv"><b>Telefon</b><span>${escape(r.phone)}</span></div></div><div class="card"><h3>Operasyon</h3><div class="kv"><b>Atanan personel</b><span>${escape(r.assigned_to||'Henüz atanmadı')}</span></div><div class="kv"><b>Oluşturulma</b><span>${formatDate(r.created_at)}</span></div><div class="kv"><b>Son işlem</b><span>${formatDate(r.events.at(-1)?.created_at)}</span></div></div></aside></div></div>`);scheduleDetailSync(number)}catch(e){if(e.name!=='AbortError'&&requestId===detailRequestId&&!options.sync)error(e)}finally{if(requestId===detailRequestId)detailController=null}}
async function mutate(number,b){try{await api('/api/requests/'+encodeURIComponent(number),{method:'PATCH',body:JSON.stringify(b)});await detail(number,{history:false,loading:false})}catch(e){error(e);await detail(number,{history:false,loading:false})}}
function take(number){return mutate(number,{action:'take'})}
function setStatus(number,status){return mutate(number,{action:'status',status})}
function message(number,internal){let value=$(internal?'#internalNote':'#customerMsg')?.value.trim();if(value)return mutate(number,{action:'message',message:value,internal})}
async function admin(options={}){if(currentUser?.role!=='admin')return go(currentUser?'team':'login');if(options.history!==false)setHistory('admin',{},!!options.replace);view='admin';try{let data=await api('/api/admin/team-members');adminMembers=data.members;renderAdmin()}catch(e){if(e.status===401){currentUser=null;go('login')}else if(e.status===403)go('team');else error(e)}}
function renderAdmin(editId=null){
 const editing=editId===null?null:adminMembers.find(member=>member.id===editId);
 layout(`<div class="detail admin-page"><div class="headrow"><div><h1>Ekip yönetimi</h1><p>Admin ve destek kullanıcılarını yönetin.</p></div></div><div class="admin-grid"><section class="card"><h3>${editing?'Ekip üyesini düzenle':'Yeni ekip üyesi'}</h3><div class="field"><label>Ad</label><input id="memberName" maxlength="80" value="${escape(editing?.name||'')}" placeholder="Ad soyad"></div><div class="field"><label>Kullanıcı adı</label><input id="memberUsername" maxlength="50" value="${escape(editing?.username||'')}" placeholder="ornek.kullanici" autocapitalize="none"></div><div class="field"><label>Rol</label><select id="memberRole"><option value="destek" ${editing?.role==='destek'?'selected':''}>Destek</option><option value="admin" ${editing?.role==='admin'?'selected':''}>Admin</option></select></div><div class="field"><label>${editing?'Yeni parola':'Başlangıç parolası'} <span class="hint">${editing?'(değişmeyecekse boş bırakın)':'(en az 8 karakter)'}</span></label><input id="memberPassword" type="password" minlength="8" autocomplete="new-password"></div><div class="actions">${editing?'<button class="secondary" onclick="renderAdmin()">Vazgeç</button>':''}<button class="primary" onclick="saveMember(${editing?.id||'null'})">${editing?'Kaydet':'Ekip üyesi ekle'}</button></div></section><section><div class="card admin-list-card"><h3>Ekip üyeleri</h3>${adminMembers.length?`<div class="member-list">${adminMembers.map(member=>`<article class="member-row ${member.active?'':'inactive'}"><div><strong>${escape(member.name)}</strong><small>@${escape(member.username)} · ${member.role==='admin'?'Admin':'Destek'} · ${formatDate(member.created_at)}</small></div><span class="badge ${member.active?'done':''}">${member.active?'Aktif':'Pasif'}</span><div class="member-actions"><button class="secondary" onclick="renderAdmin(${member.id})">Düzenle</button>${member.id===currentUser.id?'<span class="hint">Mevcut oturum</span>':`<button class="${member.active?'secondary':'primary'}" onclick="toggleMember(${member.id},${member.active?0:1})">${member.active?'Pasife al':'Aktif et'}</button>`}</div></article>`).join('')}</div>`:'<div class="empty">Henüz ekip üyesi yok.</div>'}</div></section></div></div>`)
}
async function saveMember(id){
 const name=$('#memberName').value.trim(),username=$('#memberUsername').value.trim().toLocaleLowerCase('tr-TR'),role=$('#memberRole').value,password=$('#memberPassword').value;
 if((id===null||password)&&(password.length<8||password.length>200))return alert('Parola 8-200 karakter olmalı.');
 try{await api(id===null?'/api/admin/team-members':'/api/admin/team-members/'+id,{method:id===null?'POST':'PATCH',body:JSON.stringify({name,username,role,password})});await admin({loading:false})}catch(e){error(e)}
}
async function toggleMember(id,active){
 const member=adminMembers.find(item=>item.id===id);if(!member)return;
 try{await api('/api/admin/team-members/'+id,{method:'PATCH',body:JSON.stringify({name:member.name,username:member.username,role:member.role,active:!!active})});await admin({loading:false})}catch(e){error(e)}
}
function network(){let el=$('#network');if(el){el.textContent=navigator.onLine?'● Bağlantı var':'● İnternet bağlantısı yok';el.className=navigator.onLine?'online':'offline'}}
window.addEventListener('online',network);window.addEventListener('offline',network);window.addEventListener('popstate',event=>showHistoryState(event.state));
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&detailSyncNumber&&view===detailSyncNumber)scheduleDetailSync(detailSyncNumber,0);else if(detailSyncTimer){clearTimeout(detailSyncTimer);detailSyncTimer=null}});
window.addEventListener('focus',()=>{if(detailSyncNumber&&view===detailSyncNumber)scheduleDetailSync(detailSyncNumber,0)});
if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js');
// Loading state belongs to the UI; API and background synchronization stay unchanged.
const pendingActions=new Map();
const pendingControls=new WeakMap();
function loadingMarkup(){return '<span class="loading-status" role="status"><span class="loading-spinner" aria-hidden="true"></span>Yükleniyor...</span>'}
function refreshPendingActions(){
 document.querySelectorAll('button[onclick],select[onchange]').forEach(control=>{
  const handler=control.getAttribute('onclick')||control.getAttribute('onchange')||'';
  const name=handler.match(/^([a-zA-Z]+)\(/)?.[1];
  const label=name==='message'&&pendingActions.has(name)&&handler.includes(',true)')?'Ekleniyor...':pendingActions.get(name);
  if(label&&!pendingControls.has(control)){
   pendingControls.set(control,{html:control.innerHTML,disabled:control.disabled});
   control.disabled=true;control.setAttribute('aria-busy','true');
   if(control.tagName==='BUTTON')control.innerHTML='<span class="pending-label"><span class="pending-original" aria-hidden="true">'+control.innerHTML+'</span><span class="pending-text">'+label+'</span></span>';
  }else if(!label&&pendingControls.has(control)){
   const previous=pendingControls.get(control);control.innerHTML=previous.html;control.disabled=previous.disabled;control.removeAttribute('aria-busy');pendingControls.delete(control);
  }
 });
}
function withPendingAction(name,label,action){
 return async function(...args){
  if(pendingActions.has(name))return;
  pendingActions.set(name,label);refreshPendingActions();
  try{return await action(...args)}finally{pendingActions.delete(name);refreshPendingActions()}
 };
}
function withScreenLoading(load,optionIndex){
 return async function(...args){
  if(args[optionIndex]?.sync||args[optionIndex]?.loading===false)return load(...args);
  if(!$('.main'))layout('');
  const main=$('.main'),previous=document.createDocumentFragment();
  while(main.firstChild)previous.append(main.firstChild);
  main.innerHTML=loadingMarkup();main.setAttribute('aria-busy','true');
  try{return await load(...args)}finally{
   // Successful rendering replaces main. On failure restore the usable previous screen.
   if(main.isConnected){main.replaceChildren(previous);main.removeAttribute('aria-busy');refreshPendingActions()}
  }
 };
}
customerTickets=withScreenLoading(customerTickets,3);
customerTicket=withScreenLoading(customerTicket,2);
team=withScreenLoading(team,0);
detail=withScreenLoading(detail,1);
admin=withScreenLoading(admin,0);
boot=withScreenLoading(boot,0);
loginSubmit=withPendingAction('loginSubmit','Giriş yapılıyor...',loginSubmit);
logout=withPendingAction('logout','Çıkılıyor...',logout);
submitRequest=withPendingAction('submitRequest','Gönderiliyor...',submitRequest);
customerReply=withPendingAction('customerReply','Gönderiliyor...',customerReply);
take=withPendingAction('take','İşleniyor...',take);
setStatus=withPendingAction('setStatus','İşleniyor...',setStatus);
message=withPendingAction('message','Gönderiliyor...',message);
saveMember=withPendingAction('saveMember','Kaydediliyor...',saveMember);
toggleMember=withPendingAction('toggleMember','İşleniyor...',toggleMember);
boot();













