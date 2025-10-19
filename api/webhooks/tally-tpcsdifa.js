// api/webhooks/tally-tpcsdifa.js
// CommonJS (module.exports) – compatible Vercel Node runtime

// ----------------------
// util: retirer accents + passer en minuscule
function normalize(str) {
  return (str || "")
    .toString()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

// ----------------------
console.log("ENV DEBUG:", {
  has_SMTP_USER: !!process.env.SMTP_USER,
  has_SMTP_PASS: !!process.env.SMTP_PASS,
  from_email: process.env.FROM_EMAIL || null
});

// Envoi d'e-mail via Gmail (SMTP) avec nodemailer
async function sendEmail(to, subject, text) {
  try {
    const user = process.env.SMTP_USER;   // ex: "startdifa@gmail.com"
    const pass = process.env.SMTP_PASS;   // mot de passe d’application (16 caractères)
    const from = process.env.FROM_EMAIL || `DIFA <${user}>`;

    if (!user || !pass) {
      console.error("EMAIL DESACTIVE : SMTP_USER ou SMTP_PASS manquant");
      return false;
    }

    const nodemailer = require("nodemailer");
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user, pass }
    });

    const info = await transporter.sendMail({ from, to, subject, text });
    console.log("GMAIL ENVOYE :", info.messageId);
    return true;
  } catch (e) {
    console.error("ERREUR ENVOI GMAIL :", e);
    return false;
  }
}


// ----------------------
// ---------------- TPCS-DIFA — CALCUL OFFICIEL (L/A/R/C) ----------------

/** Choix du tie-break si un score = 0.
 *  Par défaut: on tranche avec D6 (règle v3.1).
 *  Pour d'abord trancher avec D5 puis D6 en secours, remplace par: ["D5","D6"].
 */
const TIE_BREAK_ORDER = ["D6"];

/** Convertit les 24 LINEAR_SCALE Tally en {1..24: -3..+3} */
function extractAnswersFromTallyFields(fields) {
  const scales = fields.filter(f => f.type === "LINEAR_SCALE");
  if (scales.length < 24) {
    throw new Error(`Pas assez d'items LINEAR_SCALE (trouvés: ${scales.length}, attendus: 24)`);
  }
  const answers = {};
  for (let i = 1; i <= 24; i++) {
    const v = Number(scales[i-1].value ?? 0);
    if (v < -3 || v > 3) throw new Error(`Item ${i}: valeur hors plage ${v}`);
    answers[i] = v;
  }
  return answers;
}

/** Calcul complet (scores, code L/A/R/C, famille/type 16-profils) */
function scoreTPCS_LARC(answers) {
  const inv = new Set([2,4,6,8,10,12,14,16,18,20,22,24]);
  const v = (i) => inv.has(i) ? -(Number(answers[i] ?? 0)) : Number(answers[i] ?? 0);

  // Sommes par dimension
  const D1 = v(1)+v(2)+v(3)+v(4);       // Attention: L vs F
  const D2 = v(5)+v(6)+v(7)+v(8);       // Récompense: A vs I
  const D3 = v(9)+v(10)+v(11)+v(12);    // Émotion: R vs E
  const D4 = v(13)+v(14)+v(15)+v(16);   // Décision: C vs D
  const D5 = v(17)+v(18)+v(19)+v(20);   // Contexte
  const D6 = v(21)+v(22)+v(23)+v(24);   // Introspection

  // Polarités (L/A/R/C) avec "OU" si 0
  const pole = (s, pos, neg) => s>0 ? pos : (s<0 ? neg : "OU");

  let L1 = pole(D1, "L", "F"); // Large vs Focalisé
  let L2 = pole(D2, "A", "I"); // Activé vs Inhibé
  let L3 = pole(D3, "R", "E"); // Régulés vs Réactifs
  let L4 = pole(D4, "C", "D"); // Constructifs vs Défensifs

  // Tie-breaks si "OU"
  const tiePick = (neutralLetter, pos, neg) => {
    if (neutralLetter !== "OU") return neutralLetter;
    for (const key of TIE_BREAK_ORDER) {
      const s = (key === "D5" ? D5 : D6);
      if (s > 0) return pos;
      if (s < 0) return neg;
    }
    return neutralLetter; // reste "OU" si tout est neutre
  };

  L1 = tiePick(L1, "L", "F");
  L2 = tiePick(L2, "A", "I");
  L3 = tiePick(L3, "R", "E");
  L4 = tiePick(L4, "C", "D");

  const code_4L = `${L1}${L2}${L3}${L4}`; // ex: LIRD

  // Famille (D1×D2)
  // L+A = Dynamiques | L+I = Inspirés | F+A = Centrés | F+I = Réceptifs
  let famille;
  if (L1 === "L" && L2 === "A") famille = "Dynamique";
  else if (L1 === "L" && L2 === "I") famille = "Inspiré";
  else if (L1 === "F" && L2 === "A") famille = "Centré";
  else if (L1 === "F" && L2 === "I") famille = "Réceptif";
  else famille = "Indéterminé"; // cas rare si "OU" subsiste

  // Type (D3×D4)
  // R+C = Alpha | R+D = Beta | E+C = Gamma | E+D = Delta
  let type;
  if (L3 === "R" && L4 === "C") type = "Alpha";
  else if (L3 === "R" && L4 === "D") type = "Beta";
  else if (L3 === "E" && L4 === "C") type = "Gamma";
  else if (L3 === "E" && L4 === "D") type = "Delta";
  else type = "Mixte";

  return {
    code_4L,                              // ex: "LIRD"
    famille,                              // ex: "Inspiré"
    type,                                 // ex: "Beta"
    scores: { D1, D2, D3, D4, D5, D6 },   // sommes -12..+12
    letters: { D1: L1, D2: L2, D3: L3, D4: L4 } // lettres finales
  };
}

