// Extrai nome, foto e preço do HTML de uma página de produto.
const ent = (s) => String(s || "")
  .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));

function meta(html, names) {
  for (const n of names) {
    const k = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m =
      html.match(new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${k}["'][^>]*?content=["']([^"']*)["']`, "i")) ||
      html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*?(?:property|name|itemprop)=["']${k}["']`, "i"));
    if (m && m[1].trim()) return ent(m[1].trim());
  }
  return null;
}

function toPrice(v) {
  if (v == null) return null;
  let t = String(v).replace(/[^\d.,]/g, "");
  if (!t) return null;
  if (/,\d{1,2}$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");   // 1.234,56
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, "");      // 1.234
  else t = t.replace(/,/g, "");
  const n = parseFloat(t);
  return Number.isFinite(n) && n > 0 && n < 10_000_000 ? Math.round(n * 100) / 100 : null;
}

// procura um Product no JSON-LD
function jsonLd(html) {
  const out = {};
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  const visit = (o) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(visit);
    const type = [].concat(o["@type"] || []).join(" ");
    if (/Product/i.test(type)) {
      if (!out.nome && typeof o.name === "string") out.nome = o.name;
      if (!out.imagem) { const im = [].concat(o.image || [])[0]; out.imagem = typeof im === "string" ? im : im && im.url; }
      const of = [].concat(o.offers || [])[0];
      if (of && out.preco == null) out.preco = toPrice(of.price ?? of.lowPrice ?? (of.priceSpecification && of.priceSpecification.price));
    }
    if (o["@graph"]) visit(o["@graph"]);
  };
  while ((m = re.exec(html))) { try { visit(JSON.parse(m[1].trim())); } catch {} }
  return out;
}

function cleanTitle(t) {
  if (!t) return null;
  t = ent(t).replace(/\s+/g, " ").trim();
  // tira o nome da loja no fim: "Produto | Loja", "Produto - Loja"
  t = t.replace(/\s*[|–—]\s*[^|–—]{2,40}$/, "").replace(/\s+-\s+(Mercado ?Livre|Magazine Luiza|Magalu|Amazon(\.com\.br)?|Shopee( Brasil)?|Casas Bahia|Americanas|Leroy Merlin|Madeira ?Madeira|Mobly|Tok&Stok|Carrefour|Extra|Ponto|KaBuM!?|AliExpress|Shein)\b.*$/i, "");
  t = t.replace(/\s*\|\s*$/, "").trim();
  return t.slice(0, 120) || null;
}

function parsePreview(html, baseUrl) {
  const ld = jsonLd(html);
  const nome = cleanTitle(ld.nome || meta(html, ["og:title", "twitter:title"]) || (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
  let imagem = ld.imagem || meta(html, ["og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"]) ||
    (html.match(/"image"\s*:\s*\[?\s*"(https?:[^"]+)"/i) || [])[1] || null;
  if (imagem) { try { imagem = new URL(ent(imagem), baseUrl).toString(); } catch { imagem = null; } }
  const preco = ld.preco ?? toPrice(meta(html, ["product:price:amount", "og:price:amount", "price", "twitter:data1"])) ??
    toPrice((html.match(/"price"\s*:\s*"?(\d+(?:[.,]\d+)?)"?/i) || [])[1]);
  // página que só redireciona (links curtos)
  const refresh = (html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"'>\s]+)/i) || [])[1] ||
    (!nome && (html.match(/location(?:\.href)?\s*=\s*["'](https?:\/\/[^"']+)["']/i) || [])[1]) || null;
  return { nome, imagem, preco, refresh: refresh ? ent(refresh) : null };
}

module.exports = { parsePreview, toPrice, cleanTitle };
