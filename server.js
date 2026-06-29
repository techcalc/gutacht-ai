// =====================================================================
//  GutachtAI – Backend (Express)  ·  Phase 2: Login & Kundenkonten
//  Auth über Supabase. Jede Datenanfrage wird auf den angemeldeten
//  Nutzer eingegrenzt (Daten-Trennung pro Kunde).
// =====================================================================

const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const { GoogleGenAI } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

app.use(cors());
app.use(express.json({ limit: '40mb' }));
app.use(express.urlencoded({ extended: true, limit: '40mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, fieldSize: 35 * 1024 * 1024 } });

// --- Env ---
const missingEnv = [];
if (!process.env.GEMINI_API_KEY) missingEnv.push('GEMINI_API_KEY');
if (!process.env.SUPABASE_URL) missingEnv.push('SUPABASE_URL');
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missingEnv.push('SUPABASE_SERVICE_ROLE_KEY');
if (!process.env.SUPABASE_ANON_KEY) missingEnv.push('SUPABASE_ANON_KEY');
if (missingEnv.length) console.warn('WARNUNG – fehlende Env-Variablen: ' + missingEnv.join(', ') + ' (Server läuft trotzdem an)');

const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

function configured() { return !!(ai && supabase); }
function parseGeminiJson(t){ if(!t) throw new Error('Leere KI-Antwort'); return JSON.parse(String(t).replace(/```json/gi,'').replace(/```/g,'').trim()); }
function dataUrlToBuffer(d){ const m=/^data:(image\/[a-zA-Z]+);base64,(.+)$/s.exec(d||''); if(!m) return null; try{return Buffer.from(m[2],'base64');}catch{return null;} }

// --- AUTH-Middleware: prüft den Bearer-Token und setzt req.userId ---
async function requireAuth(req, res, next) {
  if (!configured()) return res.status(503).json({ success:false, error:'Server nicht konfiguriert: ' + missingEnv.join(', ') });
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || null);
  if (!token) return res.status(401).json({ success:false, error:'Nicht angemeldet.' });
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data || !data.user) return res.status(401).json({ success:false, error:'Sitzung ungültig oder abgelaufen.' });
    req.userId = data.user.id;
    req.userEmail = data.user.email || '';
    next();
  } catch (e) {
    return res.status(401).json({ success:false, error:'Authentifizierung fehlgeschlagen.' });
  }
}

// =====================================================================
//  STATIC + SEITEN
// =====================================================================
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_q,r)=>r.sendFile(path.join(__dirname,'public','index.html')));
app.get('/login', (_q,r)=>r.sendFile(path.join(__dirname,'public','login.html')));
app.get('/app', (_q,r)=>r.sendFile(path.join(__dirname,'public','recorder.html')));
app.get('/dashboard', (_q,r)=>r.sendFile(path.join(__dirname,'public','dashboard.html')));
app.get('/health', (_q,r)=>r.json({ ok:true, model:GEMINI_MODEL, configured:configured() }));

// Öffentliche Konfig fürs Frontend (anon key ist bewusst öffentlich)
app.get('/api/config', (_q,r)=>r.json({ url: process.env.SUPABASE_URL || '', anonKey: process.env.SUPABASE_ANON_KEY || '' }));

