// =====================================================================
//  GutachtAI – Backend (Express)  ·  Phase 1
//  Homepage + Recorder + Dashboard + Profil/Logo + anpassbares Profi-PDF
// =====================================================================

const path = require('path');
const express = require('express');
const cors = require('cors');
const PDFDocument = require('pdfkit');
const { GoogleGenAI } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

app.use(cors());
// Großzügiges Limit: Fotos kommen als base64 im Body mit
app.use(express.json({ limit: '40mb' }));
app.use(express.urlencoded({ extended: true, limit: '40mb' }));

const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, fieldSize: 35 * 1024 * 1024 } });

// ---------------------------------------------------------------------
//  Env-Check ohne Crash
// ---------------------------------------------------------------------
const missingEnv = [];
if (!process.env.GEMINI_API_KEY) missingEnv.push('GEMINI_API_KEY');
if (!process.env.SUPABASE_URL) missingEnv.push('SUPABASE_URL');
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missingEnv.push('SUPABASE_SERVICE_ROLE_KEY');
if (missingEnv.length) {
  console.warn('WARNUNG – fehlende Env-Variablen: ' + missingEnv.join(', ') + ' (Server läuft trotzdem an)');
}

const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

function ensureClients(res) {
  if (!ai || !supabase) {
    res.status(503).json({ success: false, error: 'Server nicht konfiguriert. Fehlende Variablen: ' + (missingEnv.join(', ') || 'unbekannt') });
    return false;
  }
  return true;
}

function parseGeminiJson(text) {
  if (!text) throw new Error('Leere KI-Antwort');
  const clean = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
  return JSON.parse(clean);
}

function dataUrlToBuffer(d) {
  const m = /^data:(image\/[a-zA-Z]+);base64,(.+)$/s.exec(d || '');
  if (!m) return null;
  try { return Buffer.from(m[2], 'base64'); } catch { return null; }
}

