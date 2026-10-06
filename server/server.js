
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import http from "http";
import { Server } from "socket.io";

dotenv.config();
const PORT = Number(process.env.PORT || 5000);
const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret-in-production";
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";
const COLLEGE_DESTINATION = { name: "Vignan's Institute of Information Technology (VIIT)", lat: 17.7106243, lng: 83.1637641 };
const db = await open({ filename: process.env.DB_FILE || "./bus_tracking.db", driver: sqlite3.Database });

await db.exec(`
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, user_id TEXT UNIQUE NOT NULL,
 password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','driver','passenger')),
 document_type TEXT, document_number TEXT, verified_at TEXT
);
CREATE TABLE IF NOT EXISTS buses(
 id INTEGER PRIMARY KEY AUTOINCREMENT, bus_number TEXT UNIQUE NOT NULL,
 registration_number TEXT, status TEXT NOT NULL DEFAULT 'available', driver_id INTEGER, start_name TEXT, start_lat REAL, start_lng REAL, end_name TEXT, end_lat REAL, end_lng REAL,
 FOREIGN KEY(driver_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS bus_stops(
 id INTEGER PRIMARY KEY AUTOINCREMENT, bus_id INTEGER NOT NULL, name TEXT NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL, sequence INTEGER NOT NULL, radius_m INTEGER NOT NULL DEFAULT 150,
 FOREIGN KEY(bus_id) REFERENCES buses(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS trips(
 id INTEGER PRIMARY KEY AUTOINCREMENT, bus_id INTEGER NOT NULL, driver_id INTEGER NOT NULL,
 start_name TEXT NOT NULL, start_lat REAL NOT NULL, start_lng REAL NOT NULL,
 end_name TEXT NOT NULL, end_lat REAL NOT NULL, end_lng REAL NOT NULL,
 status TEXT NOT NULL DEFAULT 'active', started_at TEXT NOT NULL, ended_at TEXT, route_geometry TEXT,
 FOREIGN KEY(bus_id) REFERENCES buses(id), FOREIGN KEY(driver_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS gps_locations(
 id INTEGER PRIMARY KEY AUTOINCREMENT, trip_id INTEGER NOT NULL, latitude REAL NOT NULL,
 longitude REAL NOT NULL, speed REAL, accuracy REAL, timestamp TEXT NOT NULL,
 FOREIGN KEY(trip_id) REFERENCES trips(id)
);
CREATE TABLE IF NOT EXISTS passenger_requests(
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, pickup_name TEXT NOT NULL,
 pickup_lat REAL NOT NULL, pickup_lng REAL NOT NULL, destination_name TEXT NOT NULL,
 destination_lat REAL NOT NULL, destination_lng REAL NOT NULL, trip_id INTEGER,
 alerted_at TEXT, created_at TEXT NOT NULL,
 FOREIGN KEY(user_id) REFERENCES users(id), FOREIGN KEY(trip_id) REFERENCES trips(id)
);
CREATE TABLE IF NOT EXISTS alerts(
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, trip_id INTEGER NOT NULL,
 request_id INTEGER, message TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT,
 FOREIGN KEY(user_id) REFERENCES users(id), FOREIGN KEY(trip_id) REFERENCES trips(id),
 FOREIGN KEY(request_id) REFERENCES passenger_requests(id)
);
CREATE TABLE IF NOT EXISTS trip_stops(
 id INTEGER PRIMARY KEY AUTOINCREMENT, trip_id INTEGER NOT NULL, name TEXT NOT NULL,
 latitude REAL NOT NULL, longitude REAL NOT NULL, sequence INTEGER NOT NULL, radius_m INTEGER NOT NULL DEFAULT 150,
 FOREIGN KEY(trip_id) REFERENCES trips(id) ON DELETE CASCADE
);
`);

// Migrate older databases that used email as the login identifier.
const userCols=await db.all("PRAGMA table_info(users)");
const hasUserId=userCols.some(c=>c.name==="user_id");
const hasEmail=userCols.some(c=>c.name==="email");
if(!hasUserId && hasEmail){try{await db.run("ALTER TABLE users RENAME COLUMN email TO user_id");}catch{}}
for(const col of ['document_type TEXT','document_number TEXT','verified_at TEXT']){try{await db.run(`ALTER TABLE users ADD COLUMN ${col}`)}catch{}}
try{await db.run("CREATE UNIQUE INDEX IF NOT EXISTS one_admin_only ON users(role) WHERE role='admin'")}catch{}