// =====================================================================
//  1) AUDIO (+FOTOS) -> GEMINI -> SUPABASE  (pro Nutzer)
// =====================================================================
app.post('/api/process-audio', requireAuth, upload.single('audio'), async (req, res) => {
  try {
    const audioFile = req.file;
    const { projectId, projectName, roomOrSection } = req.body;
    let photos = []; try { photos = req.body.photos ? JSON.parse(req.body.photos) : []; } catch {}
    if (!audioFile || !projectId) return res.status(400).json({ success:false, error:'Audio oder Projekt-ID fehlt.' });

    const mimeType = (audioFile.mimetype && audioFile.mimetype !== 'application/octet-stream') ? audioFile.mimetype : 'audio/webm';
    const prompt = `Du bist ein KI-Assistent für Bausachverständige. Deine Aufgabe ist NUR das Strukturieren des Gesagten – KEIN Hinzudichten.

Strikte Regeln:
- Verwende AUSSCHLIESSLICH Informationen, die im Audio tatsächlich genannt werden.
- Erfinde KEINE Ursachen, Maßnahmen, Maße, Normen oder Dringlichkeiten dazu.
- Wurde etwas nicht gesagt, schreibe wörtlich "Vom Gutachter zu prüfen".
- Umgangssprache darfst du in sachliche Fachsprache überführen, den Inhalt aber NICHT erweitern.

Gib AUSSCHLIESSLICH valides JSON in exakt diesem Format zurück (kein Markdown, keine weiteren Felder):
{
  "titel": "Kurzer Titel aus dem Gesagten (max. 6 Wörter)",
  "befund": "Sachliche Wiedergabe NUR des Gesagten in Fachsprache",
  "ursache": "Nur wenn genannt, sonst 'Vom Gutachter zu prüfen'",
  "dringlichkeit": "Hoch | Mittel | Niedrig – nur wenn klar erkennbar, sonst 'Mittel'",
  "massnahme": "Nur wenn genannt, sonst 'Vom Gutachter zu prüfen'"
}`;

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [ { text: prompt }, { inlineData: { mimeType, data: audioFile.buffer.toString('base64') } } ],
      config: { responseMimeType: 'application/json' },
    });
    const structured = parseGeminiJson(response.text);

    const { data, error } = await supabase.from('reports').insert({
      user_id: req.userId,
      project_id: projectId, project_name: projectName || projectId,
      room_or_section: roomOrSection || 'Allgemein',
      raw_transcript: 'Direkt via Gemini-Audio verarbeitet',
      structured_content: structured, photos,
    }).select();
    if (error) throw error;
    return res.json({ success:true, data, befund:structured });
  } catch (e) { console.error('process-audio:', e); return res.status(500).json({ success:false, error:e.message }); }
});

// =====================================================================
//  2) PROJEKTE + 3) BEFUNDE  (nur eigene)
// =====================================================================
app.get('/api/projects', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('reports')
      .select('project_id, project_name, created_at').eq('user_id', req.userId)
      .order('created_at', { ascending:false });
    if (error) throw error;
    const map = new Map();
    (data||[]).forEach(r=>{ if(!map.has(r.project_id)) map.set(r.project_id,{project_id:r.project_id,project_name:r.project_name||r.project_id,count:0,last:r.created_at}); const e=map.get(r.project_id); e.count++; if(r.created_at>e.last)e.last=r.created_at; });
    return res.json({ success:true, data:Array.from(map.values()) });
  } catch (e) { console.error('projects:', e); return res.status(500).json({ success:false, error:e.message }); }
});

app.get('/api/reports', requireAuth, async (req, res) => {
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ success:false, error:'projectId fehlt.' });
    const { data, error } = await supabase.from('reports').select('*')
      .eq('user_id', req.userId).eq('project_id', projectId).order('created_at', { ascending:true });
    if (error) throw error;
    return res.json({ success:true, data:data||[] });
  } catch (e) { console.error('reports:', e); return res.status(500).json({ success:false, error:e.message }); }
});

// =====================================================================
//  4) BEFUND bearbeiten / löschen  (nur eigene)
// =====================================================================
app.post('/api/update-report', requireAuth, async (req, res) => {
  try {
    const { id, room_or_section, structured_content } = req.body;
    if (!id) return res.status(400).json({ success:false, error:'id fehlt.' });
    const { data, error } = await supabase.from('reports')
      .update({ room_or_section, structured_content }).eq('id', id).eq('user_id', req.userId).select();
    if (error) throw error;
    return res.json({ success:true, data });
  } catch (e) { console.error('update-report:', e); return res.status(500).json({ success:false, error:e.message }); }
});