// =====================================================================
//  STATIC + SEITEN-ROUTEN
// =====================================================================
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/app', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'recorder.html')));
app.get('/dashboard', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/health', (_req, res) => res.json({ ok: true, model: GEMINI_MODEL, configured: !!(ai && supabase) }));

// =====================================================================
//  1) AUDIO (+ FOTOS) -> GEMINI -> SUPABASE
// =====================================================================
app.post('/api/process-audio', upload.single('audio'), async (req, res) => {
  if (!ensureClients(res)) return;
  try {
    const audioFile = req.file;
    const { projectId, projectName, roomOrSection } = req.body;
    let photos = [];
    try { photos = req.body.photos ? JSON.parse(req.body.photos) : []; } catch { photos = []; }

    if (!audioFile || !projectId) {
      return res.status(400).json({ success: false, error: 'Audio oder Projekt-ID fehlt.' });
    }

    const mimeType = (audioFile.mimetype && audioFile.mimetype !== 'application/octet-stream')
      ? audioFile.mimetype : 'audio/webm';

    const prompt = `Du bist ein präziser KI-Assistent für Bausachverständige.
Höre dir das Audio genau an und erstelle einen strukturierten Baumangel-Befund.
Gib AUSSCHLIESSLICH valides JSON in exakt diesem Format zurück (kein Markdown, keine weiteren Felder):
{
  "titel": "Kurzer Titel des Mangels (max. 6 Wörter)",
  "befund": "Sachliche, fachlich präzise Beschreibung des Mangels im Gutachter-Jargon",
  "ursache": "Mutmaßliche Ursache (oder 'Noch zu prüfen')",
  "dringlichkeit": "Hoch | Mittel | Niedrig",
  "massnahme": "Konkrete, fachgerechte Sanierungsempfehlung"
}`;

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        { text: prompt },
        { inlineData: { mimeType, data: audioFile.buffer.toString('base64') } },
      ],
      config: { responseMimeType: 'application/json' },
    });

    const structured = parseGeminiJson(response.text);

    const { data, error: dbError } = await supabase
      .from('reports')
      .insert({
        project_id: projectId,
        project_name: projectName || projectId,
        room_or_section: roomOrSection || 'Allgemein',
        raw_transcript: 'Direkt via Gemini-Audio verarbeitet',
        structured_content: structured,
        photos: photos,
      })
      .select();

    if (dbError) throw dbError;
    return res.json({ success: true, data, befund: structured });
  } catch (error) {
    console.error('process-audio:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// =====================================================================
//  2) PROJEKTE (gruppiert) + 3) BEFUNDE EINES PROJEKTS
// =====================================================================
app.get('/api/projects', async (_req, res) => {
  if (!ensureClients(res)) return;
  try {
    const { data, error } = await supabase
      .from('reports')
      .select('project_id, project_name, created_at')
      .order('created_at', { ascending: false });
    if (error) throw error;

    const map = new Map();
    (data || []).forEach((r) => {
      const key = r.project_id;
      if (!map.has(key)) {
        map.set(key, { project_id: key, project_name: r.project_name || key, count: 0, last: r.created_at });
      }
      const e = map.get(key);
      e.count += 1;
      if (r.created_at > e.last) e.last = r.created_at;
    });
    return res.json({ success: true, data: Array.from(map.values()) });
  } catch (error) {
    console.error('projects:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/reports', async (req, res) => {
  if (!ensureClients(res)) return;
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ success: false, error: 'projectId fehlt.' });
    const { data, error } = await supabase
      .from('reports').select('*').eq('project_id', projectId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return res.json({ success: true, data: data || [] });
  } catch (error) {
    console.error('reports:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// =====================================================================
//  4) BEFUND BEARBEITEN
// =====================================================================
app.post('/api/update-report', async (req, res) => {
  if (!ensureClients(res)) return;
  try {
    const { id, room_or_section, structured_content } = req.body;
    if (!id) return res.status(400).json({ success: false, error: 'id fehlt.' });
    const { data, error } = await supabase
      .from('reports').update({ room_or_section, structured_content }).eq('id', id).select();
    if (error) throw error;
    return res.json({ success: true, data });
  } catch (error) {
    console.error('update-report:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/delete-report', async (req, res) => {
  if (!ensureClients(res)) return;
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, error: 'id fehlt.' });
    const { error } = await supabase.from('reports').delete().eq('id', id);
    if (error) throw error;
    return res.json({ success: true });
  } catch (error) {
    console.error('delete-report:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// =====================================================================
//  5) PROFIL & LOGO (Gutachter-Stammdaten, eine Zeile)
// =====================================================================
const DEFAULT_SETTINGS = {
  id: 'default', company_name: '', gutachter_name: '', address: '',
  phone: '', email: '', website: '', logo: '', accent_color: '#E0922F', footer_note: '',
};

app.get('/api/settings', async (_req, res) => {
  if (!ensureClients(res)) return;
  try {
    const { data, error } = await supabase.from('settings').select('*').eq('id', 'default').maybeSingle();
    if (error) throw error;
    return res.json({ success: true, data: data || DEFAULT_SETTINGS });
  } catch (error) {
    console.error('settings get:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/settings', async (req, res) => {
  if (!ensureClients(res)) return;
  try {
    const b = req.body || {};
    const row = {
      id: 'default',
      company_name: b.company_name || '', gutachter_name: b.gutachter_name || '',
      address: b.address || '', phone: b.phone || '', email: b.email || '',
      website: b.website || '', logo: b.logo || '', accent_color: b.accent_color || '#E0922F',
      footer_note: b.footer_note || '', updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabase.from('settings').upsert(row, { onConflict: 'id' }).select();
    if (error) throw error;
    return res.json({ success: true, data });
  } catch (error) {
    console.error('settings post:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// =====================================================================
//  6) PROFI-PDF  (Logo + Stammdaten + Fotos + Akzentfarbe)
// =====================================================================
function buildPdf(res, reports, settings, projectName) {
  const accent = (settings.accent_color && /^#[0-9a-fA-F]{6}$/.test(settings.accent_color)) ? settings.accent_color : '#E0922F';
  const ink = '#23211D', muted = '#797469', line = '#E2DED4';
  const M = 50, W = 595.28, RIGHT = W - M;

  const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true });
  doc.pipe(res);

  // ---------- KOPF ----------
  let headerBottom = M;
  const logoBuf = dataUrlToBuffer(settings.logo);
  if (logoBuf) {
    try { doc.image(logoBuf, M, M, { fit: [120, 60] }); } catch (e) {}
  }
  // rechte Spalte: Firma/Gutachter
  const infoX = 300, infoW = RIGHT - infoX;
  doc.font('Helvetica-Bold').fontSize(11).fillColor(ink)
    .text(settings.company_name || 'Sachverständigenbüro', infoX, M, { width: infoW, align: 'right' });
  doc.font('Helvetica').fontSize(8.5).fillColor(muted);
  const infoLines = [settings.gutachter_name, settings.address, settings.phone, settings.email, settings.website]
    .filter(Boolean).join('\n');
  if (infoLines) doc.text(infoLines, infoX, doc.y + 2, { width: infoW, align: 'right' });

  headerBottom = Math.max(M + 64, doc.y) + 14;
  doc.save().moveTo(M, headerBottom).lineTo(RIGHT, headerBottom).lineWidth(2).strokeColor(accent).stroke().restore();

  // ---------- TITELBLOCK ----------
  let y = headerBottom + 22;
  doc.font('Helvetica').fontSize(9).fillColor(accent).text('MÄNGELPROTOKOLL', M, y, { characterSpacing: 2 });
  y = doc.y + 2;
  doc.font('Helvetica-Bold').fontSize(20).fillColor(ink).text(projectName || 'Projekt', M, y, { width: RIGHT - M });
  y = doc.y + 6;
  doc.font('Helvetica').fontSize(9).fillColor(muted)
    .text(`Erstellt am ${new Date().toLocaleDateString('de-DE')}  ·  ${reports.length} Befund(e)`, M, y);
  y = doc.y + 18;

  // ---------- BEFUNDE ----------
  const urgencyColor = (u) => u === 'Hoch' ? '#C0492B' : (u === 'Niedrig' ? '#2F6F62' : accent);

  reports.forEach((r, i) => {
    const c = r.structured_content || {};
    if (y > 690) { doc.addPage(); y = M; }

    // Nummern-Marker
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#FFFFFF');
    doc.save().roundedRect(M, y, 26, 18, 3).fill(accent).restore();
    doc.fillColor('#FFFFFF').text(String(i + 1).padStart(2, '0'), M, y + 4.5, { width: 26, align: 'center' });

    // Bereich + Dringlichkeit
    doc.font('Helvetica-Bold').fontSize(12).fillColor(ink)
      .text(`${r.room_or_section || 'Allgemein'}${c.titel ? ' — ' + c.titel : ''}`, M + 34, y + 2, { width: RIGHT - M - 34 - 70 });
    const uc = urgencyColor(c.dringlichkeit);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(uc)
      .text((c.dringlichkeit || 'Mittel').toUpperCase(), RIGHT - 70, y + 4, { width: 70, align: 'right', characterSpacing: 1 });
    y = Math.max(y + 24, doc.y + 6);

    const block = (label, value) => {
      if (!value) return;
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(muted).text(label.toUpperCase(), M + 34, y, { characterSpacing: 1 });
      y = doc.y + 1;
      doc.font('Helvetica').fontSize(10).fillColor(ink).text(value, M + 34, y, { width: RIGHT - M - 34 });
      y = doc.y + 8;
    };
    block('Befund', c.befund);
    block('Ursache', c.ursache);
    block('Empfohlene Maßnahme', c.massnahme);

    // Fotos
    const photos = Array.isArray(r.photos) ? r.photos : [];
    if (photos.length) {
      const pw = 150, ph = 110, gap = 10;
      let px = M + 34;
      photos.slice(0, 3).forEach((p) => {
        const buf = dataUrlToBuffer(p);
        if (!buf) return;
        if (y + ph > 770) { doc.addPage(); y = M; px = M + 34; }
        try {
          doc.save().roundedRect(px, y, pw, ph, 4).clip();
          doc.image(buf, px, y, { cover: [pw, ph] });
          doc.restore();
          doc.roundedRect(px, y, pw, ph, 4).lineWidth(0.5).strokeColor(line).stroke();
        } catch (e) {}
        px += pw + gap;
        if (px + pw > RIGHT) { px = M + 34; y += ph + gap; }
      });
      if (px !== M + 34) y += ph + gap;
      y += 2;
    }

    // Trennlinie
    if (y > 740) { doc.addPage(); y = M; }
    else {
      doc.save().moveTo(M, y).lineTo(RIGHT, y).lineWidth(0.5).strokeColor(line).stroke().restore();
      y += 16;
    }
  });

  if (reports.length === 0) {
    doc.font('Helvetica').fontSize(11).fillColor(muted).text('Noch keine Befunde in diesem Projekt erfasst.', M, y);
  }

  // ---------- FUSSZEILE (alle Seiten) ----------
  const range = doc.bufferedPageRange();
  for (let p = 0; p < range.count; p++) {
    doc.switchToPage(range.start + p);
    const fy = 802;
    doc.save().moveTo(M, fy).lineTo(RIGHT, fy).lineWidth(0.5).strokeColor(line).stroke().restore();
    doc.font('Helvetica').fontSize(7.5).fillColor(muted);
    const footL = settings.footer_note || settings.company_name || 'Erstellt mit GutachtAI';
    doc.text(footL, M, fy + 6, { width: 380 });
    doc.text(`Seite ${p + 1} / ${range.count}`, RIGHT - 120, fy + 6, { width: 120, align: 'right' });
  }

  doc.end();
}

app.get('/api/generate-pdf', async (req, res) => {
  if (!ensureClients(res)) return;
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ success: false, error: 'projectId fehlt.' });

    const [{ data: reports, error: e1 }, { data: settings, error: e2 }] = await Promise.all([
      supabase.from('reports').select('*').eq('project_id', projectId).order('created_at', { ascending: true }),
      supabase.from('settings').select('*').eq('id', 'default').maybeSingle(),
    ]);
    if (e1) throw e1;
    if (e2) throw e2;

    const projectName = (reports && reports[0] && reports[0].project_name) || projectId;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Maengelprotokoll_${projectId}.pdf"`);
    buildPdf(res, reports || [], settings || DEFAULT_SETTINGS, projectName);
  } catch (error) {
    console.error('generate-pdf:', error);
    if (!res.headersSent) res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`GutachtAI läuft auf Port ${PORT}  (Model: ${GEMINI_MODEL})`);
});
