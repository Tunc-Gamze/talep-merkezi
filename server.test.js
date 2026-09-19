const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'talep-auth-test-'));
process.env.TALEP_DATA_DIR=dir;
process.env.TALEP_INITIAL_ADMIN_PASSWORD='AdminTest123!';
const {server,db}=require('./server');

test('SQLite API: authentication, yetki, kullanıcı yönetimi ve müşteri akışı',async()=>{
 await new Promise(resolve=>server.listen(0,resolve));
 const base='http://127.0.0.1:'+server.address().port;
 const call=async(method,url,data,cookie='')=>{
  const response=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:data===undefined?undefined:JSON.stringify(data)});
  const setCookie=response.headers.get('set-cookie');
  return {status:response.status,data:await response.json(),cookie:setCookie?setCookie.split(';')[0]:''};
 };
 try{
  assert.equal((await call('GET','/api/health')).status,200);
  assert.equal((await fetch(base+'/data/talep-merkezi.db')).status,404);
  assert.equal((await call('GET','/api/requests')).status,401);
  assert.equal((await call('GET','/api/team')).status,401);
  assert.equal((await call('GET','/api/admin/team-members')).status,401);
  assert.equal((await call('POST','/api/auth/login',{username:'admin',password:'yanlis-parola'})).status,401);

  const adminLogin=await call('POST','/api/auth/login',{username:'admin',password:'AdminTest123!'});
  assert.equal(adminLogin.status,200);
  assert.equal(adminLogin.data.user.role,'admin');
  assert.match(adminLogin.cookie,/^talep_session=/);
  const adminCookie=adminLogin.cookie;
  assert.equal((await call('GET','/api/auth/me',undefined,adminCookie)).data.user.username,'admin');
  assert.equal((await call('GET','/api/admin/team-members',undefined,adminCookie)).status,200);
  assert.equal((await fetch(base+'/personel')).status,200);
  const adminId=adminLogin.data.user.id;
  assert.equal((await call('PATCH','/api/admin/team-members/'+adminId,{active:false},adminCookie)).status,409);
  assert.equal((await call('PATCH','/api/admin/team-members/'+adminId,{role:'destek'},adminCookie)).status,409);
  assert.equal((await call('POST','/api/admin/team-members',{name:'Kısa Parola',username:'kisa',role:'destek',password:'Abc1234'},adminCookie)).status,422);

  const added=await call('POST','/api/admin/team-members',{name:'Ali Destek',username:'ali.destek',role:'destek',password:'Abcd1234'},adminCookie);
  assert.equal(added.status,201);
  const memberId=added.data.member.id;
  let listed=await call('GET','/api/admin/team-members',undefined,adminCookie);
  assert.ok(listed.data.members.some(member=>member.id===memberId));

  const supportLogin=await call('POST','/api/auth/login',{username:'ali.destek',password:'Abcd1234'});
  assert.equal(supportLogin.status,200);
  assert.equal(supportLogin.data.user.role,'destek');
  const supportCookie=supportLogin.cookie;
  assert.equal((await call('GET','/api/admin/team-members',undefined,supportCookie)).status,403);
  assert.equal((await call('GET','/api/team',undefined,supportCookie)).status,200);

  const second=await call('POST','/api/admin/team-members',{name:'Gamze Destek',username:'gamze.destek',role:'destek',password:'Abcd5678'},adminCookie);
  assert.equal(second.status,201);
  const secondId=second.data.member.id;
  const secondLogin=await call('POST','/api/auth/login',{username:'gamze.destek',password:'Abcd5678'});
  assert.equal(secondLogin.status,200);
  const secondCookie=secondLogin.cookie;

  const created=await call('POST','/api/requests',{phone:'05321112233',name:'Ayşe',company:'ABC',category:'printer',option_value:"80'lik",priority:'Normal',description:'Kurulum',anydesk_code:'123456789'});
  assert.equal(created.status,201);
  const {request_number:number,public_token:token}=created.data;
  assert.match(number,/^TK-\d{4}-000001$/);
  assert.equal((await call('GET','/api/customer/requests?phone=05321112233')).data.requests.length,1);
  assert.equal((await call('GET','/api/public/requests/'+number+'?token='+token)).status,200);
  const teamList=(await call('GET','/api/requests',undefined,supportCookie)).data.requests;
  assert.equal(teamList.length,1);
  assert.equal(teamList[0].description,undefined);
  assert.equal(teamList[0].public_token,undefined);
  assert.equal((await call('GET','/api/requests/'+number+'/revision')).status,401);
  const initialRevision=(await call('GET','/api/requests/'+number+'/revision',undefined,supportCookie)).data.revision;

  assert.equal((await call('PATCH','/api/requests/'+number,{action:'take',actor:'Sahte Kullanıcı',assigned_user_id:adminId},supportCookie)).status,200);
  assert.notEqual((await call('GET','/api/requests/'+number+'/revision',undefined,secondCookie)).data.revision,initialRevision);
  let teamDetail=await call('GET','/api/requests/'+number,undefined,supportCookie);
  assert.equal(teamDetail.data.request.assigned_user_id,memberId);
  assert.equal(teamDetail.data.request.assigned_to,'Ali Destek');
  assert.ok(teamDetail.data.request.events.some(event=>event.actor_name==='Ali Destek'&&event.event_type==='assigned'));
  assert.ok(teamDetail.data.request.events.some(event=>event.actor_user_id===memberId&&event.event_type==='assigned'));
  assert.ok(!teamDetail.data.request.events.some(event=>event.actor_name==='Sahte Kullanıcı'));
  assert.equal((await call('PATCH','/api/requests/'+number,{action:'status',status:'İşleme Alındı'},supportCookie)).status,200);
  const beforeRemoteMessage=(await call('GET','/api/requests/'+number+'/revision',undefined,supportCookie)).data.revision;
  assert.equal((await call('PATCH','/api/requests/'+number,{action:'message',message:'Hazır',internal:false,actor:'Ali Destek'},secondCookie)).status,200);
  assert.notEqual((await call('GET','/api/requests/'+number+'/revision',undefined,supportCookie)).data.revision,beforeRemoteMessage);
  assert.equal((await call('PATCH','/api/requests/'+number,{action:'message',message:'İç not',internal:true,actor_user_id:memberId},secondCookie)).status,200);
  assert.equal((await call('PATCH','/api/requests/'+number,{action:'status',status:'Müşteriden Bilgi Bekleniyor'},secondCookie)).status,200);
  teamDetail=await call('GET','/api/requests/'+number,undefined,secondCookie);
  assert.equal(teamDetail.data.request.assigned_user_id,memberId);
  assert.equal(teamDetail.data.request.assigned_to,'Ali Destek');
  assert.ok(teamDetail.data.request.events.some(event=>event.actor_user_id===secondId&&event.actor_name==='Gamze Destek'&&event.event_type==='message'));
  assert.ok(teamDetail.data.request.events.some(event=>event.actor_user_id===secondId&&event.actor_name==='Gamze Destek'&&event.event_type==='note'));
  assert.ok(teamDetail.data.request.events.some(event=>event.actor_user_id===secondId&&event.actor_name==='Gamze Destek'&&event.event_type==='status'));
  assert.equal((await call('POST','/api/public/requests/'+number,{token,message:'Teşekkürler'})).status,201);

  const edited=await call('PATCH','/api/admin/team-members/'+memberId,{name:'Ali Destek Güncel',username:'ali.destek',role:'destek'},adminCookie);
  assert.equal(edited.status,200);
  const passive=await call('PATCH','/api/admin/team-members/'+memberId,{active:false},adminCookie);
  assert.equal(passive.status,200);
  assert.equal(passive.data.member.active,0);
  listed=await call('GET','/api/admin/team-members',undefined,adminCookie);
  assert.equal(listed.data.members.find(member=>member.id===memberId).active,0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM team_members WHERE id=?').get(memberId).count,1);
  teamDetail=await call('GET','/api/requests/'+number,undefined,secondCookie);
  assert.equal(teamDetail.data.request.assigned_user_id,memberId);
  assert.equal(teamDetail.data.request.assigned_to,'Ali Destek Güncel');
  assert.ok(teamDetail.data.request.events.some(event=>event.actor_user_id===memberId&&event.actor_name==='Ali Destek'&&event.event_type==='assigned'));
  assert.equal((await call('POST','/api/auth/login',{username:'ali.destek',password:'Abcd1234'})).status,401);
  assert.equal((await call('GET','/api/requests',undefined,supportCookie)).status,401);

  const publicDetail=await call('GET','/api/public/requests/'+number+'?token='+token);
  assert.ok(publicDetail.data.request.events.some(event=>event.body.includes('Teşekkürler')));
  assert.equal(db.prepare('SELECT COUNT(*) count FROM requests').get().count,1);
  assert.equal((await call('POST','/api/auth/logout',{},adminCookie)).status,200);
  assert.equal((await call('GET','/api/auth/me',undefined,adminCookie)).status,401);
 }finally{
  await new Promise(resolve=>server.close(resolve));
  db.close();
  assert.equal(path.dirname(fs.realpathSync(dir)),fs.realpathSync(os.tmpdir()));
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