app.post('/api/delete-report', requireAuth, async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success:false, error:'id fehlt.' });
    const { error } = await supabase.from('reports').delete().eq('id', id).eq('user_id', req.userId);
    if (error) throw error;
    return res.json({ success:true });
  } catch (e) { console.error('delete-report:', e); return res.status(500).json({ success:false, error:e.message }); }
});

// =====================================================================
//  5) PROFIL & LOGO  (pro Nutzer)
// =====================================================================
const DEFAULTS = { company_name:'', gutachter_name:'', address:'', phone:'', email:'', website:'', logo:'', accent_color:'#E0922F', footer_note:'' };

app.get('/api/settings', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('settings').select('*').eq('user_id', req.userId).maybeSingle();
    if (error) throw error;
    return res.json({ success:true, data: data || { ...DEFAULTS, user_id:req.userId } });
  } catch (e) { console.error('settings get:', e); return res.status(500).json({ success:false, error:e.message }); }
});

app.post('/api/settings', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const row = {
      user_id: req.userId,
      company_name:b.company_name||'', gutachter_name:b.gutachter_name||'', address:b.address||'',
      phone:b.phone||'', email:b.email||'', website:b.website||'', logo:b.logo||'',
      accent_color:b.accent_color||'#E0922F', footer_note:b.footer_note||'', updated_at:new Date().toISOString(),
    };
    const { data, error } = await supabase.from('settings').upsert(row, { onConflict:'user_id' }).select();
    if (error) throw error;
    return res.json({ success:true, data });
  } catch (e) { console.error('settings post:', e); return res.status(500).json({ success:false, error:e.message }); }
});