async function seed(){
 const admin=await db.get("SELECT id FROM users WHERE role='admin' LIMIT 1");
 if(!admin) await db.run("INSERT INTO users(name,user_id,password_hash,role,verified_at) VALUES(?,?,?,?,?)",["Administrator","admin",await bcrypt.hash("Admin@123",10),"admin",new Date().toISOString()]);
 const student=await db.get("SELECT id FROM users WHERE user_id=?",["student"]);
 if(!student) await db.run("INSERT INTO users(name,user_id,password_hash,role) VALUES(?,?,?,?)",["Student","student",await bcrypt.hash("Student@123",10),"passenger"]);
 for(const b of [["BUS-01","AP-00-AA-0001"],["BUS-02","AP-00-AA-0002"]]){
  if(!await db.get("SELECT id FROM buses WHERE bus_number=?",[b[0]]))
    await db.run("INSERT INTO buses(bus_number,registration_number) VALUES(?,?)",b);
 }
}
await seed();
try{await db.run("ALTER TABLE trips ADD COLUMN route_geometry TEXT");}catch{}
try{await db.run("ALTER TABLE buses ADD COLUMN driver_id INTEGER");}catch{}
for(const col of ['start_name TEXT','start_lat REAL','start_lng REAL','end_name TEXT','end_lat REAL','end_lng REAL']){try{await db.run(`ALTER TABLE buses ADD COLUMN ${col}`)}catch{}}
await db.run("UPDATE buses SET end_name=?, end_lat=?, end_lng=?",[COLLEGE_DESTINATION.name,COLLEGE_DESTINATION.lat,COLLEGE_DESTINATION.lng]);

const app=express();
app.use(cors({origin:FRONTEND_ORIGIN==="*" ? true : FRONTEND_ORIGIN, credentials:true}));
app.use(express.json({limit:"1mb"}));
const httpServer=http.createServer(app);
const io=new Server(httpServer,{cors:{origin:FRONTEND_ORIGIN==="*" ? "*" : FRONTEND_ORIGIN}});

function tokenFor(u){return jwt.sign({id:u.id,name:u.name,userId:u.user_id,role:u.role},JWT_SECRET,{expiresIn:"7d"});}
function auth(req,res,next){
 try{
  const h=req.headers.authorization||"";
  if(!h.startsWith("Bearer ")) return res.status(401).json({error:"Authentication required"});
  req.user=jwt.verify(h.slice(7),JWT_SECRET); next();
 }catch{return res.status(401).json({error:"Invalid or expired token"});}
}
const role=(...roles)=>(req,res,next)=>roles.includes(req.user.role)?next():res.status(403).json({error:"Forbidden"});
const now=()=>new Date().toISOString();
const validCoord=(x)=>Number.isFinite(Number(x)) && Number(x)>=-90 && Number(x)<=90;
const validLng=(x)=>Number.isFinite(Number(x)) && Number(x)>=-180 && Number(x)<=180;
function hav(a,b,c,d){
 const R=6371e3, p1=a*Math.PI/180,p2=c*Math.PI/180,dp=(c-a)*Math.PI/180,dl=(d-b)*Math.PI/180;
 const q=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
 return 2*R*Math.atan2(Math.sqrt(q),Math.sqrt(1-q));
}
function etaSeconds(distanceMeters,speedMps){
 const speed=(Number(speedMps)>1?Number(speedMps):6);
 return Math.round(distanceMeters/speed);
}
function formatEta(sec){
 if(sec<60) return "less than 1 min";
 const m=Math.round(sec/60); return `${m} min`;
}
async function getRoadRoute(startLat,startLng,endLat,endLng){
 try{
  const u=`https://router.project-osrm.org/route/v1/driving/${startLng},${startLat};${endLng},${endLat}?overview=full&geometries=geojson&steps=false`;
  const r=await fetch(u,{headers:{"User-Agent":"CollegeRealTimeBusTracking/1.0"}});
  if(!r.ok)return null; const d=await r.json(); if(d.code!=="Ok"||!d.routes?.[0])return null;
  return {geometry:d.routes[0].geometry,distanceMeters:Math.round(d.routes[0].distance),durationSeconds:Math.round(d.routes[0].duration)};
 }catch{return null}
}

