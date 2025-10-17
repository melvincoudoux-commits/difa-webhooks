export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method Not Allowed");
  }

  try {
    const body = req.body ?? {};

    // 1) Vérifs minimales
    const data = body?.data || {};
    if (!data?.consent_email) return res.status(202).send("No email consent");
    if (!data?.email) return res.status(400).send("Missing email");

    // 2) Construire l’input pour l’agent
    const agentInput = {
      event: body.event,
      submission_id: body.submissionId,
      user: { email: data.email, first_name: data.first_name || "" },
      scorecard: {
        profile_key: data.profile_key,
        raw: data.raw || {}
      }
    };

    // 3) Appel de l’agent OpenAI
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        agent_id: process.env.DIFA_AGENT_ID,
        input: [
          { role: "system", content: "Event: TPC-SDFA submission (from Tally.so)" },
          { role: "user", content: JSON.stringify(agentInput) }
        ]
      })
    });

    const dataResp = await r.json();
    if (!r.ok) {
      console.error("OpenAI error:", dataResp);
      return res.status(500).json({ ok: false, error: "OpenAI call failed", detail: dataResp });
    }

    // 4) Réponse à Tally
    return res.status(200).json({ ok: true, run: dataResp.id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
