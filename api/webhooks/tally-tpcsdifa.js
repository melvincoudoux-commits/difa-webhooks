// api/webhooks/tally-tpcsdifa.js
// CommonJS + Node 18 runtime

const nodemailer = require("nodemailer");

/* ---------------------- 1) CALCUL L/A/R/C ---------------------- */

function scoreTPCS_LARC_fromAnswers(answersObj) {
  // answersObj = { "1": int … "24": int } dans [-3..+3]
  const inv = new Set([2,4,6,8,10,12,14,16,18,20,22,24]);

  const v = (i) => {
    const raw = Number(answersObj[String(i)] ?? 0);
    if (!Number.isFinite(raw) || raw < -3 || raw > 3) {
      throw new Error(`Réponse invalide à l’item ${i} (valeur=${answersObj[String(i)]})`);
    }
    return inv.has(i) ? -raw : raw;
  };

  const D1 = v(1)+v(2)+v(3)+v(4);
  const D2 = v(5)+v(6)+v(7)+v(8);
  const D3 = v(9)+v(10)+v(11)+v(12);
  const D4 = v(13)+v(14)+v(15)+v(16);
  const D5 = v(17)+v(18)+v(19)+v(20);
  const D6 = v(21)+v(22)+v(23)+v(24);

  const pole = (s, pos, neg) => (s > 0 ? pos : (s < 0 ? neg : "neutral"));
  let L1 = pole(D1, "L", "F");
  let L2 = pole(D2, "A", "I");
  let L3 = pole(D3, "R", "E");
  let L4 = pole(D4, "C", "D");

  // Tie-break si neutral avec D6
  if (L1 === "neutral") L1 = (D6 > 0 ? "L" : "F");
  if (L2 === "neutral") L2 = (D6 > 0 ? "A" : "I");
  if (L3 === "neutral") L3 = (D6 > 0 ? "R" : "E");
  if (L4 === "neutral") L4 = (D6 > 0 ? "C" : "D");

  const code4 = `${L1}${L2}${L3}${L4}`;

  // Famille par D3×D4
  const family =
    (L3 === "R" && L4 === "C") ? "Alpha" :
    (L3 === "R" && L4 === "D") ? "Beta"  :
    (L3 === "E" && L4 === "C") ? "Gamma" :
    "Delta";

  // Intensité helpful
  const intensity = (s) => {
    const a = Math.abs(s);
    if (a === 0) return "none";
    if (a <= 2) return "light";
    if (a <= 5) return "moderate";
    if (a <= 8) return "marked";
    return "very_marked";
  };

  // QA miroirs
  const pairs = [[1,2],[3,4],[5,6],[7,8],[9,10],[11,12],[13,14],[15,16],[17,18],[19,20],[21,22],[23,24]];
  let diffSum = 0;
  for (const [d,i] of pairs) {
    const direct = Number(answersObj[String(d)]);
    const invv   = -Number(answersObj[String(i)]);
    diffSum += Math.abs(direct - invv);
  }
  const meanDiff = diffSum / pairs.length;
  const mirrorConsistency = 1 - (meanDiff/6);

  const vals = Array.from({length:24}, (_,k)=>Number(answersObj[String(k+1)]));
  const m = vals.reduce((a,b)=>a+b,0)/vals.length;
  const sd = Math.sqrt(vals.reduce((s,x)=>s+(x-m)*(x-m),0)/vals.length);

  const flags = [];
  if (mirrorConsistency < 0.70) flags.push("low_consistency");
  if (sd < 0.70)               flags.push("low_variability");
  if (Math.max(Math.abs(D1),Math.abs(D2),Math.abs(D3),Math.abs(D4),Math.abs(D5),Math.abs(D6)) > 10) {
    flags.push("atypical_profile");
  }
  if (flags.length === 0) flags.push("ok");

  return {
    code_4L: code4,
    family,
    scores: {
      D1_attention: { raw: D1, polarity: L1, intensity: intensity(D1) },
      D2_reward:    { raw: D2, polarity: L2, intensity: intensity(D2) },
      D3_emotion:   { raw: D3, polarity: L3, intensity: intensity(D3) },
      D4_decision:  { raw: D4, polarity: L4, intensity: intensity(D4) },
      D5_context:   { raw: D5 },
      D6_intro:     { raw: D6 }
    },
    quality: {
      mirror_consistency: mirrorConsistency,
      response_variability: sd,
      flags
    }
  };
}