app.get("/api/health",(req,res)=>res.json({ok:true,time:now()}));
app.get("/api/destination",(req,res)=>res.json(COLLEGE_DESTINATION));

app.post("/api/login",async(req,res)=>{
 const {userId,password}=req.body||{};
 const u=await db.get("SELECT * FROM users WHERE user_id=?",[String(userId||"").trim()]);
 if(!u || !(await bcrypt.compare(password||"",u.password_hash))) return res.status(401).json({error:"Invalid user ID or password"});
 res.json({token:tokenFor(u),user:{id:u.id,name:u.name,userId:u.user_id,role:u.role}});
});
app.get("/api/me",auth,(req,res)=>res.json({user:req.user}));

app.get("/api/buses",auth,async(req,res)=>{
 const q="SELECT * FROM buses ORDER BY bus_number";
 const rows=await db.all(q);
 for(const b of rows)b.stops=await db.all("SELECT * FROM bus_stops WHERE bus_id=? ORDER BY sequence,id",[b.id]);
 res.json(rows);
});
app.get("/api/drivers",auth,role("admin"),async(req,res)=>res.json(await db.all("SELECT id,name,user_id,document_type,document_number,verified_at FROM users WHERE role='driver' ORDER BY name")));
app.post("/api/drivers",auth,role("admin"),async(req,res)=>{
 const {name,userId,password,documentType,documentNumber}=req.body||{};
 const n=String(name||"").trim(),uid=String(userId||"").trim().toLowerCase(),pw=String(password||"");
 if(!n||!uid||!pw||!String(documentType||"").trim()||!String(documentNumber||"").trim()) return res.status(400).json({error:"Driver name, user ID, password, document type and document number are required"});
 if(!/^[a-z0-9._-]{3,30}$/.test(uid)) return res.status(400).json({error:"User ID must be 3-30 characters using letters, numbers, dot, underscore or hyphen"});
 if(pw.length<8) return res.status(400).json({error:"Driver password must be at least 8 characters"});
 const exists=await db.get("SELECT id FROM users WHERE user_id=?",[uid]);
 if(exists) return res.status(409).json({error:"That user ID is already in use"});
 try{const r=await db.run("INSERT INTO users(name,user_id,password_hash,role,document_type,document_number,verified_at) VALUES(?,?,?,?,?,?,?)",[n,uid,await bcrypt.hash(pw,10),"driver",String(documentType).trim(),String(documentNumber).trim(),now()]);res.json({id:r.lastID,name:n,userId:uid,role:"driver",documentType:String(documentType).trim(),documentNumber:String(documentNumber).trim(),verifiedAt:now()});}catch(e){res.status(400).json({error:"Unable to create driver account"});}
});
app.delete("/api/drivers/:id",auth,role("admin"),async(req,res)=>{const id=Number(req.params.id);const active=await db.get("SELECT id FROM trips WHERE driver_id=? AND status='active'",[id]);if(active)return res.status(400).json({error:"Cannot remove a driver while they have an active trip"});await db.run("DELETE FROM users WHERE id=? AND role='driver'",[id]);res.json({ok:true});});
app.post("/api/student/register",async(req,res)=>{
 const {name,userId,password}=req.body||{}; const n=String(name||"").trim(),uid=String(userId||"").trim().toLowerCase(),pw=String(password||"");
 if(!n||!uid||!pw)return res.status(400).json({error:"Name, user ID and password are required"});
 if(!/^[a-z0-9._-]{3,30}$/.test(uid))return res.status(400).json({error:"User ID must be 3-30 characters using letters, numbers, dot, underscore or hyphen"});
 if(pw.length<8)return res.status(400).json({error:"Password must be at least 8 characters"});
 if(await db.get("SELECT id FROM users WHERE user_id=?",[uid]))return res.status(409).json({error:"That user ID is already in use"});
 const r=await db.run("INSERT INTO users(name,user_id,password_hash,role) VALUES(?,?,?,?)",[n,uid,await bcrypt.hash(pw,10),"passenger"]);
 res.status(201).json({ok:true,id:r.lastID,name:n,userId:uid,role:"passenger"});
});
app.post("/api/buses",auth,role("admin"),async(req,res)=>{
 const {busNumber,registrationNumber,startName,startLat,startLng}=req.body||{};
 if(!String(busNumber||"").trim()||!String(startName||"").trim())return res.status(400).json({error:"Bus number and starting point are required"});
 if(![startLat,startLng].every(Number.isFinite))return res.status(400).json({error:"Valid starting coordinates are required"});
 try{const r=await db.run("INSERT INTO buses(bus_number,registration_number,start_name,start_lat,start_lng,end_name,end_lat,end_lng) VALUES(?,?,?,?,?,?,?,?)",[String(busNumber).trim(),String(registrationNumber||"").trim(),startName,startLat,startLng,COLLEGE_DESTINATION.name,COLLEGE_DESTINATION.lat,COLLEGE_DESTINATION.lng]);res.json(await db.get("SELECT * FROM buses WHERE id=?",[r.lastID]));}
 catch(e){res.status(400).json({error:"Bus number already exists or driver is invalid"});}
});
app.patch("/api/buses/:id",auth,role("admin"),async(req,res)=>{
 const id=Number(req.params.id),{busNumber,registrationNumber,startName,startLat,startLng}=req.body||{};
 if(!String(busNumber||"").trim()||!String(startName||"").trim())return res.status(400).json({error:"Bus number and starting point are required"});
 if(![startLat,startLng].every(Number.isFinite))return res.status(400).json({error:"Valid starting coordinates are required"});
 try{await db.run("UPDATE buses SET bus_number=?,registration_number=?,start_name=?,start_lat=?,start_lng=?,end_name=?,end_lat=?,end_lng=? WHERE id=?",[String(busNumber).trim(),String(registrationNumber||"").trim(),startName,startLat,startLng,COLLEGE_DESTINATION.name,COLLEGE_DESTINATION.lat,COLLEGE_DESTINATION.lng,id]);res.json(await db.get("SELECT * FROM buses WHERE id=?",[id]));}
 catch(e){res.status(400).json({error:"Unable to update bus"});}
});
app.delete("/api/buses/:id",auth,role("admin"),async(req,res)=>{const id=Number(req.params.id);const active=await db.get("SELECT id FROM trips WHERE bus_id=? AND status='active'",[id]);if(active)return res.status(400).json({error:"Cannot delete a bus while it is on an active trip"});await db.run("DELETE FROM buses WHERE id=?",[id]);res.json({ok:true});});
app.get("/api/buses/:id/stops",auth,async(req,res)=>res.json(await db.all("SELECT * FROM bus_stops WHERE bus_id=? ORDER BY sequence,id",[Number(req.params.id)])));
app.post("/api/buses/:id/stops",auth,role("admin"),async(req,res)=>{const busId=Number(req.params.id),{name,lat,lng}=req.body||{};if(!name||!validCoord(lat)||!validLng(lng))return res.status(400).json({error:"Valid stop name and coordinates are required"});const bus=await db.get("SELECT id FROM buses WHERE id=?",[busId]);if(!bus)return res.status(404).json({error:"Bus not found"});const q=await db.get("SELECT COALESCE(MAX(sequence),0)+1 seq FROM bus_stops WHERE bus_id=?",[busId]);const r=await db.run("INSERT INTO bus_stops(bus_id,name,latitude,longitude,sequence) VALUES(?,?,?,?,?)",[busId,name,lat,lng,q.seq]);res.json(await db.get("SELECT * FROM bus_stops WHERE id=?",[r.lastID]));});
app.delete("/api/buses/:busId/stops/:stopId",auth,role("admin"),async(req,res)=>{await db.run("DELETE FROM bus_stops WHERE id=? AND bus_id=?",[Number(req.params.stopId),Number(req.params.busId)]);res.json({ok:true});});

