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
// Envoi d'email minimal via Resend (si variables absentes -> on n'échoue pas)
async function sendEmail(to, subject, text) {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.FROM_EMAIL; // ex: "DIFA <startdifa@gmail.com>"
    if (!apiKey || !from) {
      console.warn("EMAIL DISABLED: missing RESEND_API_KEY or FROM_EMAIL – pretending success");
      return true; // ne bloque pas le flux pendant les tests
    }
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ from, to, subject, text })
    });
    if (!r.ok) {
      const t = await r.text();
      console.error("Resend error:", t);
      return false;
    }
    return true;
  } catch (e) {
    console.error("Resend exception:", e);
    return false;
  }
}

// ----------------------
// Calcul TPCS-DIFA (deterministic)
function scoreTPCS(respondent_id, answersObj) {
  const INV = new Set([2,4,6,8,10,12,14,16,18,20,22,24]);

  function v(i) {
    const raw = Number(answersObj[String(i)]);
    if (!Number.isFinite(raw)) throw new Error(`Réponse manquante ou invalide pour l’item ${i}`);
    if (raw < -3 || raw > 3) throw new Error(`Item ${i} hors plage [-3,3]`);
    return INV.has(i) ? -raw : raw;
  }

  const D1 = v(1)+v(2)+v(3)+v(4);
  const D2 = v(5)+v(6)+v(7)+v(8);
  const D3 = v(9)+v(10)+v(11)+v(12);
  const D4 = v(13)+v(14)+v(15)+v(16);
  const D5 = v(17)+v(18)+v(19)+v(20);
  const D6 = v(21)+v(22)+v(23)+v(24);

  const intensity = (s) => {
    const a = Math.abs(s);
    if (a === 0) return "none";
    if (a <= 2) return "light";
    if (a <= 5) return "moderate";
    if (a <= 8) return "marked";
    return "very_marked";
  };

  const pole = (s, pos, neg) => (s > 0 ? pos : (s < 0 ? neg : "neutral"));

  let L1 = pole(D1,"E","F");
  let L2 = pole(D2,"A","I");
  let L3 = pole(D3,"R","E");
  let L4 = pole(D4,"C","D");

  // Tie-break via D6 si neutral
  if (L1 === "neutral") L1 = (D6 > 0 ? "E" : "F");
  if (L2 === "neutral") L2 = (D6 > 0 ? "A" : "I");
  if (L3 === "neutral") L3 = (D6 > 0 ? "R" : "E");
  if (L4 === "neutral") L4 = (D6 > 0 ? "C" : "D");

  const code_4L = `${L1}${L2}${L3}${L4}`;

  const family =
    (L3 === "R" && L4 === "C") ? "Alpha" :
    (L3 === "R" && L4 === "D") ? "Beta"  :
    (L3 === "E" && L4 === "C") ? "Gamma" :
                                  "Delta";

  // Qualité (cohérence miroirs + variabilité)
  const pairs = [[1,2],[3,4],[5,6],[7,8],[9,10],[11,12],[13,14],[15,16],[17,18],[19,20],[21,22],[23,24]];
  let diffSum = 0;
  for (const [d,i] of pairs) {
    const direct = Number(answersObj[String(d)]);
    const invraw = Number(answersObj[String(i)]);
    diffSum += Math.abs(direct - (-invraw));
  }
  const meanDiff = diffSum / pairs.length;
  const mirror_consistency = 1 - (meanDiff / 6);

  const vals = Array.from({ length: 24 }, (_, k) => Number(answersObj[String(k + 1)]));
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  const stdev = Math.sqrt(vals.reduce((a, x) => a + (x - m) ** 2, 0) / vals.length);

  const flags = [];
  if (mirror_consistency < 0.70) flags.push("low_consistency");
  if (stdev < 0.70)              flags.push("low_variability");
  if (Math.max(Math.abs(D1),Math.abs(D2),Math.abs(D3),Math.abs(D4),Math.abs(D5),Math.abs(D6)) > 10) {
    flags.push("atypical_profile");
  }
  if (!flags.length) flags.push("ok");

  const introspection_level =
    (D6 >=  8) ? "hyper-introspective" :
    (D6 >=  4) ? "introspective" :
    (D6 >=  1) ? "slightly-introspective" :
    (D6 >= -3) ? "balanced" :
    (D6 >= -7) ? "mechanical" : "hyper-mechanical";

  return {
    respondent_id,
    scores: {
      D1_attention: { raw: D1, polarity: L1, intensity: intensity(D1) },
      D2_reward:    { raw: D2, polarity: L2, intensity: intensity(D2) },
      D3_emotion:   { raw: D3, polarity: L3, intensity: intensity(D3) },
      D4_decision:  { raw: D4, polarity: L4, intensity: intensity(D4) },
      D5_context:   { raw: D5 },
      D6_introspection: { raw: D6, level: introspection_level }
    },
    code_4L,
    family,
    quality: {
      mirror_consistency,
      response_variability: stdev,
      flags
    }
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

    // 1) Email – tester plusieurs clés fréquentes
    const email =
      data.email ||
      data["Email"] ||
      data["E-mail"] ||
      data["Adresse email"] ||
      data["Adresse e-mail"] ||
      (body.user && body.user.email) ||
      body.email ||
      null;

    if (!email) {
      console.warn("DEBUG: Missing email | topKeys:", Object.keys(body), "| dataKeys:", Object.keys(data));
      return res.status(400).json({
        ok: false,
        error: "Missing email",
        topKeys: Object.keys(body),
        dataKeys: Object.keys(data)
      });
    }

    // 2) Réponses – accepter différents formats
    // a) format tableau : body.answers = [{ key:"1", value:"Plutôt d'accord" }, ...]
    let answersObj = {};
    if (Array.isArray(body.answers)) {
      for (const it of body.answers) {
        if (!it) continue;
        answersObj[String(it.key)] = it.value;
      }
    }

    // b) format objet : data["1"]..["24"] ou "Q1".."Q24"
    if (Object.keys(answersObj).length === 0) {
      for (let i = 1; i <= 24; i++) {
        const kNum = String(i);
        const kQ = "Q" + i;
        if (kNum in data) answersObj[kNum] = data[kNum];
        else if (kQ in data) answersObj[kNum] = data[kQ];
      }
    }

    // c) certains formulaires Tally envoient "answers" comme objet
    if (Object.keys(answersObj).length === 0 && data.answers && typeof data.answers === "object") {
      for (let i = 1; i <= 24; i++) {
        const kNum = String(i);
        if (kNum in data.answers) answersObj[kNum] = data.answers[kNum];
      }
    }

    // 3) Mapping libellés Likert -> score [-3..+3]
    const MAP = {
      "-3": -3, "-2": -2, "-1": -1, "0": 0, "1": 1, "2": 2, "3": 3,
      "pas du tout d'accord": -3,
      "plutot pas d'accord": -1,
      "plutôt pas d'accord": -1,
      "neutre": 0,
      "plutot d'accord": 1,
      "plutôt d'accord": 1,
      "tout a fait d'accord": 3,
      "tout à fait d'accord": 3
    };

    function toScore(x) {
      if (x === null || x === undefined) return null;
      if (typeof x === "number") {
        if (x >= -3 && x <= 3) return x;
        return null;
      }
      const s = normalize(x);
      if (s in MAP) return MAP[s];
      const maybeNum = Number(s);
      if (Number.isFinite(maybeNum) && maybeNum >= -3 && maybeNum <= 3) return maybeNum;
      return null;
    }

    // 4) Construire { "1":int, ... "24":int }
    const answers = {};
    for (let i = 1; i <= 24; i++) {
      const raw = answersObj[String(i)];
      const sc = toScore(raw);
      if (sc === null) {
        console.warn("DEBUG: Invalid answer", i, "raw:", raw);
        return res.status(400).json({ ok: false, error: `Invalid answer #${i}`, raw });
      }
      answers[String(i)] = sc;
    }

    // 5) Calcul TPCS
    const respondentId = data.respondent_id || body.submissionId || body.submission_id || "unknown";
    const result = scoreTPCS(respondentId, answers);

    // 6) Email (plain text simple pour test – tu pourras remplacer par HTML)
    const subject = `Ton résultat TPCS-DIFA : ${result.family} (${result.code_4L})`;
    const text =
`Bonjour,

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
      console.error("EMAIL_SEND_FAILED for", email);
      return res.status(500).json({ ok: false, error: "Email send failed" });
    }

    // 7) Réponse OK
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