// =====================================================================
//  6) PROFI-PDF  (nur eigene Projekte)
// =====================================================================
function buildPdf(res, reports, settings, projectName) {
  const accent = (settings.accent_color && /^#[0-9a-fA-F]{6}$/.test(settings.accent_color)) ? settings.accent_color : '#E0922F';
  const ink='#23211D', muted='#797469', line='#E2DED4';
  const M=50, W=595.28, RIGHT=W-M;
  const doc = new PDFDocument({ size:'A4', margin:M, bufferPages:true });
  doc.pipe(res);

  let headerBottom = M;
  const logoBuf = dataUrlToBuffer(settings.logo);
  if (logoBuf) { try { doc.image(logoBuf, M, M, { fit:[120,60] }); } catch(e){} }
  const infoX=300, infoW=RIGHT-infoX;
  doc.font('Helvetica-Bold').fontSize(11).fillColor(ink).text(settings.company_name||'Sachverständigenbüro', infoX, M, { width:infoW, align:'right' });
  doc.font('Helvetica').fontSize(8.5).fillColor(muted);
  const infoLines=[settings.gutachter_name,settings.address,settings.phone,settings.email,settings.website].filter(Boolean).join('\n');
  if (infoLines) doc.text(infoLines, infoX, doc.y+2, { width:infoW, align:'right' });
  headerBottom = Math.max(M+64, doc.y)+14;
  doc.save().moveTo(M,headerBottom).lineTo(RIGHT,headerBottom).lineWidth(2).strokeColor(accent).stroke().restore();

  let y = headerBottom+22;
  doc.font('Helvetica').fontSize(9).fillColor(accent).text('MÄNGELPROTOKOLL', M, y, { characterSpacing:2 });
  y = doc.y+2;
  doc.font('Helvetica-Bold').fontSize(20).fillColor(ink).text(projectName||'Projekt', M, y, { width:RIGHT-M });
  y = doc.y+6;
  doc.font('Helvetica').fontSize(9).fillColor(muted).text(`Erstellt am ${new Date().toLocaleDateString('de-DE')}  ·  ${reports.length} Befund(e)`, M, y);
  y = doc.y+18;

  const urgColor = u => u==='Hoch'?'#C0492B':(u==='Niedrig'?'#2F6F62':accent);
  reports.forEach((r,i)=>{
    const c=r.structured_content||{};
    if (y>690){ doc.addPage(); y=M; }
    doc.save().roundedRect(M,y,26,18,3).fill(accent).restore();
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#FFFFFF').text(String(i+1).padStart(2,'0'), M, y+4.5, { width:26, align:'center' });
    doc.font('Helvetica-Bold').fontSize(12).fillColor(ink).text(`${r.room_or_section||'Allgemein'}${c.titel?' — '+c.titel:''}`, M+34, y+2, { width:RIGHT-M-34-70 });
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(urgColor(c.dringlichkeit)).text((c.dringlichkeit||'Mittel').toUpperCase(), RIGHT-70, y+4, { width:70, align:'right', characterSpacing:1 });
    y = Math.max(y+24, doc.y+6);
    const block=(l,v)=>{ if(!v) return; doc.font('Helvetica-Bold').fontSize(7.5).fillColor(muted).text(l.toUpperCase(), M+34, y, { characterSpacing:1 }); y=doc.y+1; doc.font('Helvetica').fontSize(10).fillColor(ink).text(v, M+34, y, { width:RIGHT-M-34 }); y=doc.y+8; };
    block('Befund',c.befund); block('Ursache',c.ursache); block('Empfohlene Maßnahme',c.massnahme);
    const photos = Array.isArray(r.photos)?r.photos:[];
    if (photos.length){ const pw=150,ph=110,gap=10; let px=M+34;
      photos.slice(0,3).forEach(p=>{ const buf=dataUrlToBuffer(p); if(!buf) return; if(y+ph>770){doc.addPage();y=M;px=M+34;}
        try{ doc.save().roundedRect(px,y,pw,ph,4).clip(); doc.image(buf,px,y,{cover:[pw,ph]}); doc.restore(); doc.roundedRect(px,y,pw,ph,4).lineWidth(.5).strokeColor(line).stroke(); }catch(e){}
        px+=pw+gap; if(px+pw>RIGHT){px=M+34;y+=ph+gap;} });
      if (px!==M+34) y+=ph+gap; y+=2;
    }
    if (y>740){ doc.addPage(); y=M; } else { doc.save().moveTo(M,y).lineTo(RIGHT,y).lineWidth(.5).strokeColor(line).stroke().restore(); y+=16; }
  });
  if (!reports.length) doc.font('Helvetica').fontSize(11).fillColor(muted).text('Noch keine Befunde in diesem Projekt erfasst.', M, y);

  const range = doc.bufferedPageRange();
  for (let p=0;p<range.count;p++){ doc.switchToPage(range.start+p); const fy=802;
    doc.save().moveTo(M,fy).lineTo(RIGHT,fy).lineWidth(.5).strokeColor(line).stroke().restore();
    doc.font('Helvetica').fontSize(7.5).fillColor(muted);
    doc.text(settings.footer_note||settings.company_name||'Erstellt mit GutachtAI', M, fy+6, { width:380 });
    doc.text(`Seite ${p+1} / ${range.count}`, RIGHT-120, fy+6, { width:120, align:'right' });
  }
  doc.end();
}

app.get('/api/generate-pdf', requireAuth, async (req, res) => {
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ success:false, error:'projectId fehlt.' });
    const [{ data:reports, error:e1 }, { data:settings, error:e2 }] = await Promise.all([
      supabase.from('reports').select('*').eq('user_id', req.userId).eq('project_id', projectId).order('created_at',{ascending:true}),
      supabase.from('settings').select('*').eq('user_id', req.userId).maybeSingle(),
    ]);
    if (e1) throw e1; if (e2) throw e2;
    const projectName = (reports && reports[0] && reports[0].project_name) || projectId;
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`attachment; filename="Maengelprotokoll_${projectId}.pdf"`);
    buildPdf(res, reports||[], settings||DEFAULTS, projectName);
  } catch (e) { console.error('generate-pdf:', e); if(!res.headersSent) res.status(500).json({ success:false, error:e.message }); }
});

app.listen(PORT, '0.0.0.0', () => console.log(`GutachtAI (Phase 2 · Login) läuft auf Port ${PORT}  (Model: ${GEMINI_MODEL})`));