app.post("/api/geocode",auth,async(req,res)=>{
 const q=String(req.body?.q||"").trim();
 if(!q) return res.status(400).json({error:"Search text is required"});
 try{
  const r=await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`,{
    headers:{"User-Agent":"CollegeRealTimeBusTracking/1.0"}
  });
  if(!r.ok) throw new Error("Geocoding failed");
  const data=await r.json();
  res.json(data.map(x=>({name:x.display_name,lat:Number(x.lat),lng:Number(x.lon)})));
 }catch(e){res.status(502).json({error:"Place search unavailable"});}
});

app.post("/api/trips/start",auth,role("driver"),async(req,res)=>{
 const bus=await db.get("SELECT * FROM buses WHERE id=?",[Number(req.body?.busId)]);
 if(!bus)return res.status(404).json({error:"Bus not found"});
 if(bus.status==="on_trip")return res.status(409).json({error:"This bus is already on a trip. Please select another available bus."});
 if(!bus.start_name||!bus.end_name||![bus.start_lat,bus.start_lng,bus.end_lat,bus.end_lng].every(Number.isFinite))return res.status(400).json({error:"Administrator has not completed this bus route configuration"});
 const configuredStops=await db.all("SELECT * FROM bus_stops WHERE bus_id=? ORDER BY sequence,id",[bus.id]);
 await db.run("UPDATE trips SET status='ended',ended_at=? WHERE bus_id=? AND status='active'",[now(),bus.id]);
 await db.run("UPDATE buses SET status='on_trip' WHERE id=?",[bus.id]);
 const route=await getRoadRoute(bus.start_lat,bus.start_lng,bus.end_lat,bus.end_lng);
 const t=await db.run(`INSERT INTO trips(bus_id,driver_id,start_name,start_lat,start_lng,end_name,end_lat,end_lng,status,started_at,route_geometry) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,[bus.id,req.user.id,bus.start_name,bus.start_lat,bus.start_lng,bus.end_name,bus.end_lat,bus.end_lng,"active",now(),route?JSON.stringify(route):null]);
 for(const st of configuredStops)await db.run("INSERT INTO trip_stops(trip_id,name,latitude,longitude,sequence,radius_m) VALUES(?,?,?,?,?,?)",[t.lastID,st.name,st.latitude,st.longitude,st.sequence,st.radius_m||150]);
 await db.run("UPDATE buses SET status='on_trip' WHERE id=?",[bus.id]);
 const trip=await db.get(`SELECT t.*,b.bus_number,b.registration_number,u.name driver_name FROM trips t JOIN buses b ON b.id=t.bus_id JOIN users u ON u.id=t.driver_id WHERE t.id=?`,[t.lastID]);
 trip.route=route;trip.stops=await db.all("SELECT * FROM trip_stops WHERE trip_id=? ORDER BY sequence,id",[t.lastID]);io.emit("trip:started",trip);res.json(trip);
});

