const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const root=__dirname,data=process.env.TALEP_DATA_DIR||path.join(root,'data');fs.mkdirSync(data,{recursive:true});
const db=new DatabaseSync(path.join(data,'talep-merkezi.db'));
db.exec(`PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY,phone TEXT UNIQUE NOT NULL,name TEXT NOT NULL DEFAULT '',company TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS requests(id INTEGER PRIMARY KEY,request_number TEXT UNIQUE NOT NULL,public_token TEXT UNIQUE NOT NULL,customer_id INTEGER NOT NULL REFERENCES customers(id),category TEXT NOT NULL,option_value TEXT NOT NULL DEFAULT '',priority TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'Yeni Talep',description TEXT NOT NULL DEFAULT '',anydesk_code TEXT NOT NULL DEFAULT '',amount_tl REAL,credit_amount INTEGER,assigned_to TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,CHECK(amount_tl IS NULL OR credit_amount IS NULL));
CREATE TABLE IF NOT EXISTS request_events(id INTEGER PRIMARY KEY,request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,actor_name TEXT NOT NULL,event_type TEXT NOT NULL,visibility TEXT NOT NULL CHECK(visibility IN ('customer','team')),body TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS team_members(id INTEGER PRIMARY KEY,name TEXT UNIQUE NOT NULL,active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)));
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,expires_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS requests_customer_idx ON requests(customer_id,id DESC);
CREATE INDEX IF NOT EXISTS events_request_idx ON request_events(request_id,id);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);`);
const teamColumns=new Set(db.prepare('PRAGMA table_info(team_members)').all().map(column=>column.name));
if(!teamColumns.has('username'))db.exec("ALTER TABLE team_members ADD COLUMN username TEXT NOT NULL DEFAULT ''");
if(!teamColumns.has('role'))db.exec("ALTER TABLE team_members ADD COLUMN role TEXT NOT NULL DEFAULT 'destek'");
if(!teamColumns.has('created_at'))db.exec("ALTER TABLE team_members ADD COLUMN created_at TEXT NOT NULL DEFAULT ''");
if(!teamColumns.has('password_hash'))db.exec("ALTER TABLE team_members ADD COLUMN password_hash TEXT NOT NULL DEFAULT ''");
db.prepare("UPDATE team_members SET name='Sistem Yöneticisi',username='admin',role='admin',created_at=COALESCE(NULLIF(created_at,''),CURRENT_TIMESTAMP) WHERE username='demo' AND role='admin'").run();
for(const member of db.prepare("SELECT id FROM team_members WHERE username='' OR created_at='' ").all())db.prepare("UPDATE team_members SET username=CASE WHEN username='' THEN ? ELSE username END,created_at=CASE WHEN created_at='' THEN CURRENT_TIMESTAMP ELSE created_at END WHERE id=?").run('legacy-'+member.id,member.id);
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS team_members_username_idx ON team_members(username) WHERE username<>''");
const requestColumns=new Set(db.prepare('PRAGMA table_info(requests)').all().map(column=>column.name));
if(!requestColumns.has('assigned_user_id'))db.exec('ALTER TABLE requests ADD COLUMN assigned_user_id INTEGER REFERENCES team_members(id)');
const eventColumns=new Set(db.prepare('PRAGMA table_info(request_events)').all().map(column=>column.name));
if(!eventColumns.has('actor_user_id'))db.exec('ALTER TABLE request_events ADD COLUMN actor_user_id INTEGER REFERENCES team_members(id)');
const customerIndexSql=db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='requests_customer_idx'").get()?.sql||'';
if(!/\(customer_id\s*,\s*id\s+DESC\)/i.test(customerIndexSql))db.exec('DROP INDEX IF EXISTS requests_customer_idx;CREATE INDEX requests_customer_idx ON requests(customer_id,id DESC)');
db.exec('CREATE INDEX IF NOT EXISTS requests_assigned_user_idx ON requests(assigned_user_id)');
db.prepare("UPDATE requests SET assigned_user_id=(SELECT id FROM team_members WHERE team_members.name=requests.assigned_to ORDER BY id LIMIT 1) WHERE assigned_user_id IS NULL AND assigned_to<>''").run();
db.prepare("UPDATE request_events SET actor_user_id=(SELECT id FROM team_members WHERE team_members.name=request_events.actor_name ORDER BY id LIMIT 1) WHERE actor_user_id IS NULL AND actor_name NOT IN ('Müşteri','Sistem')").run();
if(db.prepare('SELECT COUNT(*) count FROM team_members').get().count===0)db.prepare("INSERT INTO team_members(name,username,role,created_at) VALUES(?,?,?,CURRENT_TIMESTAMP)").run('Sistem Yöneticisi','admin','admin');
const hashPassword=password=>{const salt=crypto.randomBytes(16).toString('hex'),hash=crypto.scryptSync(password,salt,64).toString('hex');return salt+':'+hash};
const verifyPassword=(password,stored)=>{try{const [salt,expected]=String(stored).split(':'),actual=crypto.scryptSync(password,salt,64),expectedBuffer=Buffer.from(expected,'hex');return expectedBuffer.length===actual.length&&crypto.timingSafeEqual(expectedBuffer,actual)}catch{return false}};
const bootstrapAdmin=db.prepare("SELECT id,username FROM team_members WHERE role='admin' AND active=1 AND password_hash='' ORDER BY id LIMIT 1").get();
if(bootstrapAdmin){
 const initialPassword=process.env.TALEP_INITIAL_ADMIN_PASSWORD||crypto.randomBytes(12).toString('base64url');
 if(process.env.NODE_ENV==='production'&&!process.env.TALEP_INITIAL_ADMIN_PASSWORD)throw Error('İlk admin parolası için TALEP_INITIAL_ADMIN_PASSWORD zorunludur.');
 db.prepare('UPDATE team_members SET password_hash=? WHERE id=?').run(hashPassword(initialPassword),bootstrapAdmin.id);
 console.log(`Geçici admin girişi: ${bootstrapAdmin.username} / ${initialPassword}`);
}
const transitions={'Yeni Talep':['Teslim Alındı'],'Teslim Alındı':['İşleme Alındı'],'İşleme Alındı':['Müşteriden Bilgi Bekleniyor','Tamamlandı'],'Müşteriden Bilgi Bekleniyor':['Tamamlandı','İptal Edildi'],'Tamamlandı':[],'İptal Edildi':[]};
const categories=['integration','printer','credit','caller','feature','other'];
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.svg':'image/svg+xml'};
const send=(res,status,value,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(value))};
const clean=(value,max)=>String(value??'').trim().slice(0,max);
const phone=value=>{let digits=String(value??'').replace(/\D/g,'');while(digits.length>12&&digits.startsWith('9'))digits=digits.slice(1);if(digits.startsWith('0'))digits='90'+digits.slice(1);else if(digits.startsWith('5'))digits='90'+digits;return digits};
const validPhone=value=>/^90\d{10}$/.test(value);
const event=(id,actor,type,visibility,text,actorUserId=null)=>db.prepare('INSERT INTO request_events(request_id,actor_name,event_type,visibility,body,actor_user_id) VALUES(?,?,?,?,?,?)').run(id,actor,type,visibility,text,actorUserId);
const requestSql="SELECT r.*,COALESCE(assigned.name,NULLIF(r.assigned_to,''),'') AS assigned_to,c.phone,c.name AS customer,c.company FROM requests r JOIN customers c ON c.id=r.customer_id LEFT JOIN team_members assigned ON assigned.id=r.assigned_user_id";
const teamRequestListSql="SELECT r.request_number,r.category,r.priority,r.status,r.created_at,COALESCE(assigned.name,NULLIF(r.assigned_to,''),'') AS assigned_to,c.phone,c.name AS customer,c.company FROM requests r JOIN customers c ON c.id=r.customer_id LEFT JOIN team_members assigned ON assigned.id=r.assigned_user_id";
const customerRequestListSql="SELECT r.request_number,r.public_token,r.category,r.priority,r.status,r.created_at,COALESCE(assigned.name,NULLIF(r.assigned_to,''),'') AS assigned_to FROM requests r JOIN customers c ON c.id=r.customer_id LEFT JOIN team_members assigned ON assigned.id=r.assigned_user_id";
const eventsFor=(id,customerOnly=false)=>db.prepare(`SELECT actor_user_id,actor_name,event_type,visibility,body,created_at FROM request_events WHERE request_id=? ${customerOnly?"AND visibility='customer'":''} ORDER BY id`).all(id);
const revisionFor=id=>{const value=db.prepare('SELECT updated_at,(SELECT COALESCE(MAX(id),0) FROM request_events WHERE request_id=requests.id) AS event_id FROM requests WHERE id=?').get(id);return value?value.updated_at+':'+value.event_id:''};
const detailed=(row,customerOnly=false)=>({...row,events:eventsFor(row.id,customerOnly),revision:revisionFor(row.id)});
const getRequest=number=>db.prepare(requestSql+' WHERE r.request_number=?').get(number);
const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{let result=fn();db.exec('COMMIT');return result}catch(error){db.exec('ROLLBACK');throw error}};
function readBody(req){return new Promise((resolve,reject)=>{let chunks=[],size=0;req.on('data',chunk=>{size+=chunk.length;if(size>1e6){reject(Object.assign(Error('Veri çok büyük'),{status:413}));req.destroy();return}chunks.push(chunk)});req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString()||'{}'))}catch{reject(Object.assign(Error('Geçersiz JSON'),{status:400}))}});req.on('error',reject)})}
const teamMemberSql='SELECT id,name,username,role,active,created_at FROM team_members';
const sessionDays=Math.max(1,Number(process.env.TALEP_SESSION_DAYS)||7);
const secureCookie=process.env.TALEP_COOKIE_SECURE==='true'||process.env.NODE_ENV==='production';
const cookieHeader=(token,maxAge)=>`talep_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookie?'; Secure':''}`;
const tokenHash=token=>crypto.createHash('sha256').update(token).digest('hex');
const parseCookies=req=>Object.fromEntries(String(req.headers.cookie||'').split(';').map(part=>part.trim().split('=')).filter(parts=>parts.length===2).map(([key,value])=>[key,decodeURIComponent(value)]));
function currentUser(req){
 const token=parseCookies(req).talep_session;if(!token)return null;
 db.prepare("DELETE FROM sessions WHERE expires_at<=CURRENT_TIMESTAMP").run();
 return db.prepare(`SELECT u.id,u.name,u.username,u.role,u.active FROM sessions s JOIN team_members u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>CURRENT_TIMESTAMP AND u.active=1`).get(tokenHash(token))||null;
}
function requireUser(req,res,role=null){
 const user=currentUser(req);if(!user){send(res,401,{error:'Personel oturumu gerekli.'});return null}
 if(role&&user.role!==role){send(res,403,{error:'Bu işlem için yetkiniz yok.'});return null}
 return user;
}
function teamMemberInput(body){
 const name=clean(body.name,80),username=clean(body.username,50).toLocaleLowerCase('tr-TR'),role=clean(body.role,20);
 if(name.length<2)return {error:'Ad en az 2 karakter olmalı.'};
 if(!/^[a-z0-9._-]{3,50}$/.test(username))return {error:'Kullanıcı adı 3-50 karakter olmalı; yalnızca küçük harf, rakam, nokta, tire ve alt çizgi kullanılabilir.'};
 if(!['admin','destek'].includes(role))return {error:'Rol admin veya destek olmalı.'};
 return {name,username,role};
}
async function api(req,res,url){
 const method=req.method,route=url.pathname;
 if(method==='GET'&&route==='/api/health')return send(res,200,{ok:true,database:'sqlite'});
 if(method==='POST'&&route==='/api/auth/login'){
  const bodyData=await readBody(req),username=clean(bodyData.username,50).toLocaleLowerCase('tr-TR'),password=String(bodyData.password||'');
  const user=db.prepare('SELECT id,name,username,role,active,password_hash FROM team_members WHERE username=?').get(username);
  if(password.length>200||!user||!user.active||!verifyPassword(password,user.password_hash))return send(res,401,{error:'Kullanıcı adı veya parola hatalı.'});
  const token=crypto.randomBytes(32).toString('base64url');
  db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,datetime('now',?))").run(tokenHash(token),user.id,`+${sessionDays} days`);
  return send(res,200,{user:{id:user.id,name:user.name,username:user.username,role:user.role}}, {'Set-Cookie':cookieHeader(token,sessionDays*86400)});
 }
 if(method==='POST'&&route==='/api/auth/logout'){
  const token=parseCookies(req).talep_session;if(token)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(token));
  return send(res,200,{ok:true},{'Set-Cookie':cookieHeader('',0)});
 }
 if(method==='GET'&&route==='/api/auth/me'){
  const user=currentUser(req);return user?send(res,200,{user}):send(res,401,{error:'Personel oturumu bulunamadı.'});
 }
 if(method==='GET'&&route==='/api/team'){const user=requireUser(req,res);if(!user)return;return send(res,200,{members:db.prepare(teamMemberSql+' WHERE active=1 ORDER BY name').all()})}
 if(route==='/api/admin/team-members'){
  const admin=requireUser(req,res,'admin');if(!admin)return;
  if(method==='GET')return send(res,200,{members:db.prepare(teamMemberSql+' ORDER BY active DESC,name').all()});
  if(method==='POST'){
   const bodyData=await readBody(req),input=teamMemberInput(bodyData),password=String(bodyData.password||'');if(input.error)return send(res,422,{error:input.error});
   if(password.length<8||password.length>200)return send(res,422,{error:'Başlangıç parolası 8-200 karakter olmalı.'});
   try{const result=db.prepare('INSERT INTO team_members(name,username,role,active,created_at,password_hash) VALUES(?,?,?,1,CURRENT_TIMESTAMP,?)').run(input.name,input.username,input.role,hashPassword(password));return send(res,201,{member:db.prepare(teamMemberSql+' WHERE id=?').get(result.lastInsertRowid)})}
   catch(error){if(String(error.message).includes('UNIQUE'))return send(res,409,{error:'Bu ad veya kullanıcı adı zaten kullanılıyor.'});throw error}
  }
 }
 const adminMemberMatch=route.match(/^\/api\/admin\/team-members\/(\d+)$/);
 if(adminMemberMatch&&method==='PATCH'){
  const admin=requireUser(req,res,'admin');if(!admin)return;
  const id=Number(adminMemberMatch[1]),current=db.prepare(teamMemberSql+' WHERE id=?').get(id);if(!current)return send(res,404,{error:'Ekip üyesi bulunamadı.'});
  const bodyData=await readBody(req),input=teamMemberInput({...current,...bodyData});if(input.error)return send(res,422,{error:input.error});
  const active=bodyData.active===undefined?current.active:bodyData.active===true||bodyData.active===1?1:bodyData.active===false||bodyData.active===0?0:null;
  if(active===null)return send(res,422,{error:'Aktiflik değeri geçersiz.'});
  const password=String(bodyData.password||'');if(password&&(password.length<8||password.length>200))return send(res,422,{error:'Yeni parola 8-200 karakter olmalı.'});
  if(id===admin.id&&active===0)return send(res,409,{error:'Kendi hesabınızı pasife alamazsınız.'});
  if(current.role==='admin'&&current.active&&(active===0||input.role!=='admin')){
   const activeAdmins=db.prepare("SELECT COUNT(*) count FROM team_members WHERE role='admin' AND active=1").get().count;
   if(activeAdmins<=1)return send(res,409,{error:'Sistemde en az bir aktif admin bulunmalı.'});
  }
  try{transaction(()=>{db.prepare(`UPDATE team_members SET name=?,username=?,role=?,active=?${password?',password_hash=?':''} WHERE id=?`).run(...(password?[input.name,input.username,input.role,active,hashPassword(password),id]:[input.name,input.username,input.role,active,id]));if(!active||password)db.prepare('DELETE FROM sessions WHERE user_id=?').run(id)});return send(res,200,{member:db.prepare(teamMemberSql+' WHERE id=?').get(id)})}
  catch(error){if(String(error.message).includes('UNIQUE'))return send(res,409,{error:'Bu ad veya kullanıcı adı zaten kullanılıyor.'});throw error}
 }
 if(method==='GET'&&route==='/api/customers/lookup'){let p=phone(url.searchParams.get('phone'));return send(res,200,{customer:validPhone(p)?db.prepare('SELECT phone,name,company FROM customers WHERE phone=?').get(p)||null:null})}
 if(method==='GET'&&route==='/api/customer/requests'){let p=phone(url.searchParams.get('phone'));if(!validPhone(p))return send(res,422,{error:'Geçersiz telefon numarası.'});return send(res,200,{requests:db.prepare(customerRequestListSql+' WHERE c.phone=? ORDER BY r.id DESC').all(p)})}
 if(method==='GET'&&route==='/api/requests'){const user=requireUser(req,res);if(!user)return;return send(res,200,{requests:db.prepare(teamRequestListSql+' ORDER BY r.id DESC').all()})}
 if(method==='POST'&&route==='/api/requests'){
  let b=await readBody(req),p=phone(b.phone),cat=clean(b.category,30),name=clean(b.name,80).replace(/[0-9]/g,''),company=clean(b.company,120);
  if(!validPhone(p)||!categories.includes(cat))return send(res,422,{error:'Geçersiz telefon veya talep türü.'});
  if(!name)return send(res,422,{error:'Lütfen adınızı soyadınızı girin.'});
  let tl=b.amount_tl===''||b.amount_tl==null?null:Number(b.amount_tl),credit=b.credit_amount===''||b.credit_amount==null?null:Number(b.credit_amount);
  if((tl!==null&&(!Number.isFinite(tl)||tl<=0))||(credit!==null&&(!Number.isInteger(credit)||credit<=0))||(tl!==null&&credit!==null)||(cat==='credit'&&tl===null&&credit===null))return send(res,422,{error:'Geçerli TL veya kontör miktarından yalnızca birini girin.'});
  let desk=clean(b.anydesk_code,20).replace(/\D/g,'');if(desk&&![9,10].includes(desk.length))return send(res,422,{error:'AnyDesk kodu 9 veya 10 hane olmalı.'});
  let result=transaction(()=>{
   db.prepare("INSERT INTO customers(phone,name,company) VALUES(?,?,?) ON CONFLICT(phone) DO UPDATE SET name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE customers.name END,company=CASE WHEN excluded.name<>'' THEN excluded.company ELSE customers.company END,updated_at=CURRENT_TIMESTAMP").run(p,name,company);
   let customer=db.prepare('SELECT id FROM customers WHERE phone=?').get(p),year=new Date().getFullYear(),prefix=`TK-${year}-`;
   let max=db.prepare('SELECT MAX(CAST(SUBSTR(request_number,?) AS INTEGER)) AS n FROM requests WHERE request_number LIKE ?').get(prefix.length+1,prefix+'%').n||0;
   let number=prefix+String(max+1).padStart(6,'0'),token=crypto.randomBytes(24).toString('hex');
   let id=Number(db.prepare('INSERT INTO requests(request_number,public_token,customer_id,category,option_value,priority,description,anydesk_code,amount_tl,credit_amount) VALUES(?,?,?,?,?,?,?,?,?,?)').run(number,token,customer.id,cat,clean(b.option_value,60),cat==='credit'?'Acil':b.priority==='Acil'?'Acil':'Normal',clean(b.description,1500),desk,tl,credit).lastInsertRowid);
    event(id,'Müşteri','created','customer','Müşteri talebi oluşturdu.');
   return {request_number:number,public_token:token,status:'Yeni Talep'};
  });return send(res,201,result)
 }
 let publicMatch=route.match(/^\/api\/public\/requests\/([^/]+)$/);
 if(publicMatch){
  let number=decodeURIComponent(publicMatch[1]),b=method==='POST'?await readBody(req):null,token=method==='GET'?url.searchParams.get('token'):clean(b.token,100);
  let row=db.prepare(requestSql+' WHERE r.request_number=? AND r.public_token=?').get(number,token);
  if(!row)return send(res,404,{error:'Talep bulunamadı.'});
  if(method==='GET')return send(res,200,{request:detailed(row,true)});
  if(method==='POST'){let message=clean(b.message,1500);if(!message)return send(res,422,{error:'Mesaj boş olamaz.'});transaction(()=>{event(row.id,'Müşteri','message','customer','Müşteri mesajı: '+message);db.prepare('UPDATE requests SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(row.id)});return send(res,201,{request:detailed(getRequest(number),true)})}
  }
  const revisionMatch=route.match(/^\/api\/requests\/([^/]+)\/revision$/);
  if(revisionMatch&&method==='GET'){
   const user=requireUser(req,res);if(!user)return;
   const row=getRequest(decodeURIComponent(revisionMatch[1]));if(!row)return send(res,404,{error:'Talep bulunamadı.'});
   return send(res,200,{revision:revisionFor(row.id)});
  }
  let teamMatch=route.match(/^\/api\/requests\/([^/]+)$/);
 if(teamMatch){
  const user=requireUser(req,res);if(!user)return;
  let number=decodeURIComponent(teamMatch[1]),row=getRequest(number);if(!row)return send(res,404,{error:'Talep bulunamadı.'});
  if(method==='GET')return send(res,200,{request:detailed(row)});
  if(method==='PATCH'){
    let b=await readBody(req),actor=user.name;
    if(b.action==='take'){
     if(row.assigned_user_id||row.assigned_to)return send(res,409,{error:'Talep zaten devir alınmış.'});
     if(['Tamamlandı','İptal Edildi'].includes(row.status))return send(res,422,{error:'Kapalı talep devir alınamaz.'});
     transaction(()=>{db.prepare("UPDATE requests SET assigned_user_id=?,assigned_to=?,status='Teslim Alındı',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(user.id,actor,row.id);event(row.id,actor,'assigned','customer',actor+' talebi devir aldı.',user.id)});
    }else if(b.action==='status'){
     let next=clean(b.status,80);if(!(row.assigned_user_id||row.assigned_to)||!transitions[row.status]?.includes(next))return send(res,422,{error:'Bu durum geçişine izin verilmiyor.'});
     transaction(()=>{db.prepare('UPDATE requests SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(next,row.id);event(row.id,actor,'status','customer',actor+' durumu “'+next+'” olarak değiştirdi.',user.id)});
    }else if(b.action==='message'){
     let message=clean(b.message,1500),internal=b.internal===true;if(!message)return send(res,422,{error:'Mesaj boş olamaz.'});
     transaction(()=>{event(row.id,actor,internal?'note':'message',internal?'team':'customer',actor+(internal?' · İç not: ':' · Müşteriye mesaj: ')+message,user.id);db.prepare('UPDATE requests SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(row.id)});
   }else return send(res,422,{error:'Geçersiz işlem.'});
   return send(res,200,{request:detailed(getRequest(number))})
  }
 }
 return send(res,404,{error:'Bulunamadı.'})
}
const server=http.createServer(async(req,res)=>{try{
 let url=new URL(req.url,'http://localhost');if(url.pathname.startsWith('/api/'))return await api(req,res,url);
 let pathname=decodeURIComponent(url.pathname==='/'||url.pathname==='/personel'?'/index.html':url.pathname);
 if(!['/index.html','/app.js','/style.css','/sw.js','/manifest.webmanifest','/icon.svg'].includes(pathname)){res.writeHead(404);return res.end('Bulunamadı')}
 let file=path.join(root,pathname.slice(1));
 if(!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end('Bulunamadı')}
 res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});fs.createReadStream(file).pipe(res)
}catch(error){console.error(error);if(!res.headersSent)send(res,error.status||500,{error:error.status?error.message:'Sunucu hatası.'})}});
if(require.main===module)server.listen(process.env.PORT||3000,()=>console.log('Talep Merkezi: http://localhost:'+(process.env.PORT||3000)));
module.exports={server,db};