/* ---------------------- 2) ENVOI EMAIL ---------------------- */

async function sendEmail(to, subject, text) {
  const FROM_EMAIL = process.env.FROM_EMAIL || process.env.EXPÉDITEUR_EMAIL || process.env.EXPEDITEUR_EMAIL;
  const SMTP_USER  = process.env.SMTP_USER  || process.env.DIFFA_GMAIL_USER || process.env.GMAIL_USER;
  const SMTP_PASS  = process.env.SMTP_PASS  || process.env.DIFFA_GMAIL_PASS || process.env.GMAIL_PASS;

  if (!SMTP_USER || !SMTP_PASS || !FROM_EMAIL) {
    console.error("EMAIL DESACTIVE : SMTP_USER ou SMTP_PASS ou FROM_EMAIL manquant");
    return false;
  }

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  await transporter.sendMail({
    from: FROM_EMAIL,
    to,
    subject,
    text
  });

  console.log("GMAIL ENVOYE :", to);
  return true;
}

/* ---------------------- 3) HANDLER HTTP ---------------------- */

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method Not Allowed");
  }

  try { console.log("TALLY RAW BODY:", JSON.stringify(req.body)); } catch {}

  try {
    const body = req.body || {};
    const data = body.data || {};
    const fields = Array.isArray(data.fields) ? data.fields : [];

    // email
    let email = null;
    for (const f of fields) {
      const lbl = (f.label || "").toString();
      if (f.type === "INPUT_EMAIL" || /mail/i.test(lbl)) { email = f.value; break; }
    }
    if (!email) {
      console.warn("DEBUG: Missing email in fields[]");
      return res.status(400).json({ ok: false, error: "Missing email (fields)" });
    }

    // prénom (optionnel)
    const firstNameField = fields.find(f => f.type === "INPUT_TEXT" && /pr[ée]nom/i.test(f.label || ""));
    const firstName = firstNameField?.value || "";

    // 24 échelles : accepter EN & FR
    const isScale = (t) => t === "LINEAR_SCALE" || t === "ÉCHELLE_LINÉAIRE";
    const scaleItems = fields.filter(f => isScale(f.type));
    if (scaleItems.length < 24) {
      console.warn("DEBUG: Not enough scale items:", scaleItems.length);
      return res.status(400).json({ ok: false, error: `Need 24 scale items, got ${scaleItems.length}` });
    }

    const answers = {};
    for (let i = 0; i < 24; i++) {
      const raw = Number(scaleItems[i].value);
      if (!Number.isFinite(raw) || raw < -3 || raw > 3) {
        return res.status(400).json({ ok: false, error: `Invalid scale value at #${i+1}`, raw: scaleItems[i].value });
      }
      answers[String(i+1)] = raw;
    }

    // calcul L/A/R/C
    const result = scoreTPCS_LARC_fromAnswers(answers);
    console.log("TPCS LARC RESULT:", result);

    // email simple (tu pourras remplacer par HTML)
    const subject = `Ton résultat TPCS-DIFA : ${result.family} (${result.code_4L})`;
    const text =
`Bonjour ${firstName || ""},

Merci d'avoir passé le test TPCS-DIFA.
Famille : ${result.family}
Code 4L : ${result.code_4L}

Qualité:
- Cohérence miroirs: ${result.quality.mirror_consistency.toFixed(2)}
- Variabilité réponses: ${result.quality.response_variability.toFixed(2)}
Flags: ${result.quality.flags.join(", ")}

À bientôt,
L'équipe DIFA`;

    const ok = await sendEmail(email, subject, text);
    if (!ok) {
      return res.status(500).json({ ok: false, error: "Email send failed" });
    }

    return res.status(200).json({
      ok: true,
      email,
      family: result.family,
      code_4L: result.code_4L,
      quality: result.quality
    });

  } catch (e) {
    console.error("SERVER_ERROR", e);
    return res.status(500).json({ ok: false, error: "Server error", detail: e && e.message });
  }
};

// Force le runtime Node.js 18 pour cette fonction
module.exports.config = { runtime: "nodejs18.x" };