app.post("/api/trips/:id/location",auth,role("driver"),async(req,res)=>{
 const id=Number(req.params.id), {latitude,longitude,speed,accuracy}=req.body||{};
 if(!validCoord(latitude)||!validLng(longitude)) return res.status(400).json({error:"Invalid GPS coordinates"});
 const trip=await db.get("SELECT * FROM trips WHERE id=? AND status='active'",[id]);
 if(!trip) return res.status(404).json({error:"Active trip not found"});
 if(trip.driver_id!==req.user.id) return res.status(403).json({error:"This trip is assigned to another driver"});
 const ts=now();
 await db.run(`INSERT INTO gps_locations(trip_id,latitude,longitude,speed,accuracy,timestamp) VALUES(?,?,?,?,?,?)`,
  [id,latitude,longitude,speed??null,accuracy??null,ts]);
 const point={tripId:id,latitude:Number(latitude),longitude:Number(longitude),speed:speed==null?null:Number(speed),
  accuracy:accuracy==null?null:Number(accuracy),timestamp:ts};
 io.emit("gps:update",point);

 // Arrival geofence: 150m, one alert per passenger request/trip.
 const requests=await db.all(`SELECT * FROM passenger_requests
   WHERE trip_id=? AND alerted_at IS NULL`,[id]);
 for(const r of requests){
  const d=hav(Number(latitude),Number(longitude),r.pickup_lat,r.pickup_lng);
  if(d<=150){
   const msg=`Bus has arrived near ${r.pickup_name}.`;
   await db.run("INSERT INTO alerts(user_id,trip_id,request_id,message,created_at) VALUES(?,?,?,?,?)",
     [r.user_id,id,r.id,msg,ts]);
   await db.run("UPDATE passenger_requests SET alerted_at=? WHERE id=?",[ts,r.id]);
   io.to(`passenger:${r.user_id}`).emit("bus:arrived",{requestId:r.id,tripId:id,message:msg,distanceMeters:Math.round(d)});
  }
 }
 res.json(point);
});

