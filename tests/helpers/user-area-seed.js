// Synthetic user-area fixture. Call only after setting a throwaway FIRMLEDGER_DATA_DIR.
module.exports = function seedUserArea() {
const {db,setSetting}=require('../../src/db');
const bcrypt=require('bcryptjs');
const run=(sql,...p)=>db.prepare(sql).run(...p);
setSetting('upkeep_on','0');
const uid=run("INSERT INTO users(email,password_hash,name,plan,plan_expires_at,trial_expires_at,leads_digest) VALUES(?,?,?,'pro','2099-01-01','','none')",'owner@preview.example',bcrypt.hashSync('PreviewOnly!2026',10),'Demo Business Owner').lastInsertRowid;
const iid=run("INSERT INTO users(email,password_hash,name,trial_expires_at) VALUES(?,?,?,'')",'buyer@preview.example',bcrypt.hashSync('PreviewOnly!2026',10),'Demo Customer').lastInsertRowid;
const lid=run("INSERT INTO listings(slug,name,description,category,country,city,website,status,claimed,owner_user_id) VALUES('demo-business','Nyeri Business Services','A demo business for previewing the customer dashboard and its user journeys.','Professional Services','Kenya','Nyeri','https://example.com','approved',1,?)",uid).lastInsertRowid;
run('INSERT INTO favorites(user_id,listing_id) VALUES(?,?)',uid,lid);
const tid=run("INSERT INTO tickets(user_id,ref,subject,category,status) VALUES(?,'FL-DEMO','Help with my listing','account','open')",uid).lastInsertRowid;
run("INSERT INTO ticket_messages(ticket_id,sender,body) VALUES(?,'user','How do I update our office location?')",tid);
run("INSERT INTO ticket_messages(ticket_id,sender,body) VALUES(?,'admin','Open your dashboard and choose Edit listing to update the address.')",tid);
for(let i=0;i<16;i++)run("INSERT INTO notifications(user_id,title,body,url,kind) VALUES(?,?,?,'/dashboard/leads','info')",uid,i===0?'Weekly leads report':'Your business profile was updated',i===0?'This week: 12 inquiries, 4 qualified leads and 2 won. '+ 'LongReference'.repeat(20):'Your listing details are live. Review your profile and keep your contact information up to date.');
require('../../src/lib/notifications').archive(16, uid, '1week');
run("INSERT INTO jobs(listing_id,owner_user_id,title,description,location) VALUES(?,?,'Customer support specialist','Help our clients find the right services.','Nyeri')",lid,uid);
const lead=require('../../src/lib/leads').create({listing:db.prepare('SELECT * FROM listings WHERE id=?').get(lid),inquirerUserId:iid,fields:{name:'Demo Customer',email:'buyer@preview.example',message:'Hello, could you send a quote for your business services?',looking_for:'Business consultation'}});
require('../../src/lib/leads').addMessage(lead.id,uid,'Thank you for reaching out. What timeline do you have in mind?');
const {createSession}=require('../../src/lib/session');
const sessions={owner:createSession(uid,'user'),buyer:createSession(iid,'user'),lid,tid,lead:lead.id};
return sessions;
};
