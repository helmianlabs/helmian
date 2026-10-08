const file = "web/marketing/downloads/counts.json";
module.exports = async (req, res) => {
  const token = process.env.GITHUB_TOKEN;
  const which = (req.url || "").includes("guard") ? "guard" : "helmian";
  const base = "https://api.github.com/repos/helmianlabs/helmian/contents/" + file;
  const headers = { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" };
  const cur = await fetch(base, { headers }).then((r) => r.json());
  const counts = JSON.parse(Buffer.from(cur.content, "base64").toString("utf8"));
  if (req.method === "POST") {
    counts[which] += 1;
    await fetch(base, { method: "PUT", headers, body: JSON.stringify({ message: "count", content: Buffer.from(JSON.stringify(counts)).toString("base64"), sha: cur.sha }) });
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(counts));
};