app.post("/api/trips/:id/end",auth,role("driver"),async(req,res)=>{
 const id=Number(req.params.id);
 const trip=await db.get("SELECT * FROM trips WHERE id=? AND status='active'",[id]);
 if(!trip) return res.status(404).json({error:"Active trip not found"});
 if(trip.driver_id!==req.user.id) return res.status(403).json({error:"Not your trip"});
 await db.run("UPDATE trips SET status='ended',ended_at=? WHERE id=?",[now(),id]);
 await db.run("UPDATE buses SET status='available' WHERE id=?",[trip.bus_id]);
 io.emit("trip:ended",{tripId:id});
 res.json({ok:true});
});

app.get("/api/trips/active",auth,async(req,res)=>{
 const rows=await db.all(`SELECT t.*,b.bus_number,b.registration_number,u.name driver_name,
   (SELECT json_object('latitude',g.latitude,'longitude',g.longitude,'speed',g.speed,'accuracy',g.accuracy,'timestamp',g.timestamp)
    FROM gps_locations g WHERE g.trip_id=t.id ORDER BY g.id DESC LIMIT 1) latest
   FROM trips t JOIN buses b ON b.id=t.bus_id JOIN users u ON u.id=t.driver_id
   WHERE t.status='active' ORDER BY t.started_at DESC`);
 const out=[];
 for(const x of rows) out.push({...x,latest:x.latest?JSON.parse(x.latest):null,route:x.route_geometry?JSON.parse(x.route_geometry):null,stops:await db.all("SELECT * FROM trip_stops WHERE trip_id=? ORDER BY sequence,id",[x.id])});
 res.json(out);
});

app.get("/api/trips/:id",auth,async(req,res)=>{
 const id=Number(req.params.id);
 const t=await db.get(`SELECT t.*,b.bus_number,b.registration_number,u.name driver_name
   FROM trips t JOIN buses b ON b.id=t.bus_id JOIN users u ON u.id=t.driver_id WHERE t.id=?`,[id]);
 if(!t) return res.status(404).json({error:"Trip not found"});
 const latest=await db.get("SELECT * FROM gps_locations WHERE trip_id=? ORDER BY id DESC LIMIT 1",[id]);
 const stops=await db.all("SELECT * FROM trip_stops WHERE trip_id=? ORDER BY sequence,id",[id]);
 res.json({...t,latest,stops,route:t.route_geometry?JSON.parse(t.route_geometry):null});
});

app.get("/api/trips/:id/stops",auth,async(req,res)=>{ const id=Number(req.params.id); res.json(await db.all("SELECT * FROM trip_stops WHERE trip_id=? ORDER BY sequence,id",[id])); });
app.post("/api/trips/:id/stops",auth,role("driver"),async(req,res)=>{
 const tripId=Number(req.params.id),{name,lat,lng}=req.body||{};
 if(!name||!validCoord(lat)||!validLng(lng))return res.status(400).json({error:"Valid stop name and coordinates are required"});
 const trip=await db.get("SELECT * FROM trips WHERE id=? AND status='active'",[tripId]);
 if(!trip)return res.status(404).json({error:"Active trip not found"}); if(trip.driver_id!==req.user.id)return res.status(403).json({error:"Not your trip"});
 const q=await db.get("SELECT COALESCE(MAX(sequence),0)+1 seq FROM trip_stops WHERE trip_id=?",[tripId]);
 const r=await db.run("INSERT INTO trip_stops(trip_id,name,latitude,longitude,sequence) VALUES(?,?,?,?,?)",[tripId,name,lat,lng,q.seq]);
 const stop=await db.get("SELECT * FROM trip_stops WHERE id=?",[r.lastID]); io.emit("stop:added",stop); res.json(stop);
});
app.delete("/api/trips/:tripId/stops/:stopId",auth,role("driver"),async(req,res)=>{
 const tripId=Number(req.params.tripId),stopId=Number(req.params.stopId); const trip=await db.get("SELECT * FROM trips WHERE id=? AND status='active'",[tripId]);
 if(!trip)return res.status(404).json({error:"Active trip not found"}); if(trip.driver_id!==req.user.id)return res.status(403).json({error:"Not your trip"});
 await db.run("DELETE FROM trip_stops WHERE id=? AND trip_id=?",[stopId,tripId]); res.json({ok:true});
});

