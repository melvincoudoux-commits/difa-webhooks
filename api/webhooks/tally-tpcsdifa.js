export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method Not Allowed");
  }

  // --- DEBUG : journaliser tout le payload pour l'inspecter dans Vercel
  try { console.log("TALLY RAW BODY:", JSON.stringify(req.body)); } catch {}

  try {
    const body = req.body ?? {};
    const data = body.data ?? {};

    // 1) Email : tester plusieurs clés possibles
    const email =
      data.email ||
      data["Email"] ||
      data["E-mail"] ||
      data["Adresse email"] ||
      data["Adresse e-mail"] ||
      body.user?.email ||
      body.email ||
      null;

    if (!email) {
      console.warn("DEBUG: Missing email | keys:", Object.keys(body), "dataKeys:", Object.keys(data));
      // on renvoie la raison pour que tu la voies même si les logs ne s'affichent pas
      return res.status(400).json({
        ok: false,
        error: "Missing email",
        topKeys: Object.keys(body),
        dataKeys: Object.keys(data)
      });
    }

    // ... (la suite inchangée : construction des 24 réponses, calcul, envoi email)
// api/webhooks/tally-tpcsdifa.js
//
// Webhook Tally → calcul TPCS-DIFA v3.1 (deterministic) → email par Famille (Alpha/Beta/Gamma/Delta)
// Entrée attendue: 24 réponses dans [-3, +3] sous `data.answers` avec clés "1".."24"

function scoreTPCS(respondent_id, answersObj) {
  // --- 0) Helpers
  const INV = new Set([2,4,6,8,10,12,14,16,18,20,22,24]); // items inversés
  const v = (i) => {
    const raw = Number(answersObj[String(i)]);
    if (!Number.isFinite(raw)) throw new Error(`Réponse manquante ou invalide pour l’item ${i}`);
    if (raw < -3 || raw > 3) throw new Error(`Item ${i} hors plage [-3,3]`);
    return INV.has(i) ? -raw : raw;
  };

  // --- 3) Scores dimensionnels (somme de 4 items)
  const D1 = v(1)+v(2)+v(3)+v(4);      // Attention  (E ↔ F)
  const D2 = v(5)+v(6)+v(7)+v(8);      // Récompense (A ↔ I)
  const D3 = v(9)+v(10)+v(11)+v(12);   // Émotion    (R ↔ E)
  const D4 = v(13)+v(14)+v(15)+v(16);  // Décision   (C ↔ D)
  const D5 = v(17)+v(18)+v(19)+v(20);  // Contexte
  const D6 = v(21)+v(22)+v(23)+v(24);  // Introspection ↔ Machinal (tie-break)

  const intensity = (s) => {
    const a = Math.abs(s);
    if (a === 0) return "none";
    if (a <= 2)  return "light";
    if (a <= 5)  return "moderate";
    if (a <= 8)  return "marked";
    return "very_marked";
  };
  const pole = (s, pos, neg) => (s>0 ? pos : (s<0 ? neg : "neutral"));

  // --- 4) Lettres FARC (avec F = Focalisé)
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

  // --- 5) Famille (D3×D4)
  const family =
    (L3 === "R" && L4 === "C") ? "Alpha" :
    (L3 === "R" && L4 === "D") ? "Beta"  :
    (L3 === "E" && L4 === "C") ? "Gamma" :
                                  "Delta";

  // --- 7) Qualité (cohérence miroirs + variabilité)
  const pairs = [[1,2],[3,4],[5,6],[7,8],[9,10],[11,12],[13,14],[15,16],[17,18],[19,20],[21,22],[23,24]];
  let diffSum = 0;
  for (const [d,i] of pairs) {
    const direct = Number(answersObj[String(d)]);
    const invraw = Number(answersObj[String(i)]);
    diffSum += Math.abs(direct - (-invraw));
  }
  const meanDiff = diffSum / pairs.length;
  const mirror_consistency = 1 - (meanDiff / 6);

  const vals = Array.from({length:24}, (_,k) => Number(answersObj[String(k+1)]));
  const m = vals.reduce((a,b)=>a+b,0) / vals.length;
  const stdev = Math.sqrt(vals.reduce((a,x)=>a + (x-m)**2, 0) / vals.length);

  const flags = [];
  if (mirror_consistency < 0.70) flags.push("low_consistency");
  if (stdev < 0.70)              flags.push("low_variability");
  if (Math.max(Math.abs(D1),Math.abs(D2),Math.abs(D3),Math.abs(D4),Math.abs(D5),Math.abs(D6)) > 10) flags.push("atypical_profile");
  if (!flags.length) flags.push("ok");

  // Niveau d’introspection (D6)
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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method Not Allowed");
  }

  try {
    // 0) Lire le payload Tally (quelques variantes possibles)
    const raw = req.body ?? {};
    const body = typeof raw === "string" ? JSON.parse(raw) : raw;
    const d = body.data || body;

    // On s'attend à d.answers = { "1": int, ..., "24": int } dans [-3,3]
    const answers = d.answers || d.raw || d; // tolérant si Tally envoie autrement
    const email = d.user?.email || d.email || "";
    const firstName = d.user?.first_name || d.first_name || "";

    if (!email) return res.status(400).json({ ok: false, error: "Missing email" });

    // 1) Calcul TPCS-DIFA déterministe
    const respondentId = d.respondent_id || d.submission_id || body.submissionId || "unknown";
    const result = scoreTPCS(respondentId, answers);

    // 2) Choisir le template par Famille (Alpha/Beta/Gamma/Delta)
    const TPL = {
      Alpha: {
        subject: `Ton profil DIFA — Famille Alpha (${result.code_4L})`,
        html: (v) => `
          <p>Salut ${v.first_name || "toi"},</p>
          <p>Ta <b>Famille</b> est <b>Alpha</b> (Émotion=R, Décision=C) — code <b>${result.code_4L}</b>.</p>
          <p><b>Plan express :</b> structure claire + rituels courts pour canaliser la réactivité constructive.</p>
          <p>Démarre ici 👉 <a href="${v.cta_url}">${v.cta_url}</a></p>
          <p style="font-size:12px;color:#666">Qualité: cohérence=${result.quality.mirror_consistency.toFixed(2)}; variabilité=${result.quality.response_variability.toFixed(2)}</p>
          <p>— Brain West</p>
        `
      },
      Beta: {
        subject: `Ton profil DIFA — Famille Beta (${result.code_4L})`,
        html: (v) => `
          <p>Salut ${v.first_name || "toi"},</p>
          <p>Ta <b>Famille</b> est <b>Beta</b> (Émotion=R, Décision=D) — code <b>${result.code_4L}</b>.</p>
          <p><b>Plan express :</b> micro-preuves rapides, décharges émotionnelles guidées, tempo court.</p>
          <p>Démarre ici 👉 <a href="${v.cta_url}">${v.cta_url}</a></p>
          <p style="font-size:12px;color:#666">Qualité: cohérence=${result.quality.mirror_consistency.toFixed(2)}; variabilité=${result.quality.response_variability.toFixed(2)}</p>
          <p>— Brain West</p>
        `
      },
      Gamma: {
        subject: `Ton profil DIFA — Famille Gamma (${result.code_4L})`,
        html: (v) => `
          <p>Salut ${v.first_name || "toi"},</p>
          <p>Ta <b>Famille</b> est <b>Gamma</b> (Émotion=E, Décision=C) — code <b>${result.code_4L}</b>.</p>
          <p><b>Plan express :</b> clarté + jalons mesurables, sécuriser la direction avant l’intensité.</p>
          <p>Démarre ici 👉 <a href="${v.cta_url}">${v.cta_url}</a></p>
          <p style="font-size:12px;color:#666">Qualité: cohérence=${result.quality.mirror_consistency.toFixed(2)}; variabilité=${result.quality.response_variability.toFixed(2)}</p>
          <p>— Brain West</p>
        `
      },
      Delta: {
        subject: `Ton profil DIFA — Famille Delta (${result.code_4L})`,
        html: (v) => `
          <p>Salut ${v.first_name || "toi"},</p>
          <p>Ta <b>Famille</b> est <b>Delta</b> (Émotion=E, Décision=D) — code <b>${result.code_4L}</b>.</p>
          <p><b>Plan express :</b> commencer par routines faciles, 2 micro-actions garanties/jour, pression minimale.</p>
          <p>Démarre ici 👉 <a href="${v.cta_url}">${v.cta_url}</a></p>
          <p style="font-size:12px;color:#666">Qualité: cohérence=${result.quality.mirror_consistency.toFixed(2)}; variabilité=${result.quality.response_variability.toFixed(2)}</p>
          <p>— Brain West</p>
        `
      }
    };

    const vars = {
      first_name: firstName,
      cta_url: "https://skool.difa/rituel" // ← mets ton vrai lien
    };
    const tpl = TPL[result.family] || TPL.Gamma; // fallback

    // 3) Appeler ta route d’envoi d’e-mail (déjà créée)
    const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://difa-webhooks.vercel.app";
    const send = await fetch(`${base}/api/actions/send-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: email,
        subject: tpl.subject,
        html: tpl.html(vars)
      })
    });

    if (!send.ok) {
      const err = await send.text();
      console.error("send-email failed:", err);
      return res.status(500).json({ ok: false, error: "Mailer failed", detail: err });
    }

    // 4) Réponse à Tally (log utile)
    return res.status(200).json({
      ok: true,
      sent_to: email,
      family: result.family,
      code_4L: result.code_4L,
      quality: result.quality
    });

  } catch (e) {
    console.error("Webhook error:", e);
    return res.status(500).json({ ok: false, error: "Server error", detail: e?.message });
  }
}
