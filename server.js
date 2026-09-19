const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const root=__dirname,data=process.env.TALEP_DATA_DIR||path.join(root,'data');fs.mkdirSync(data,{recursive:true});
const db=new DatabaseSync(path.join(data,'talep-merkezi.db'));
db.exec(`PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY,phone TEXT UNIQUE NOT NULL,name TEXT NOT NULL DEFAULT '',company TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS requests(id INTEGER PRIMARY KEY,request_number TEXT UNIQUE NOT NULL,public_token TEXT UNIQUE NOT NULL,customer_id INTEGER NOT NULL REFERENCES customers(id),category TEXT NOT NULL,option_value TEXT NOT NULL DEFAULT '',priority TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'Yeni Talep',description TEXT NOT NULL DEFAULT '',anydesk_code TEXT NOT NULL DEFAULT '',amount_tl REAL,credit_amount INTEGER,assigned_to TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,CHECK(amount_tl IS NULL OR credit_amount IS NULL));
CREATE TABLE IF NOT EXISTS request_events(id INTEGER PRIMARY KEY,request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,actor_name TEXT NOT NULL,event_type TEXT NOT NULL,visibility TEXT NOT NULL CHECK(visibility IN ('customer','team')),body TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS team_members(id INTEGER PRIMARY KEY,name TEXT UNIQUE NOT NULL,active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)));
CREATE INDEX IF NOT EXISTS requests_customer_idx ON requests(customer_id,created_at DESC);
CREATE INDEX IF NOT EXISTS events_request_idx ON request_events(request_id,id);`);
const teamColumns=new Set(db.prepare('PRAGMA table_info(team_members)').all().map(column=>column.name));
if(!teamColumns.has('username'))db.exec("ALTER TABLE team_members ADD COLUMN username TEXT NOT NULL DEFAULT ''");
if(!teamColumns.has('role'))db.exec("ALTER TABLE team_members ADD COLUMN role TEXT NOT NULL DEFAULT 'destek'");
if(!teamColumns.has('created_at'))db.exec("ALTER TABLE team_members ADD COLUMN created_at TEXT NOT NULL DEFAULT ''");
db.prepare("UPDATE team_members SET username='demo',role='admin',created_at=COALESCE(NULLIF(created_at,''),CURRENT_TIMESTAMP) WHERE name='Demo Ekip Üyesi'").run();
for(const member of db.prepare("SELECT id FROM team_members WHERE username='' OR created_at='' ").all())db.prepare("UPDATE team_members SET username=CASE WHEN username='' THEN ? ELSE username END,created_at=CASE WHEN created_at='' THEN CURRENT_TIMESTAMP ELSE created_at END WHERE id=?").run('legacy-'+member.id,member.id);
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS team_members_username_idx ON team_members(username) WHERE username<>''");
db.prepare("INSERT OR IGNORE INTO team_members(name,username,role,created_at) VALUES(?,?,?,CURRENT_TIMESTAMP)").run('Demo Ekip Üyesi','demo','admin');
const transitions={'Yeni Talep':['Teslim Alındı'],'Teslim Alındı':['İşleme Alındı'],'İşleme Alındı':['Müşteriden Bilgi Bekleniyor','Tamamlandı'],'Müşteriden Bilgi Bekleniyor':['Tamamlandı','İptal Edildi'],'Tamamlandı':[],'İptal Edildi':[]};
const categories=['integration','printer','credit','caller','feature','other'];
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.svg':'image/svg+xml'};
const send=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value))};
const clean=(value,max)=>String(value??'').trim().slice(0,max);
const phone=value=>{let digits=String(value??'').replace(/\D/g,'');while(digits.length>12&&digits.startsWith('9'))digits=digits.slice(1);if(digits.startsWith('0'))digits='90'+digits.slice(1);else if(digits.startsWith('5'))digits='90'+digits;return digits};
const validPhone=value=>/^90\d{10}$/.test(value);
const event=(id,actor,type,visibility,text)=>db.prepare('INSERT INTO request_events(request_id,actor_name,event_type,visibility,body) VALUES(?,?,?,?,?)').run(id,actor,type,visibility,text);
const requestSql='SELECT r.*,c.phone,c.name AS customer,c.company FROM requests r JOIN customers c ON c.id=r.customer_id';
const eventsFor=(id,customerOnly=false)=>db.prepare(`SELECT actor_name,event_type,visibility,body,created_at FROM request_events WHERE request_id=? ${customerOnly?"AND visibility='customer'":''} ORDER BY id`).all(id);
const detailed=(row,customerOnly=false)=>({...row,events:eventsFor(row.id,customerOnly)});
const getRequest=number=>db.prepare(requestSql+' WHERE r.request_number=?').get(number);
const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{let result=fn();db.exec('COMMIT');return result}catch(error){db.exec('ROLLBACK');throw error}};
function readBody(req){return new Promise((resolve,reject)=>{let chunks=[],size=0;req.on('data',chunk=>{size+=chunk.length;if(size>1e6){reject(Object.assign(Error('Veri çok büyük'),{status:413}));req.destroy();return}chunks.push(chunk)});req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString()||'{}'))}catch{reject(Object.assign(Error('Geçersiz JSON'),{status:400}))}});req.on('error',reject)})}
const teamMemberSql='SELECT id,name,username,role,active,created_at FROM team_members';
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
 if(method==='GET'&&route==='/api/team')return send(res,200,{members:db.prepare(teamMemberSql+' WHERE active=1 ORDER BY name').all()});
 if(route==='/api/admin/team-members'){
  if(method==='GET')return send(res,200,{members:db.prepare(teamMemberSql+' ORDER BY active DESC,name').all()});
  if(method==='POST'){
   const input=teamMemberInput(await readBody(req));if(input.error)return send(res,422,{error:input.error});
   try{const result=db.prepare('INSERT INTO team_members(name,username,role,active,created_at) VALUES(?,?,?,1,CURRENT_TIMESTAMP)').run(input.name,input.username,input.role);return send(res,201,{member:db.prepare(teamMemberSql+' WHERE id=?').get(result.lastInsertRowid)})}
   catch(error){if(String(error.message).includes('UNIQUE'))return send(res,409,{error:'Bu ad veya kullanıcı adı zaten kullanılıyor.'});throw error}
  }
 }
 const adminMemberMatch=route.match(/^\/api\/admin\/team-members\/(\d+)$/);
 if(adminMemberMatch&&method==='PATCH'){
  const id=Number(adminMemberMatch[1]),current=db.prepare(teamMemberSql+' WHERE id=?').get(id);if(!current)return send(res,404,{error:'Ekip üyesi bulunamadı.'});
  const bodyData=await readBody(req),input=teamMemberInput({...current,...bodyData});if(input.error)return send(res,422,{error:input.error});
  const active=bodyData.active===undefined?current.active:bodyData.active===true||bodyData.active===1?1:bodyData.active===false||bodyData.active===0?0:null;
  if(active===null)return send(res,422,{error:'Aktiflik değeri geçersiz.'});
  try{db.prepare('UPDATE team_members SET name=?,username=?,role=?,active=? WHERE id=?').run(input.name,input.username,input.role,active,id);return send(res,200,{member:db.prepare(teamMemberSql+' WHERE id=?').get(id)})}
  catch(error){if(String(error.message).includes('UNIQUE'))return send(res,409,{error:'Bu ad veya kullanıcı adı zaten kullanılıyor.'});throw error}
 }
 if(method==='GET'&&route==='/api/customers/lookup'){let p=phone(url.searchParams.get('phone'));return send(res,200,{customer:validPhone(p)?db.prepare('SELECT phone,name,company FROM customers WHERE phone=?').get(p)||null:null})}
 if(method==='GET'&&route==='/api/customer/requests'){let p=phone(url.searchParams.get('phone'));if(!validPhone(p))return send(res,422,{error:'Geçersiz telefon numarası.'});return send(res,200,{requests:db.prepare(requestSql+' WHERE c.phone=? ORDER BY r.id DESC').all(p)})}
 if(method==='GET'&&route==='/api/requests')return send(res,200,{requests:db.prepare(requestSql+' ORDER BY r.id DESC').all()});
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
  if(method==='POST'){let message=clean(b.message,1500);if(!message)return send(res,422,{error:'Mesaj boş olamaz.'});event(row.id,'Müşteri','message','customer','Müşteri mesajı: '+message);return send(res,201,{request:detailed(getRequest(number),true)})}
 }
 let teamMatch=route.match(/^\/api\/requests\/([^/]+)$/);
 if(teamMatch){
  let number=decodeURIComponent(teamMatch[1]),row=getRequest(number);if(!row)return send(res,404,{error:'Talep bulunamadı.'});
  if(method==='GET')return send(res,200,{request:detailed(row)});
  if(method==='PATCH'){
   let b=await readBody(req),actor=clean(b.actor,80)||'Demo Ekip Üyesi';
   if(!db.prepare('SELECT 1 FROM team_members WHERE name=? AND active=1').get(actor))return send(res,422,{error:'Geçersiz ekip üyesi.'});
   if(b.action==='take'){
    if(row.assigned_to)return send(res,409,{error:'Talep zaten devralınmış.'});
    transaction(()=>{db.prepare("UPDATE requests SET assigned_to=?,status='Teslim Alındı',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(actor,row.id);event(row.id,actor,'assigned','customer',actor+' talebi devraldı.')});
   }else if(b.action==='status'){
    let next=clean(b.status,80);if(!row.assigned_to||!transitions[row.status]?.includes(next))return send(res,422,{error:'Bu durum geçişine izin verilmiyor.'});
    transaction(()=>{db.prepare('UPDATE requests SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(next,row.id);event(row.id,actor,'status','customer',actor+' durumu “'+next+'” olarak değiştirdi.')});
   }else if(b.action==='message'){
    let message=clean(b.message,1500),internal=b.internal===true;if(!message)return send(res,422,{error:'Mesaj boş olamaz.'});
    event(row.id,actor,internal?'note':'message',internal?'team':'customer',actor+(internal?' · İç not: ':' · Müşteriye mesaj: ')+message);
   }else return send(res,422,{error:'Geçersiz işlem.'});
   return send(res,200,{request:detailed(getRequest(number))})
  }
 }
 return send(res,404,{error:'Bulunamadı.'})
}
const server=http.createServer(async(req,res)=>{try{
 let url=new URL(req.url,'http://localhost');if(url.pathname.startsWith('/api/'))return await api(req,res,url);
 let pathname=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname);
 if(!['/index.html','/app.js','/style.css','/sw.js','/manifest.webmanifest','/icon.svg'].includes(pathname)){res.writeHead(404);return res.end('Bulunamadı')}
 let file=path.join(root,pathname.slice(1));
 if(!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end('Bulunamadı')}
 res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});fs.createReadStream(file).pipe(res)
}catch(error){console.error(error);if(!res.headersSent)send(res,error.status||500,{error:error.status?error.message:'Sunucu hatası.'})}});
if(require.main===module)server.listen(process.env.PORT||3000,()=>console.log('Talep Merkezi: http://localhost:'+(process.env.PORT||3000)));
module.exports={server,db};