app.post("/api/passenger/request",auth,role("passenger"),async(req,res)=>{
 const {pickupName,pickupLat,pickupLng}=req.body||{};
 if(!pickupName||![pickupLat,pickupLng].every(Number.isFinite))
  return res.status(400).json({error:"Complete pickup details are required"});
 const r=await db.run(`INSERT INTO passenger_requests(user_id,pickup_name,pickup_lat,pickup_lng,
  destination_name,destination_lat,destination_lng,created_at) VALUES(?,?,?,?,?,?,?,?)`,
  [req.user.id,pickupName,pickupLat,pickupLng,COLLEGE_DESTINATION.name,COLLEGE_DESTINATION.lat,COLLEGE_DESTINATION.lng,now()]);
 res.json(await db.get("SELECT * FROM passenger_requests WHERE id=?",[r.lastID]));
});

app.get("/api/passenger/trips",auth,role("passenger"),async(req,res)=>{
 const {lat,lng}=req.query;
 if(![lat,lng].every(validCoord)) return res.status(400).json({error:"Valid pickup coordinates are required"});
 const destLat=COLLEGE_DESTINATION.lat, destLng=COLLEGE_DESTINATION.lng;
 const trips=await db.all(`SELECT t.*,b.bus_number,b.registration_number,u.name driver_name,
   g.latitude,g.longitude,g.speed,g.accuracy,g.timestamp
   FROM trips t JOIN buses b ON b.id=t.bus_id JOIN users u ON u.id=t.driver_id
   LEFT JOIN gps_locations g ON g.id=(SELECT id FROM gps_locations WHERE trip_id=t.id ORDER BY id DESC LIMIT 1)
   WHERE t.status='active'`);
 const result=[];
 for(const t of trips){
  const pickupDistance=t.latitude==null?Infinity:hav(Number(t.latitude),Number(t.longitude),Number(lat),Number(lng));
  const destinationDistance=hav(t.end_lat,t.end_lng,Number(destLat),Number(destLng));
  const stops=await db.all("SELECT * FROM trip_stops WHERE trip_id=? ORDER BY sequence,id",[t.id]);
  const nearestPickup=stops.reduce((b,st)=>{const d=hav(st.latitude,st.longitude,Number(lat),Number(lng));return !b||d<b.d?{name:st.name,d}:b},null);
  const nearestDest=stops.reduce((b,st)=>{const d=hav(st.latitude,st.longitude,Number(destLat),Number(destLng));return !b||d<b.d?{name:st.name,d}:b},null);
  const row={...t,pickup_distance_m:Math.round(pickupDistance),destination_distance_m:Math.round(destinationDistance),eta_seconds:t.latitude==null?null:etaSeconds(pickupDistance,t.speed),stops,route:t.route_geometry?JSON.parse(t.route_geometry):null,nearest_pickup_stop:nearestPickup?{name:nearestPickup.name,distance_m:Math.round(nearestPickup.d)}:null,nearest_destination_stop:nearestDest?{name:nearestDest.name,distance_m:Math.round(nearestDest.d)}:null};
  if(destinationDistance<=10000||pickupDistance<=1500||(nearestDest&&nearestDest.d<=1000))result.push(row);
 }
 result.sort((a,b)=>(a.eta_seconds??1e12)-(b.eta_seconds??1e12)); res.json(result);
});

app.get("/api/trips/history",auth,role("admin"),async(req,res)=>{
 const rows=await db.all(`SELECT t.*,b.bus_number,b.registration_number,u.name driver_name,(SELECT COUNT(*) FROM gps_locations g WHERE g.trip_id=t.id) gps_points FROM trips t JOIN buses b ON b.id=t.bus_id JOIN users u ON u.id=t.driver_id ORDER BY t.id DESC LIMIT 100`);
 res.json(rows);
});

app.get("/api/alerts",auth,role("passenger"),async(req,res)=>{
 res.json(await db.all("SELECT * FROM alerts WHERE user_id=? ORDER BY id DESC LIMIT 50",[req.user.id]));
});
app.post("/api/alerts/:id/read",auth,role("passenger"),async(req,res)=>{
 await db.run("UPDATE alerts SET read_at=? WHERE id=? AND user_id=?",[now(),Number(req.params.id),req.user.id]);
 res.json({ok:true});
});

io.on("connection",socket=>{
 socket.on("passenger:subscribe",userId=>{ if(userId) socket.join(`passenger:${Number(userId)}`); });
});

httpServer.listen(PORT, '0.0.0.0', ()=>console.log(`Server running on http://0.0.0.0:${PORT}`));