// ----------------------
// Handler HTTP (CommonJS)
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method Not Allowed");
  }

  // DEBUG : log du payload reçu (visible dans Vercel > Journaux d’exécution)
  try { console.log("TALLY RAW BODY:", JSON.stringify(req.body)); } catch {}

  try {
    const body = req.body || {};
    const data = body.data || {};
    const fields = Array.isArray(data.fields) ? data.fields : [];

    // 1) Email — chercher dans data.fields (INPUT_EMAIL ou label contenant 'mail')
    let email = null;
    for (const f of fields) {
      const lbl = (f.label || "").toString();
      if (f.type === "INPUT_EMAIL" || /mail/i.test(lbl)) {
        email = f.value;
        break;
      }
    }
    if (!email) {
      console.warn("DEBUG: Missing email in fields[]");
      return res.status(400).json({ ok: false, error: "Missing email (fields)" });
    }

    // (optionnel) Prénom pour personnaliser l’email
    const firstNameField = fields.find(f => f.type === "INPUT_TEXT" && /pr[ée]nom/i.test(f.label || ""));
    const firstName = firstNameField?.value || "";

    // 2) Réponses — prendre les 24 premiers LINEAR_SCALE dans l'ordre
    const scaleItems = fields.filter(f => f.type === "LINEAR_SCALE");
    if (scaleItems.length < 24) {
      console.warn("DEBUG: Not enough LINEAR_SCALE items:", scaleItems.length);
      return res.status(400).json({
        ok: false,
        error: `Need 24 LINEAR_SCALE items, got ${scaleItems.length}`
      });
    }

    // Construire answers { "1": int, ..., "24": int }
    const answers = {};
    for (let i = 0; i < 24; i++) {
      const v = Number(scaleItems[i].value);
      if (!Number.isFinite(v) || v < -3 || v > 3) {
        console.warn("DEBUG: Invalid LINEAR_SCALE value at index", i, "raw:", scaleItems[i].value);
        return res.status(400).json({
          ok: false,
          error: `Invalid LINEAR_SCALE at #${i+1}`,
          raw: scaleItems[i].value
        });
      }
      answers[String(i + 1)] = v;
    }

       // 3) Calcul TPCS (version définitive L/A/R/C + 16 types)
    const respondentId = data.respondentId || data.submissionId || body.submissionId || "unknown";
    let prof;
    try {
      prof = scoreTPCS_LARC_fromAnswers(answers); // <-- utilise le answers que tu viens de construire
      console.log("TPCS LARC RESULT:", { respondentId, ...prof });
    } catch (e) {
      console.error("TPCS SCORE ERROR:", e && e.message);
      return res.status(400).json({ ok: false, error: "TPCS_SCORE_ERROR", detail: e && e.message });
    }

    // 4) Email (personnalisation minimale L/A/R/C)
    const subject = `Ton profil TPCS-DIFA : ${prof.famille} ${prof.type} – ${prof.code_4L}`;
    const text =
`Bonjour ${firstName || ""},

Voici ton résultat TPCS-DIFA :
- Code : ${prof.code_4L}
- Famille : ${prof.famille}
- Type : ${prof.type}

Scores:
D1=${prof.scores.D1} (Attention), D2=${prof.scores.D2} (Récompense),
D3=${prof.scores.D3} (Émotion),  D4=${prof.scores.D4} (Décision),
D5=${prof.scores.D5} (Contexte), D6=${prof.scores.D6} (Introspection)

Nous te recontacterons très vite avec une interprétation détaillée et des micro-actions adaptées.

— Équipe DIFA`;

    const okSend = await sendEmail(email, subject, text);
    if (!okSend) {
      console.error("EMAIL_SEND_FAILED for", email);
      return res.status(500).json({ ok: false, error: "Email send failed" });
    }

    // 5) Réponse OK
    return res.status(200).json({
      ok: true,
      email,
      profil: {
        code_4L: prof.code_4L,
        famille: prof.famille,
        type: prof.type
      },
      scores: prof.scores
    });

  } catch (e) {
    console.error("SERVER_ERROR", e);
    return res.status(500).json({ ok: false, error: "Server error", detail: e && e.message });
  }
};

// Force le runtime Node.js 18 pour cette fonction
module.exports.config = { runtime: 'nodejs18.x' };


